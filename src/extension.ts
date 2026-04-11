import * as vscode from 'vscode';
import { AuthService } from './auth/AuthService.js';
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
import { launchSession, killSession, restartSession } from './commands/sessionCommands.js';
import { createWorkItem, changeStatus } from './commands/workItemCommands.js';
import { qaVerify, qaReject, securityApprove, securityReject, checkBranchReviewStatus } from './commands/governanceCommands.js';
import { createPR, openDocumentViewer } from './commands/prCommands.js';
import { SessionPanelManager } from './views/sessions/SessionPanelManager.js';
import { WorkItemPanelManager } from './views/workItems/WorkItemPanelManager.js';
import { ActivityPoller } from './views/activity/ActivityPoller.js';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // --- Core services ---
  const authService = new AuthService(context.secrets);
  const detector = new ProjectDetector(context.workspaceState);
  const promptNotifier = new PromptNotifier();

  // --- Status bar (created early so it reflects state immediately) ---
  const sessionStatusBar = createSessionStatusBar(authService, promptNotifier) as StatusBarItemWithUpdate;
  const workSummaryStatusBar = createWorkSummaryStatusBar() as WorkSummaryBarItem;

  // --- API Client (needs auth) ---
  const client = new VibeFlowClient(authService);

  // --- TreeView data providers ---
  const sessionsProvider = new SessionsTreeProvider();
  const workItemsProvider = new WorkItemsTreeProvider();
  const activityFeedProvider = new ActivityFeedProvider(context.extensionUri);
  const documentsProvider = new DocumentsTreeProvider();

  // --- Focus Panels ---
  const sessionPanelManager = new SessionPanelManager(context.extensionUri, client);
  const workItemPanelManager = new WorkItemPanelManager(context.extensionUri, client);

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

    // Start real Activity Feed polling (stop any previous)
    activityPoller?.stop();
    activityPoller = new ActivityPoller(client, activityFeedProvider, promptNotifier, project.projectId);
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
    if (!client.isAuthenticated()) {
      return undefined;
    }

    try {
      const project = await detector.detect(
        async (remoteUrl) => {
          const projects = await client.listProjects();
          return projects.find(p => p.gitRemoteUrl === remoteUrl);
        },
        async () => client.listProjects(),
      );

      if (project) {
        connectToProject(project);
        return project;
      }
    } catch {
      // Token might be invalid
      sessionStatusBar.setError('Could not connect — API key may be invalid');
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

    let projects: { id: number; name: string; gitRemoteUrl?: string }[];
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
      ? projects.find(p => p.gitRemoteUrl === remoteUrl)
      : undefined;

    let selectedProject: { id: number; name: string };

    if (autoMatch) {
      // Auto-matched — confirm
      const confirm = await vscode.window.showQuickPick(
        [
          { label: `$(check) ${autoMatch.name}`, description: 'Matched from git remote', project: autoMatch },
          { label: '$(list-flat) Choose different project...', description: '', project: undefined as unknown as typeof autoMatch },
        ],
        { placeHolder: `Detected project "${autoMatch.name}" from git remote`, title: 'VibeFlow Setup (3/3)' },
      );
      if (!confirm) { return; }
      selectedProject = confirm.project ?? await pickProject(projects);
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

  async function pickProject(projects: { id: number; name: string }[]): Promise<{ id: number; name: string }> {
    const picked = await vscode.window.showQuickPick(
      projects.map(p => ({ label: p.name, description: `ID: ${p.id}`, project: p })),
      { placeHolder: 'Select a VibeFlow project', title: 'VibeFlow Setup (3/3)' },
    );
    return picked?.project as { id: number; name: string };
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
      await authService.logout();
      await detector.clearCache();
      disconnect();
      vscode.window.showInformationMessage('VibeFlow: Logged out');
    }),
    vscode.commands.registerCommand('vibeflow.launchSession', () => {
      launchSession(client, detector, sessionsProvider);
    }),
    vscode.commands.registerCommand('vibeflow.killSession', (node: { session?: { sid: number; personaName: string; gitBranch: string } }) => {
      if (node?.session) {
        killSession(client, node.session as import('./api/types.js').VibeFlowSession, sessionsProvider);
      }
    }),
    vscode.commands.registerCommand('vibeflow.restartSession', (node: { session?: { sid: number; personaKey: string; agentType: string; gitBranch: string; personaName: string } }) => {
      if (node?.session) {
        restartSession(client, node.session as import('./api/types.js').VibeFlowSession, detector, sessionsProvider);
      }
    }),
    vscode.commands.registerCommand('vibeflow.createWorkItem', () => {
      createWorkItem(client, detector, workItemsProvider);
    }),
    vscode.commands.registerCommand('vibeflow.openWorkItemPanel', (node: { type?: string; id?: string; label?: string; description?: string }) => {
      if (node?.type === 'todo' || node?.type === 'issue') {
        const idMatch = node.id?.match(/^(todo|issue)-(\d+)$/);
        if (idMatch) {
          workItemPanelManager.open({
            type: idMatch[1] as 'todo' | 'issue',
            id: parseInt(idMatch[2]),
            title: node.label?.replace(/^#\d+:\s*/, '') ?? '',
            status: node.description ?? '',
            priority: 'medium',
          });
        }
      }
    }),
    vscode.commands.registerCommand('vibeflow.changeStatus', (itemType: string, itemId: number, currentStatus: string) => {
      changeStatus(client, itemType as 'todo' | 'issue', itemId, currentStatus, workItemsProvider);
    }),
    vscode.commands.registerCommand('vibeflow.openSessionPanel', (node: { session?: import('./api/types.js').VibeFlowSession }) => {
      if (node?.session) {
        sessionPanelManager.open(node.session);
      }
    }),
    vscode.commands.registerCommand('vibeflow.viewSessions', () => {
      vscode.commands.executeCommand('vibeflow.agentFleet.focus');
    }),
    vscode.commands.registerCommand('vibeflow.respondToPrompt', () => {
      promptNotifier.showPendingPromptsQuickPick([]);
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
      openDocumentViewer(client, docId, docTitle);
    }),
    vscode.commands.registerCommand('vibeflow.openDashboard', () => {
      vscode.window.showInformationMessage('VibeFlow: Dashboard — coming soon');
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

  // =============================================
  // ACTIVATION: try auto-connect with stored credentials
  // =============================================

  await authService.initialize();
  await tryAutoConnect();
}

export function deactivate(): void {
  // Cleanup handled by disposables
}
