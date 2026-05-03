import * as vscode from 'vscode';
import { AuthService } from './auth/AuthService.js';
import { readCliConfig } from './auth/cliConfig.js';
import { VibeFlowClient } from './api/client.js';
import { SessionsTreeProvider } from './views/sessions/SessionsTreeProvider.js';
import { WorkItemsTreeProvider } from './views/workItems/WorkItemsTreeProvider.js';
import { ActivityFeedProvider } from './views/activity/ActivityFeedProvider.js';
import { DocumentsTreeProvider } from './views/documents/DocumentsTreeProvider.js';
import {
  createSessionStatusBar, createWorkSummaryStatusBar,
  type StatusBarItemWithUpdate, type WorkSummaryBarItem,
} from './statusBar/sessionStatus.js';
import { ProjectDetector, type DetectedProject } from './project/ProjectDetector.js';
import { PromptNotifier } from './notifications/PromptNotifier.js';
import { registerChatParticipant } from './chat/participant.js';
import { launchSession, killSession, restartSession, focusTerminal } from './commands/sessionCommands.js';
import { TerminalRegistry } from './sessions/TerminalRegistry.js';
import { SessionReattacher } from './sessions/SessionReattacher.js';
import { StickyModels } from './sessions/stickyModels.js';
import { createWorkItem, changeStatus } from './commands/workItemCommands.js';
import { qaVerify, qaReject, securityApprove, securityReject, checkBranchReviewStatus } from './commands/governanceCommands.js';
import { createPR, openDocumentViewer } from './commands/prCommands.js';
import { manageWorktrees } from './commands/worktreeCommands.js';
import { SettingsPanel } from './views/settings/SettingsPanel.js';
import { DashboardPanel } from './views/dashboard/DashboardPanel.js';
import { KanbanPanel } from './views/kanban/KanbanPanel.js';
import { AgentFileDecorationProvider } from './views/decorations/AgentFileDecorationProvider.js';
import { SessionPanelManager } from './views/sessions/SessionPanelManager.js';
import { WorkItemPanelManager } from './views/workItems/WorkItemPanelManager.js';
import { ActivityPoller } from './views/activity/ActivityPoller.js';
import { generateBatch, generateOne } from './views/activity/simulateActivity.js';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // --- Core services ---
  const authService = new AuthService(context.secrets);
  const detector = new ProjectDetector(context.globalState);
  const promptNotifier = new PromptNotifier();

  // --- Status bar (created early so it reflects state immediately) ---
  const sessionStatusBar = createSessionStatusBar(authService, promptNotifier) as StatusBarItemWithUpdate;
  const workSummaryStatusBar = createWorkSummaryStatusBar() as WorkSummaryBarItem;

  // --- API Client (needs auth) ---
  const client = new VibeFlowClient(authService);

  // --- TreeView data providers ---
  const sessionsProvider = new SessionsTreeProvider();
  const workItemsProvider = new WorkItemsTreeProvider();
  const activityFeedProvider = new ActivityFeedProvider(context.extensionUri, promptNotifier);
  const documentsProvider = new DocumentsTreeProvider();

  // --- File Decorations ---
  const fileDecorationProvider = new AgentFileDecorationProvider();
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(fileDecorationProvider),
    fileDecorationProvider,
  );

  // --- Terminal Registry + Sticky Models ---
  const terminalRegistry = new TerminalRegistry();
  const stickyModels = new StickyModels(context.globalState);
  context.subscriptions.push(terminalRegistry);

  // --- Focus Panels ---
  const sessionPanelManager = new SessionPanelManager(context.extensionUri, client);
  const workItemPanelManager = new WorkItemPanelManager(context.extensionUri, client, workItemsProvider);

  // --- Activity poller (started when connected) ---
  let activityPoller: ActivityPoller | undefined;

  // =============================================
  // CONNECTION LIFECYCLE
  // =============================================

  /**
   * Connect all views to a detected project.
   * Called after successful setup or on activation with stored credentials.
   */
  function connectToProject(project: DetectedProject) {
    sessionsProvider.connect(client, project.projectId);
    workItemsProvider.connect(client, project.projectId);
    documentsProvider.connect(client, project.projectId);

    // Wire the response path so PromptNotifier.collectAndSendResponse
    // actually hits the backend instead of silently no-op'ing. Project id
    // is captured here so the handler doesn't need it threaded through.
    promptNotifier.setRespondHandler((promptId, response) =>
      client.respondToPrompt(project.projectId, promptId, response),
    );

    // Session focus panels need projectId for log correlation and
    // user-to-agent prompts.
    sessionPanelManager.setProjectId(project.projectId);
    // Work-item panels need projectId for compliance findings lookup.
    workItemPanelManager.setProjectId(project.projectId);

    // Start real Activity Feed polling (stop any previous)
    activityPoller?.stop();
    activityPoller = new ActivityPoller(
      client,
      activityFeedProvider,
      promptNotifier,
      project.projectId,
      fileDecorationProvider,
    );
    activityPoller.start();

    // Update status bars
    sessionStatusBar.updateProject(project);
    workSummaryStatusBar.updateCounts(0, 0); // Will be updated by polling
  }

  /**
   * Disconnect all views (on logout or error).
   */
  function disconnect() {
    activityPoller?.stop();
    activityPoller = undefined;
    sessionStatusBar.updateProject(undefined);
    workSummaryStatusBar.setDisconnected();
    // TreeViews will show placeholder/empty state on next refresh
  }

  /**
   * Try to detect project using stored credentials.
   * Called on activation and after login.
   */
  async function tryAutoConnect(): Promise<DetectedProject | undefined> {
    console.log('[VibeFlow] tryAutoConnect: authState=', authService.getState());
    if (!client.isAuthenticated()) {
      console.log('[VibeFlow] tryAutoConnect: not authenticated, skipping');
      return undefined;
    }

    // Check cache first
    const cached = detector.getCachedProject();
    console.log('[VibeFlow] tryAutoConnect: cached=', cached);
    if (cached) {
      const branch = await detector.getGitBranch();
      const project = { ...cached, gitBranch: branch };
      console.log('[VibeFlow] tryAutoConnect: connecting to', project.projectName);
      connectToProject(project);
      return project;
    }

    // Try silent auto-match from git remote — no prompts
    try {
      const remoteUrl = await detector.getGitRemoteUrl();
      if (!remoteUrl) { return undefined; }

      const projects = await client.listProjects();
      const matched = projects.find(p => p.git_remote_url === remoteUrl);
      if (matched) {
        const branch = await detector.getGitBranch();
        const project: DetectedProject = {
          projectId: matched.id,
          projectName: matched.name,
          gitRemoteUrl: remoteUrl,
          gitBranch: branch,
        };
        await detector.cacheProject(project);
        connectToProject(project);
        return project;
      }
    } catch {
      // Silent failure — user can run Setup manually
    }

    return undefined;
  }

  /**
   * The Setup command — 3-step wizard: Server URL → API Key → Select Project.
   */
  async function runSetup() {
    // Step 1: Server URL
    const config = vscode.workspace.getConfiguration('vibeflow');
    const currentUrl = config.get<string>('serverUrl', 'https://cloud.axiomstudio.ai');

    const serverUrl = await vscode.window.showInputBox({
      prompt: 'VibeFlow Server URL',
      value: currentUrl,
      title: 'VibeFlow Setup (1/3)',
      ignoreFocusOut: true,
    });
    if (serverUrl === undefined) { return; }

    if (serverUrl !== currentUrl) {
      await config.update('serverUrl', serverUrl, vscode.ConfigurationTarget.Global);
    }

    // Validate server reachability — any HTTP response means server is up.
    // Matches CLI behavior: only fail on network errors, not status codes.
    try {
      await fetch(`${serverUrl}/rest/v1/vibeflow/projects`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000),
      });
      // Any response (200, 401, 404) = server is reachable
    } catch {
      const proceed = await vscode.window.showWarningMessage(
        `VibeFlow: Could not reach ${serverUrl}. Continue anyway?`,
        'Continue', 'Cancel',
      );
      if (proceed !== 'Continue') { return; }
    }

    // Step 2: API Key
    const apiKey = await vscode.window.showInputBox({
      prompt: 'Paste your VibeFlow API key (from Account > API Keys)',
      placeHolder: 'your-api-key',
      password: true,
      title: 'VibeFlow Setup (2/3)',
      ignoreFocusOut: true,
    });
    if (!apiKey) { return; }

    // Validate by fetching projects
    await authService.setToken(apiKey);

    let projects: { id: number; name: string; git_remote_url?: string }[];
    try {
      projects = await client.listProjects();
    } catch (err) {
      await authService.logout();
      vscode.window.showErrorMessage(`VibeFlow: Invalid API key — ${err}`);
      return;
    }

    if (projects.length === 0) {
      vscode.window.showWarningMessage('VibeFlow: No projects found. Create one in the VibeFlow web UI first.');
      return;
    }

    vscode.window.showInformationMessage(`VibeFlow: Logged in — found ${projects.length} project(s)`);

    // Step 3: Select Project — try auto-match first
    const remoteUrl = await detector.getGitRemoteUrl();
    const autoMatch = remoteUrl
      ? projects.find(p => p.git_remote_url === remoteUrl)
      : undefined;

    let selectedProject: { id: number; name: string } | undefined;

    if (autoMatch) {
      const confirm = await vscode.window.showQuickPick(
        [
          { label: `$(check) ${autoMatch.name}`, description: 'Matched from git remote', value: 'accept' as const },
          { label: '$(list-flat) Choose different project...', description: '', value: 'pick' as const },
        ],
        { placeHolder: `Detected project "${autoMatch.name}" from git remote`, title: 'VibeFlow Setup (3/3)' },
      );
      if (!confirm) { return; }
      selectedProject = confirm.value === 'accept' ? autoMatch : await pickProject(projects);
    } else {
      selectedProject = await pickProject(projects);
    }

    if (!selectedProject) { return; }

    // Cache and connect
    const gitBranch = await detector.getGitBranch();
    const detected: DetectedProject = {
      projectId: selectedProject.id,
      projectName: selectedProject.name,
      gitRemoteUrl: remoteUrl ?? '',
      gitBranch,
    };
    await detector.cacheProject(detected);
    connectToProject(detected);

    vscode.window.showInformationMessage(`VibeFlow: Connected to "${selectedProject.name}"`);
  }

  async function pickProject(projects: { id: number; name: string }[]): Promise<{ id: number; name: string } | undefined> {
    const items = [
      ...projects.map(p => ({ label: p.name, description: `ID: ${p.id}`, project: p as { id: number; name: string } | undefined })),
      { label: '$(add) Create New Project', description: '', project: undefined as { id: number; name: string } | undefined },
    ];

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a VibeFlow project',
      title: 'VibeFlow Setup (3/3)',
    });

    if (!picked) { return undefined; }

    if (picked.project) {
      return picked.project;
    }

    // Create new project
    const name = await vscode.window.showInputBox({
      prompt: 'New project name',
      placeHolder: 'my-project',
      ignoreFocusOut: true,
    });
    if (!name) { return undefined; }

    try {
      await client.createProject(name);
      // Re-fetch to get the created project with its ID
      const refreshed = await client.listProjects();
      const created = refreshed.find(p => p.name === name);
      if (created) {
        vscode.window.showInformationMessage(`VibeFlow: Project "${name}" created`);
        return { id: created.id, name: created.name };
      }
    } catch (err) {
      vscode.window.showErrorMessage(`VibeFlow: Failed to create project — ${err}`);
    }
    return undefined;
  }

  // --- React to auth state changes ---
  authService.onDidChangeState(state => {
    if (state === 'unauthenticated') {
      disconnect();
    }
  });

  // =============================================
  // REGISTER VIEWS
  // =============================================

  const sessionsView = vscode.window.createTreeView('vibeflow.agentFleet', {
    treeDataProvider: sessionsProvider,
    showCollapseAll: true,
  });

  const workItemsView = vscode.window.createTreeView('vibeflow.workItems', {
    treeDataProvider: workItemsProvider,
    showCollapseAll: true,
  });

  const documentsView = vscode.window.createTreeView('vibeflow.documents', {
    treeDataProvider: documentsProvider,
    showCollapseAll: true,
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('vibeflow.activityFeed', activityFeedProvider),
  );

  // =============================================
  // REGISTER COMMANDS
  // =============================================

  context.subscriptions.push(
    vscode.commands.registerCommand('vibeflow.setup', () => runSetup()),
    vscode.commands.registerCommand('vibeflow.login', () => runSetup()), // Alias
    vscode.commands.registerCommand('vibeflow.logout', async () => {
      await client.disconnectMcp();
      await authService.logout();
      await detector.clearCache();
      disconnect();
      vscode.window.showInformationMessage('VibeFlow: Logged out');
    }),
    vscode.commands.registerCommand('vibeflow.launchSession', () => {
      launchSession(client, detector, sessionsProvider, context.extensionUri, terminalRegistry, stickyModels);
    }),
    vscode.commands.registerCommand('vibeflow.focusTerminal', (idOrNode: string | { id?: string }) => {
      const id = typeof idOrNode === 'string' ? idOrNode : idOrNode?.id;
      const session = id ? sessionsProvider.getSessionById(id) : undefined;
      if (session) { focusTerminal(terminalRegistry, session); }
    }),
    vscode.commands.registerCommand('vibeflow.killSession', (idOrNode: string | { id?: string }) => {
      const id = typeof idOrNode === 'string' ? idOrNode : idOrNode?.id;
      const session = id ? sessionsProvider.getSessionById(id) : undefined;
      if (session) { killSession(client, session, sessionsProvider); }
    }),
    vscode.commands.registerCommand('vibeflow.restartSession', (idOrNode: string | { id?: string }) => {
      const id = typeof idOrNode === 'string' ? idOrNode : idOrNode?.id;
      const session = id ? sessionsProvider.getSessionById(id) : undefined;
      if (session) { restartSession(client, session, detector, sessionsProvider); }
    }),
    vscode.commands.registerCommand('vibeflow.openSessionPanel', (idOrNode: string | { id?: string }) => {
      const id = typeof idOrNode === 'string' ? idOrNode : idOrNode?.id;
      const session = id ? sessionsProvider.getSessionById(id) : undefined;
      if (session) { sessionPanelManager.open(session); }
      else { vscode.window.showInformationMessage('VibeFlow: Session not found — it may have expired'); }
    }),
    vscode.commands.registerCommand('vibeflow.createWorkItem', () => {
      createWorkItem(client, detector, workItemsProvider);
    }),
    vscode.commands.registerCommand('vibeflow.openWorkItemPanel', (nodeId: string, label?: string, description?: string) => {
      // nodeId is e.g., "todo-1234" or "issue-567" — passed as a plain string
      const idMatch = (nodeId ?? '').match(/^(todo|issue)-(\d+)$/);
      if (idMatch) {
        workItemPanelManager.open({
          type: idMatch[1] as 'todo' | 'issue',
          id: parseInt(idMatch[2]),
          title: (label ?? '').replace(/^#\d+:\s*/, ''),
          status: description ?? '',
          priority: 'medium',
        });
      }
    }),
    vscode.commands.registerCommand('vibeflow.changeStatus', (itemType: string, itemId: number, currentStatus: string) => {
      changeStatus(client, itemType as 'todo' | 'issue', itemId, currentStatus, workItemsProvider);
    }),
    vscode.commands.registerCommand('vibeflow.viewSessions', () => {
      vscode.commands.executeCommand('vibeflow.agentFleet.focus');
    }),
    vscode.commands.registerCommand('vibeflow.respondToPrompt', () => {
      promptNotifier.showPendingPromptsQuickPick();
    }),
    vscode.commands.registerCommand('vibeflow.qaVerify', (_type: string, _id: number) => {
      qaVerify(client, _type as 'todo' | 'issue', _id, workItemsProvider);
    }),
    vscode.commands.registerCommand('vibeflow.qaReject', (_type: string, _id: number) => {
      qaReject(client, _type as 'todo' | 'issue', _id, workItemsProvider);
    }),
    vscode.commands.registerCommand('vibeflow.securityApprove', (_type: string, _id: number) => {
      securityApprove(client, _type as 'todo' | 'issue', _id, workItemsProvider);
    }),
    vscode.commands.registerCommand('vibeflow.securityReject', (_type: string, _id: number) => {
      securityReject(client, _type as 'todo' | 'issue', _id, workItemsProvider);
    }),
    vscode.commands.registerCommand('vibeflow.checkBranchStatus', () => {
      checkBranchReviewStatus(client, detector);
    }),
    vscode.commands.registerCommand('vibeflow.createPR', () => {
      createPR(client, detector);
    }),
    vscode.commands.registerCommand('vibeflow.openDocumentViewer', (docId: number, docTitle: string) => {
      openDocumentViewer(client, detector, context.extensionUri, docId, docTitle);
    }),
    vscode.commands.registerCommand('vibeflow.openSettings', () => {
      SettingsPanel.open(context.extensionUri, {
        authService,
        client,
        detector,
        onProjectSwitched: connectToProject,
      });
    }),
    vscode.commands.registerCommand('vibeflow.openDashboard', () => {
      const project = detector.getCachedProject();
      if (!project) {
        vscode.window.showErrorMessage(
          'VibeFlow: No project detected. Run "VibeFlow: Setup" first.',
        );
        return;
      }
      if (!client.isAuthenticated()) {
        vscode.window.showErrorMessage(
          'VibeFlow: Not logged in. Run "VibeFlow: Setup" first.',
        );
        return;
      }
      // The cached project may have a stale gitBranch (set during cacheProject
      // before any branch switch); refresh it so dashboard branch metrics
      // reflect the current checkout.
      detector.getGitBranch().then(branch => {
        DashboardPanel.open(
          context.extensionUri,
          client,
          { ...project, gitBranch: branch || project.gitBranch },
          terminalRegistry,
        );
      });
    }),
    vscode.commands.registerCommand('vibeflow.openKanban', () => {
      const project = detector.getCachedProject();
      if (!project) {
        vscode.window.showErrorMessage(
          'VibeFlow: No project detected. Run "VibeFlow: Setup" first.',
        );
        return;
      }
      if (!client.isAuthenticated()) {
        vscode.window.showErrorMessage(
          'VibeFlow: Not logged in. Run "VibeFlow: Setup" first.',
        );
        return;
      }
      KanbanPanel.open(context.extensionUri, client, project.projectId, project.projectName);
    }),
    vscode.commands.registerCommand('vibeflow.manageWorktrees', () => {
      manageWorktrees();
    }),
    vscode.commands.registerCommand('vibeflow.refresh', () => {
      sessionsProvider.refresh();
      workItemsProvider.refresh();
      documentsProvider.refresh();
    }),
  );

  // =============================================
  // DISPOSABLES
  // =============================================

  context.subscriptions.push(
    authService,
    promptNotifier,
    sessionsProvider,
    workItemsProvider,
    documentsProvider,
    sessionPanelManager,
    workItemPanelManager,
    sessionsView,
    workItemsView,
    documentsView,
    sessionStatusBar,
    workSummaryStatusBar,
    { dispose: () => activityPoller?.stop() },
  );

  // --- @vibeflow Chat Participant ---
  registerChatParticipant(context, client, detector);

  // --- MCP Server Definition Provider ---
  // Registers VibeFlow's MCP server so Copilot Agent Mode, Continue.dev, Cody
  // and any other AI tool in VSCode can use all 72 VibeFlow tools natively.
  // Uses dynamic access since the API may not exist in older VSCode versions.
  try {
    const lm = vscode.lm as Record<string, unknown>;
    const registerFn = lm?.registerMcpServerDefinitionProvider as
      | ((name: string, provider: { provideMcpServerDefinitions: () => unknown[] }) => vscode.Disposable)
      | undefined;
    const McpDef = (vscode as Record<string, unknown>).McpHttpServerDefinition as
      | (new (name: string, label: string, uri: vscode.Uri, headers: Record<string, string>) => unknown)
      | undefined;

    if (registerFn && McpDef) {
      const mcpProvider = registerFn('vibeflow', {
        provideMcpServerDefinitions() {
          const token = authService.getToken();
          const serverUrl = vscode.workspace.getConfiguration('vibeflow')
            .get<string>('serverUrl', 'https://cloud.axiomstudio.ai');
          if (!token || !serverUrl) { return []; }
          return [new McpDef(
            'vibeflow',
            'VibeFlow Project Management',
            vscode.Uri.parse(`${serverUrl}/rest/v1/vibeflow/mcp`),
            { 'Authorization': `Bearer ${token}` },
          )];
        },
      });
      context.subscriptions.push(mcpProvider);
      console.log('[VibeFlow] MCP Server Definition Provider registered');
    }
  } catch {
    // MCP provider API not available in this VSCode version — not critical
  }

  // =============================================
  // ACTIVATION: try auto-connect with stored credentials
  // =============================================

  // --- Dev mode: add workspace folder in-place (doesn't reload window) ---
  // Uses updateWorkspaceFolders to add a folder to the current workspace without
  // closing/reopening. The extension stays active. Only runs in dev mode.
  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    const devFolder = vscode.workspace.getConfiguration('vibeflow').get<string>('devMode.workspaceFolder');
    if (devFolder) {
      try {
        const uri = vscode.Uri.file(devFolder);
        vscode.workspace.updateWorkspaceFolders(0, 0, { uri, name: 'vscode-vibeflow' });
        console.log('[VibeFlow] Added dev workspace folder:', devFolder);
      } catch (err) {
        console.log('[VibeFlow] Failed to add workspace folder:', err);
      }
    }
  }

  await authService.initialize();

  // Import credentials/project from vibeflow-cli config
  const cliConfig = readCliConfig();
  console.log('[VibeFlow] CLI config:', cliConfig ? `found (project=${cliConfig.defaultProject}, hasToken=${!!cliConfig.apiToken})` : 'not found');
  console.log('[VibeFlow] Auth state on activation:', authService.getState());
  console.log('[VibeFlow] Cached project on activation:', detector.getCachedProject());

  // Step 1: Ensure we have a token (force-import from CLI if not already set)
  if (authService.getState() === 'unauthenticated' && cliConfig?.apiToken) {
    console.log('[VibeFlow] Importing token from CLI config');
    await authService.setToken(cliConfig.apiToken);
  }

  // Step 2: Always sync project from CLI config if present (overrides stale cache)
  if (authService.getState() === 'authenticated' && cliConfig?.defaultProject) {
    if (cliConfig.serverUrl) {
      const config = vscode.workspace.getConfiguration('vibeflow');
      await config.update('serverUrl', cliConfig.serverUrl, vscode.ConfigurationTarget.Global);
    }
    const cached = detector.getCachedProject();
    if (!cached || cached.projectName !== cliConfig.defaultProject) {
      console.log('[VibeFlow] Fetching projects to find CLI default:', cliConfig.defaultProject);
      try {
        const projects = await client.listProjects();
        console.log('[VibeFlow] Got projects:', projects.length);
        const matched = projects.find(p => p.name === cliConfig.defaultProject);
        if (matched) {
          console.log('[VibeFlow] Caching CLI default project:', matched.name, 'id:', matched.id);
          await detector.cacheProject({
            projectId: matched.id,
            projectName: matched.name,
            gitRemoteUrl: matched.git_remote_url ?? '',
            gitBranch: 'main',
          });
        } else {
          console.log('[VibeFlow] CLI default project not found in API list:', cliConfig.defaultProject);
        }
      } catch (err) {
        console.log('[VibeFlow] Failed to fetch projects for CLI import:', err);
      }
    } else {
      console.log('[VibeFlow] Cached project already matches CLI default, skipping');
    }
  }

  await tryAutoConnect();

  // --- Session Reattachment ---
  // Detect .vibeflow-session-* files from a previous VSCode window
  // and offer to reattach terminals for them.
  const cachedProject = detector.getCachedProject();
  if (cachedProject) {
    const gitBranch = await detector.getGitBranch();
    const phantoms = await SessionReattacher.detectPhantoms(terminalRegistry, gitBranch);
    if (phantoms.length > 0) {
      const serverUrl = vscode.workspace.getConfiguration('vibeflow')
        .get<string>('serverUrl', 'https://cloud.axiomstudio.ai');
      // Default provider from settings; user can override at reattach time
      const defaultProvider = vscode.workspace.getConfiguration('vibeflow')
        .get<string>('defaultProvider', 'claude');
      // Use vibeflow mode by default for reattachment (agent was running before)
      SessionReattacher.promptReattach(
        phantoms,
        terminalRegistry,
        defaultProvider,
        'vibeflow',
        gitBranch,
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
        serverUrl,
        cachedProject.projectName,
      ).then(() => sessionsProvider.refresh());
    }
  }

  // --- Activity Feed simulation (debug mode) ---
  // Fills the Activity Feed with dummy data so the UI is testable without real sessions.
  // Default OFF (matches package.json contributes.configuration default and Phase 4 PRD
  // exit criterion that real builds ship without simulated data). Opt in via setting:
  // vibeflow.debug.simulateActivity = true
  const debugConfig = vscode.workspace.getConfiguration('vibeflow');
  if (debugConfig.get<boolean>('debug.simulateActivity', false)) {
    activityFeedProvider.pushEntries(generateBatch(500));
    const simTimer = setInterval(() => {
      activityFeedProvider.pushEntry(generateOne());
    }, 3000);
    context.subscriptions.push({ dispose: () => clearInterval(simTimer) });
  }
}

export function deactivate(): void {
  // Cleanup handled by disposables
}
