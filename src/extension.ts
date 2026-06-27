import * as vscode from 'vscode';
import { AuthService } from './auth/AuthService.js';
import { readCliConfig } from './auth/cliConfig.js';
import { validateServerUrl } from './auth/serverUrl.js';
import { VibeFlowClient } from './api/client.js';
import { SessionsTreeProvider } from './views/sessions/SessionsTreeProvider.js';
import { WorkItemsTreeProvider } from './views/workItems/WorkItemsTreeProvider.js';
import { ActivityFeedProvider } from './views/activity/ActivityFeedProvider.js';
import { DocumentsTreeProvider } from './views/documents/DocumentsTreeProvider.js';
import { PullRequestsTreeProvider } from './views/surface/PullRequestsTreeProvider.js';
import { TicketsPanel } from './views/tickets/TicketsPanel.js';
import { TicketsNavTreeProvider } from './views/tickets/TicketsNavTreeProvider.js';
import type { TicketsMode } from './core/webviewMessages.js';
import {
  createSessionStatusBar, createWorkSummaryStatusBar, createProjectStatusBar,
  type StatusBarItemWithUpdate, type WorkSummaryBarItem, type ProjectStatusBarItem,
} from './statusBar/sessionStatus.js';
import { createBranchReviewStatusBar } from './statusBar/branchReview.js';
import { ProjectDetector, type DetectedProject } from './project/ProjectDetector.js';
import { PromptNotifier } from './notifications/PromptNotifier.js';
import { registerChatParticipant } from './chat/participant.js';
import { launchSession, runLaunchGuarded } from './commands/sessionCommands.js';
import { killSession, killAndForgetSession, restartSession, focusTerminal, deleteSession, copySessionId } from './commands/sessionLifecycle.js';
import { openCli } from './commands/cliCommands.js';
import { installCli } from './commands/cliInstaller.js';
import { bootstrapMcp, uninstallMcp } from './commands/cliBootstrap.js';
import { pickProject as runProjectPickerCommand } from './commands/projectCommands.js';
import { TerminalRegistry } from './sessions/TerminalRegistry.js';
import { SessionStreamRegistry } from './sessions/SessionStreamRegistry.js';
import { AgentActivityOutputChannel } from './views/agentActivity/AgentActivityOutputChannel.js';
import { TmuxBacking } from './sessions/tmuxBacking.js';
import { SessionReattacher } from './sessions/SessionReattacher.js';
import { StickyModels } from './sessions/stickyModels.js';
import { createWorkItem, changeStatus, changePriority } from './commands/workItemCommands.js';
import { createDocument } from './commands/documentCommands.js';
import { qaVerify, qaReject, securityApprove, securityReject, checkBranchReviewStatus } from './commands/governanceCommands.js';
import { createPR, openDocumentViewer, openContextViewer, openReferenceViewer } from './commands/prCommands.js';
import { manageWorktrees, deleteWorktree } from './commands/worktreeCommands.js';
import { SettingsPanel } from './views/settings/SettingsPanel.js';
import { DashboardPanel } from './views/dashboard/DashboardPanel.js';
import { KanbanPanel } from './views/kanban/KanbanPanel.js';
import { BrainstormPanel } from './views/brainstorm/BrainstormPanel.js';
import { CompliancePanel } from './views/compliance/CompliancePanel.js';
import { AgentFileDecorationProvider } from './views/decorations/AgentFileDecorationProvider.js';
import { SessionPanelManager } from './views/sessions/SessionPanelManager.js';
import { AssetCache } from './assets/AssetCache.js';
import { composeSelectionPrompt } from './views/sessions/chatRenderer.js';
import { WorkItemPanelManager } from './views/workItems/WorkItemPanelManager.js';
import { ActivityPoller } from './views/activity/ActivityPoller.js';
import { FeedStateController } from './views/activity/feedStateController.js';
import { ContextProxy } from './core/ContextProxy.js';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // --- Core services ---
  // ContextProxy wraps globalState + secrets behind a typed registry
  // (src/core/ContextProxy.ts). Constructed first so every other
  // service can borrow a typed handle to persistence.
  const contextProxy = new ContextProxy(context);
  await contextProxy.migrate();
  const authService = new AuthService(contextProxy);
  const detector = new ProjectDetector(contextProxy);
  const promptNotifier = new PromptNotifier();

  // --- Status bar (created early so it reflects state immediately) ---
  const sessionStatusBar = createSessionStatusBar(authService, promptNotifier) as StatusBarItemWithUpdate;
  const workSummaryStatusBar = createWorkSummaryStatusBar() as WorkSummaryBarItem;
  const branchReviewStatusBar = createBranchReviewStatusBar();
  // Project switcher (priority 99 = sits just right of sessionStatusBar at 100).
  // Hidden until connectToProject() fires; #1702.
  const projectStatusBar: ProjectStatusBarItem = createProjectStatusBar();

  // --- API Client (needs auth) ---
  const client = new VibeFlowClient(authService);

  // The MCP transport captures the bearer token at construction time, so a
  // token swap (Settings → "Set API Key") would otherwise leave it talking
  // to the server with the OLD token until the next full logout. Forcing a
  // disconnect on every auth-state change makes the next callTool() rebuild
  // the transport with the fresh token. disconnect() is idempotent, so this
  // is safe even when the state change is the first 'authenticated' event.
  context.subscriptions.push(
    authService.onDidChangeState(() => {
      void client.disconnectMcp();
    }),
  );

  // --- TreeView data providers ---
  const sessionsProvider = new SessionsTreeProvider();
  const workItemsProvider = new WorkItemsTreeProvider();
  const activityFeedProvider = new ActivityFeedProvider(context.extensionUri, promptNotifier);
  const documentsProvider = new DocumentsTreeProvider();
  // Pull Requests stays a tree (row opens the PR in the browser). Todos /
  // Issues / Features / Backlog / Security Review / Pending QA moved to
  // cloud-style table panels (TicketsPanel), reached from the Browse nav.
  // Brainstorm Sessions removed — it lives in the brainstorm (bulb) panel.
  const pullRequestsProvider = new PullRequestsTreeProvider();
  const ticketsNavProvider = new TicketsNavTreeProvider(workItemsProvider);

  // --- Activity Feed empty/connection state controller ---
  // Centralizes the four facts the empty-state UX depends on (auth,
  // project, session count, poll health) into one FeedState. Each
  // observer below pushes its fact into the controller; the controller
  // emits to the webview only on actual state change.
  const feedStateController = new FeedStateController(activityFeedProvider);
  // Re-emit on webview `ready` so a panel revealed after state was
  // already computed renders the right empty state (instead of the
  // bare "No activity yet" fallback).
  activityFeedProvider.onReady = () => feedStateController.flush();
  // Auth → controller. The pre-existing onDidChangeState handler farther
  // below disconnects MCP; this one keeps the empty-state UX in sync.
  context.subscriptions.push(
    authService.onDidChangeState(state => {
      feedStateController.setAuth(state === 'authenticated');
    }),
  );

  // Status-bar work summary follows the trees: each successful
  // poll (which fires onDidChangeTreeData) recomputes the counts.
  // The same event also drives the Activity Feed empty-state controller
  // so "No active agent sessions" flips to "Connecting…" the moment a
  // session appears (or the other way on the next clean poll).
  context.subscriptions.push(
    sessionsProvider.onDidChangeTreeData(() => {
      refreshWorkSummary();
      feedStateController.setActiveSessionCount(sessionsProvider.getActiveSessionCount());
    }),
    workItemsProvider.onDidChangeTreeData(() => refreshWorkSummary()),
  );

  // --- File Decorations ---
  const fileDecorationProvider = new AgentFileDecorationProvider();
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(fileDecorationProvider),
    fileDecorationProvider,
  );

  // --- Terminal Registry + Sticky Models ---
  const terminalRegistry = new TerminalRegistry();
  const stickyModels = new StickyModels(contextProxy);
  context.subscriptions.push(terminalRegistry);

  // --- Tmux Backing (opt-in, todo #1615) ---
  // For chat-first sessions when `vibeflow.session.headlessBacking`
  // is set to `tmux`, the agent runs inside a detached tmux session
  // on the `vibeflow-headless` socket instead of a hidden VS Code
  // terminal. Killer benefit: agent survives IDE restart.
  const tmuxBacking = new TmuxBacking();
  context.subscriptions.push(tmuxBacking);
  // Detect any pre-existing tmux-backed sessions left over from a
  // previous IDE run. We don't try to re-register them as VS Code
  // sessions (that requires the agent's session_id from session_init,
  // which is owned by the backend) — we just log them so users
  // know they're still alive and can attach externally.
  void tmuxBacking.list().then(names => {
    if (names.length > 0) {
      console.log(`[VibeFlow] Found ${names.length} tmux-backed agent session(s) still alive: ${names.join(', ')}`);
    }
  });

  // --- Stream-JSON Registry + Agent Activity Output Channel ---
  // For chat-first / headless sessions (todo #1611) we spawn the agent
  // CLI in its `--output-format stream-json` mode and tail stdout as a
  // live activity feed. The Output channel renders normalized events
  // for users / maintainers; the SessionPanelManager subscribes for
  // chat-relevant tool_use events. See VibeFlow document #285 for the
  // full architectural rationale.
  const agentActivityChannel = new AgentActivityOutputChannel();
  const streamRegistry = new SessionStreamRegistry();
  context.subscriptions.push(
    agentActivityChannel,
    streamRegistry,
    // Wire every normalized event from every running agent into the
    // Output channel. Non-chat events render here; chat-relevant
    // events ALSO flow to the SessionPanelManager via a separate
    // subscription wired below (commit D — for now this is the only
    // consumer).
    streamRegistry.onEvent(payload => agentActivityChannel.appendEvent({
      providerKey: payload.providerKey,
      persona: payload.persona,
      branch: payload.branch,
      agentSessionId: payload.agentSessionId,
      event: payload.event,
    })),
    streamRegistry.onStderr(payload => {
      const handle = streamRegistry.get(payload.handleId);
      if (handle) {
        agentActivityChannel.appendStderr({
          providerKey: handle.providerKey,
          persona: handle.persona,
          branch: handle.branch,
          chunk: payload.chunk,
        });
      }
    }),
    streamRegistry.onParseError(payload => {
      const handle = streamRegistry.get(payload.handleId);
      if (handle) {
        agentActivityChannel.appendParseError({
          providerKey: handle.providerKey,
          persona: handle.persona,
          branch: handle.branch,
          line: payload.line,
          err: payload.err,
        });
      }
    }),
    streamRegistry.onExit(payload => agentActivityChannel.appendExit({
      providerKey: payload.providerKey,
      persona: payload.persona,
      branch: payload.branch,
      agentSessionId: payload.agentSessionId,
      code: payload.code,
      signal: payload.signal,
    })),
    // Spawn-line + watchdog log so a stuck chat-first launch can be
    // diagnosed without reading the registry source. Both render into
    // the same Agent Activity output channel.
    streamRegistry.onSpawn(payload => agentActivityChannel.appendSpawn({
      providerKey: payload.providerKey,
      persona: payload.persona,
      branch: payload.branch,
      binary: payload.binary,
      argv: payload.argv,
      cwd: payload.cwd,
    })),
    streamRegistry.onSilent(payload => agentActivityChannel.appendSilent({
      providerKey: payload.providerKey,
      persona: payload.persona,
      branch: payload.branch,
      elapsedMs: payload.elapsedMs,
    })),
    // Track stderr per-handle so a chat-first launch that exits before
    // calling session_init can surface its last-line error in the
    // Agent Fleet "Failed" row tooltip — without this, the user has to
    // open the Output channel to see why the process died.
    (() => {
      const lastStderrByHandle = new Map<string, string>();
      const subStderr = streamRegistry.onStderr(payload => {
        const text = payload.chunk.toString().trim();
        if (text) { lastStderrByHandle.set(payload.handleId, text); }
      });
      const subInit = streamRegistry.onEvent(payload => {
        // First session_init means the agent registered — trigger a
        // fast Agent Fleet refresh so the user sees the real session
        // row promptly without waiting for the 30s default poll.
        // The "Starting…" row is dropped inside fetchAndRefresh once
        // the new session actually appears in listSessions (avoids a
        // flicker between local session_init and server propagation).
        if (payload.event.kind === 'session_init' && payload.agentSessionId) {
          lastStderrByHandle.delete(payload.handleId);
          sessionsProvider.refresh();
        }
      });
      const subExit = streamRegistry.onExit(payload => {
        // Exit before session_init → the launch failed. Upgrade the
        // pending row to "Failed" so the user can find the failure
        // and dig into the Output channel.
        if (!payload.agentSessionId) {
          const lastErr = lastStderrByHandle.get(payload.handleId);
          const reason = lastErr
            ? lastErr
            : payload.signal
              ? `killed by signal ${payload.signal}`
              : payload.code != null
                ? `exited with code ${payload.code}`
                : 'exited before session_init';
          sessionsProvider.markFailed(payload.handleId, reason);
          // Loud toast — chat-first has no terminal, so without this
          // the user has zero idea the launch failed.
          vscode.window.showErrorMessage(
            `VibeFlow: ${payload.persona} chat-first launch failed — ${reason}`,
            'Open Agent Activity',
          ).then(action => {
            if (action === 'Open Agent Activity') {
              vscode.commands.executeCommand('vibeflow.openAgentActivity');
            }
          });
        }
        lastStderrByHandle.delete(payload.handleId);
      });
      return new vscode.Disposable(() => {
        subStderr.dispose();
        subInit.dispose();
        subExit.dispose();
      });
    })(),
  );

  // --- Focus Panels ---
  // SessionPanelManager subscribes to streamRegistry for chat-first
  // sessions (todo #1620) — tool_use events for prompt_user /
  // respond_to_prompt route into the chat panel sub-millisecond,
  // replacing the 5s REST polling for sessions with a live stream.
  // Chat-attachment binary cache (#1670) — bytes for uploaded /
  // downloaded chat assets live under globalStorageUri so they survive
  // extension restarts. Wired into SessionPanelManager so the chat
  // webview can `<img src>` them via webview.asWebviewUri().
  const assetCache = new AssetCache(
    client,
    vscode.Uri.joinPath(context.globalStorageUri, 'asset-cache'),
  );
  const sessionPanelManager = new SessionPanelManager(context.extensionUri, client, streamRegistry, assetCache, contextProxy);
  const workItemPanelManager = new WorkItemPanelManager(context.extensionUri, client, workItemsProvider);

  // --- Activity poller (started when connected) ---
  let activityPoller: ActivityPoller | undefined;

  // =============================================
  // CONNECTION LIFECYCLE
  // =============================================

  /**
   * Toggle the `vibeflow.configured` context key that gates the activity-bar
   * views: when false the Welcome / Get Started view is shown; when true the
   * four sections (Agent Fleet, Work Items, Project Items, Documents) are
   * shown. Driven by connect/disconnect so it always tracks real state.
   */
  function setConfiguredContext(configured: boolean): void {
    void vscode.commands.executeCommand('setContext', 'vibeflow.configured', configured);
  }

  /**
   * Connect all views to a detected project.
   * Called after successful setup or on activation with stored credentials.
   */
  function connectToProject(project: DetectedProject) {
    sessionsProvider.connect(client, project.projectId);
    workItemsProvider.connect(client, project.projectId);
    documentsProvider.connect(client, project.projectId);
    pullRequestsProvider.connect(client, project.projectId);

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
      feedStateController,
    );
    activityPoller.start();

    // Update status bars
    sessionStatusBar.updateProject(project);
    projectStatusBar.updateProject(project);
    refreshWorkSummary();
    branchReviewStatusBar.start(client, detector);

    // Tell the empty-state placeholder which branch we're actually on, so
    // it doesn't keep saying "main" when the user is sitting on feature/foo.
    sessionsProvider.setBranch(project.gitBranch);

    // Project is connected → tell the activity-feed state machine. Initial
    // session count comes from the cached value (likely 0); the
    // onDidChangeTreeData subscription below keeps it fresh.
    feedStateController.setProjectActive(true);
    feedStateController.setActiveSessionCount(sessionsProvider.getActiveSessionCount());

    // Setup is complete (key + project) → flip the gate so the activity-bar
    // shows the 4 sections instead of the Welcome / Get Started view.
    setConfiguredContext(true);
  }

  /**
   * Recompute the right-aligned summary bar from the trees. Called once
   * on connect (initial state) and again whenever either tree finishes
   * a poll. The trees fire onDidChangeTreeData after every successful
   * fetchAndRefresh, so subscribing to that event keeps the bar fresh
   * without a separate poller.
   */
  function refreshWorkSummary(): void {
    const agents = sessionsProvider.getActiveSessionCount();
    const ready = workItemsProvider.getReadyWorkItemCount();
    workSummaryStatusBar.updateCounts(agents, ready);
  }

  /**
   * Disconnect all views (on logout or error).
   */
  function disconnect() {
    activityPoller?.stop();
    activityPoller = undefined;
    sessionStatusBar.updateProject(undefined);
    projectStatusBar.updateProject(undefined);
    workSummaryStatusBar.setDisconnected();
    branchReviewStatusBar.stop();
    // Flip the activity feed to its unauthenticated empty state. Auth
    // state alone may still be 'authenticated' here (logout path fires
    // its own auth event), but a no-project state is functionally the
    // same: nothing to show, route the user to setup.
    feedStateController.setProjectActive(false);
    feedStateController.setActiveSessionCount(0);
    // TreeViews will show placeholder/empty state on next refresh

    // No project connected → show the Welcome / Get Started gate.
    setConfiguredContext(false);
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
   * Run when the workspace folder changes (`File → Open` to a different
   * directory, or first folder added to an empty workspace). Re-runs
   * the silent git-remote → project match. If the new folder maps to a
   * different vibeflow project than the cached one, prompts the user
   * to switch. Otherwise leaves state untouched.
   *
   * Closes the "open VSCode → switch to a different repo → still on
   * the old project" gap that sokryptk flagged. Auto-connect at
   * activation already handles the initial case; this handles the
   * mid-session case.
   */
  async function trySwitchOnFolderChange(): Promise<void> {
    if (!client.isAuthenticated()) { return; }
    let remoteUrl: string | undefined;
    try {
      remoteUrl = await detector.getGitRemoteUrl();
    } catch {
      return;
    }
    if (!remoteUrl) { return; }

    let projects;
    try {
      projects = await client.listProjects();
    } catch {
      return;
    }
    const matched = projects.find(p => p.git_remote_url === remoteUrl);
    if (!matched) { return; }

    const cached = detector.getCachedProject();
    if (cached && cached.projectId === matched.id) {
      // Already on the right project — re-cache the remote URL in case
      // the workspace's git remote was a stale cache from the previous
      // folder, then no-op.
      return;
    }

    // Different project — prompt rather than silent-switch. Silent
    // switching mid-session would be jarring (open panels suddenly
    // talking to a different backend).
    const cachedName = cached?.projectName ?? 'none';
    const choice = await vscode.window.showInformationMessage(
      `This folder belongs to VibeFlow project "${matched.name}". You're currently on "${cachedName}". Switch?`,
      'Switch',
      'Stay',
    );
    if (choice !== 'Switch') { return; }

    const branch = await detector.getGitBranch();
    const detected: DetectedProject = {
      projectId: matched.id,
      projectName: matched.name,
      gitRemoteUrl: remoteUrl,
      gitBranch: branch,
    };
    await detector.cacheProject(detected);
    connectToProject(detected);
    vscode.window.showInformationMessage(`VibeFlow: Switched to "${matched.name}"`);
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
      // Live HTTPS / scheme validation BEFORE the HEAD probe runs — we
      // can't let a plaintext URL get persisted because the very next
      // step attaches the API key as a Bearer token.
      validateInput: v => {
        const r = validateServerUrl(v);
        return r.ok ? null : r.message ?? 'Invalid server URL';
      },
    });
    if (serverUrl === undefined) { return; }

    // Defense in depth: validateInput rejects bad values before submit,
    // but a future caller change shouldn't be the only thing standing
    // between an HTTP URL and a leaked key.
    const schemeCheck = validateServerUrl(serverUrl);
    if (!schemeCheck.ok) {
      vscode.window.showErrorMessage(`VibeFlow: ${schemeCheck.message}`);
      return;
    }

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
    // Use `tag` (not `kind`) — `vscode.QuickPickItem.kind` already exists for
    // separator items, so a `kind` discriminator on our intersected type
    // would collide and degrade the picked result to `string`.
    type ProjectPickTag =
      | { tag: 'project'; project: { id: number; name: string } }
      | { tag: 'create' }
      | { tag: 'enter-id' };
    const items: Array<vscode.QuickPickItem & ProjectPickTag> = [
      ...projects.map(p => ({
        tag: 'project' as const,
        project: p,
        label: p.name,
        description: `ID: ${p.id}`,
      })),
      { tag: 'create' as const, label: '$(add) Create New Project', description: '' },
      { tag: 'enter-id' as const, label: '$(search) Enter Project ID', description: 'Select by numeric ID' },
    ];

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a VibeFlow project',
      title: 'VibeFlow Setup (3/3)',
    });

    if (!picked) { return undefined; }

    if (picked.tag === 'project') {
      return picked.project;
    }

    if (picked.tag === 'enter-id') {
      const raw = await vscode.window.showInputBox({
        prompt: 'Enter VibeFlow project ID',
        placeHolder: '1234',
        ignoreFocusOut: true,
        validateInput: v => /^\d+$/.test(v.trim()) ? null : 'Project ID must be a positive integer',
      });
      if (!raw) { return undefined; }
      const id = parseInt(raw.trim(), 10);
      // Resolve the name via the already-fetched project list when possible —
      // saves a round-trip and keeps the connect path identical to the
      // dropdown branch. Fall back to a labeled placeholder so the user
      // sees a meaningful project name in the status bar; the next
      // tryAutoConnect cycle refreshes the cache.
      const known = projects.find(p => p.id === id);
      return known ?? { id, name: `Project #${id}` };
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

  // Default the gate to "not configured" so the Welcome / Get Started view
  // is shown until tryAutoConnect (or a manual Setup) connects a project.
  // connectToProject / disconnect keep this in sync thereafter.
  setConfiguredContext(false);

  // The Welcome view is a contribution-only surface: its content comes from
  // the `viewsWelcome` entry in package.json (the Get Started button). It
  // still needs a registered data provider, so give it one that yields no
  // tree items — that keeps the view "empty" and lets the welcome render.
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('vibeflow.welcome', {
      getChildren: () => [],
      getTreeItem: (element: vscode.TreeItem) => element,
    }),
  );

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

  const browseView = vscode.window.createTreeView('vibeflow.browse', {
    treeDataProvider: ticketsNavProvider,
  });
  const pullRequestsView = vscode.window.createTreeView('vibeflow.pullRequests', {
    treeDataProvider: pullRequestsProvider,
  });
  context.subscriptions.push(browseView, pullRequestsView, pullRequestsProvider, ticketsNavProvider);

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
      // Cached chat-attachment binaries are tied to the authenticated
      // identity; clear them so a different user signing in on the
      // same machine doesn't see the previous user's assets.
      await assetCache.clearAll();
      disconnect();
      vscode.window.showInformationMessage('VibeFlow: Logged out');
    }),
    vscode.commands.registerCommand('vibeflow.openCli', async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      await runLaunchGuarded('Open CLI', () => openCli(root), msg => vscode.window.showErrorMessage(msg));
    }),
    vscode.commands.registerCommand('vibeflow.installCli', async () => {
      try {
        const installedPath = await installCli(context);
        // Configure the VibeFlow MCP server into the user's coding agents as
        // part of install (Ranjan's "configure during install"). Auto mode:
        // all supported agents, skips quietly if not signed in. Only runs on
        // a successful install — installCli returns undefined on cancel.
        if (installedPath) {
          await bootstrapMcp(authService, { auto: true });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const choice = await vscode.window.showErrorMessage(
          `VibeFlow CLI install failed: ${message}`,
          'View Install Instructions',
        );
        if (choice === 'View Install Instructions') {
          vscode.env.openExternal(vscode.Uri.parse('https://github.com/axiom-studio/vibeflow-cli#installation'));
        }
      }
    }),
    vscode.commands.registerCommand('vibeflow.bootstrapCli', async () => {
      await bootstrapMcp(authService);
    }),
    vscode.commands.registerCommand('vibeflow.uninstallCli', async () => {
      await uninstallMcp();
    }),
    vscode.commands.registerCommand('vibeflow.launchSession', async () => {
      // CLI mode owns session management — short-circuit and route to
      // the TUI launcher so we don't spawn duplicate per-persona
      // terminals that would race with the CLI's tmux-managed sessions.
      const reportError = (msg: string) => vscode.window.showErrorMessage(msg);
      const cliEnabled = vscode.workspace.getConfiguration('vibeflow').get<boolean>('cli.enabled', false);
      if (cliEnabled) {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        await runLaunchGuarded('Open CLI', () => openCli(root), reportError);
        return;
      }
      // Guard the launch so an un-try/caught throw inside the wizard
      // (getGitBranch / ensureMcpConfig / ensureAllAgentDocs) surfaces a
      // clear error instead of a silent unhandled rejection (issue #3195).
      await runLaunchGuarded(
        'Launch Session',
        () => launchSession(client, detector, sessionsProvider, context.extensionUri, terminalRegistry, stickyModels, contextProxy, streamRegistry, tmuxBacking, connectToProject),
        reportError,
      );
    }),
    vscode.commands.registerCommand('vibeflow.focusTerminal', (idOrNode: string | { id?: string }) => {
      const id = typeof idOrNode === 'string' ? idOrNode : idOrNode?.id;
      const session = id ? sessionsProvider.getSessionById(id) : undefined;
      if (session) { focusTerminal(terminalRegistry, session); }
    }),
    vscode.commands.registerCommand('vibeflow.killSession', (idOrNode: string | { id?: string }) => {
      const id = typeof idOrNode === 'string' ? idOrNode : idOrNode?.id;
      const session = id ? sessionsProvider.getSessionById(id) : undefined;
      if (session) { killSession(client, session, sessionsProvider, terminalRegistry); }
    }),
    vscode.commands.registerCommand('vibeflow.killAndForgetSession', (idOrNode: string | { id?: string }) => {
      const id = typeof idOrNode === 'string' ? idOrNode : idOrNode?.id;
      const session = id ? sessionsProvider.getSessionById(id) : undefined;
      if (session) { killAndForgetSession(client, session, sessionsProvider, terminalRegistry); }
    }),
    vscode.commands.registerCommand('vibeflow.restartSession', async (idOrNode: string | { id?: string }) => {
      const id = typeof idOrNode === 'string' ? idOrNode : idOrNode?.id;
      const session = id ? sessionsProvider.getSessionById(id) : undefined;
      // Guard the pre-spawn awaits (confirm modal, project/branch resolution)
      // that sit outside restartSession's internal try/catch (#3197).
      if (session) {
        await runLaunchGuarded(
          'Restart Session',
          () => restartSession(client, session, detector, sessionsProvider, terminalRegistry, stickyModels, contextProxy),
          msg => vscode.window.showErrorMessage(msg),
        );
      }
    }),
    vscode.commands.registerCommand('vibeflow.deleteSession', (idOrNode: string | { id?: string }) => {
      const id = typeof idOrNode === 'string' ? idOrNode : idOrNode?.id;
      const session = id ? sessionsProvider.getSessionById(id) : undefined;
      if (session) { deleteSession(client, session, sessionsProvider); }
    }),
    vscode.commands.registerCommand('vibeflow.dismissFailedPending', (idOrNode: string | { id?: string }) => {
      // Right-click → Dismiss on a failed pending row in Agent Fleet.
      // Removes the row without touching any real session (pending entries
      // are local-only — clearing one only fires the tree-change event).
      const id = typeof idOrNode === 'string' ? idOrNode : idOrNode?.id;
      if (id) { sessionsProvider.dismissPendingByNodeId(id); }
    }),
    vscode.commands.registerCommand('vibeflow.cancelStartingPending', (idOrNode: string | { id?: string }) => {
      // Cancel a `starting` pending row in Agent Fleet — sends SIGTERM
      // to the child process AND removes the UI row. Kill first so a
      // slow exit doesn't leave the row visible past the user's click;
      // the exit event fires later on its own clock.
      const id = typeof idOrNode === 'string' ? idOrNode : idOrNode?.id;
      if (!id || !id.startsWith('pending-')) { return; }
      const handleId = id.slice('pending-'.length);
      streamRegistry.killByHandleId(handleId);
      sessionsProvider.dismissPendingByNodeId(id);
    }),
    vscode.commands.registerCommand('vibeflow.copySessionId', (idOrNode: string | { id?: string }) => {
      const id = typeof idOrNode === 'string' ? idOrNode : idOrNode?.id;
      const session = id ? sessionsProvider.getSessionById(id) : undefined;
      if (session) { void copySessionId(session); }
    }),
    vscode.commands.registerCommand('vibeflow.showAllTerminals', () => {
      // Reveal every registered VibeFlow terminal — including ones launched
      // with hideFromUser:true (advisory agents in hybrid mode). VS Code
      // has no built-in command to surface hidden terminals, so without
      // this users can't see/approve a permission prompt blocking
      // session_init in a hidden advisory terminal.
      const count = terminalRegistry.revealAll();
      if (count === 0) {
        vscode.window.showInformationMessage('VibeFlow: no agent terminals running.');
      } else {
        vscode.window.showInformationMessage(`VibeFlow: revealed ${count} terminal${count === 1 ? '' : 's'}.`);
      }
    }),
    vscode.commands.registerCommand('vibeflow.openSessionPanel', (idOrNode: string | { id?: string }) => {
      const id = typeof idOrNode === 'string' ? idOrNode : idOrNode?.id;
      // Accept both a tree-item id (`session-<id>`, from tree clicks) and a raw
      // session_id (from the dashboard Live topology click).
      const session = id ? (sessionsProvider.getSessionById(id) ?? sessionsProvider.getSessionBySessionId(id)) : undefined;
      if (session) { sessionPanelManager.open(session); }
      else { vscode.window.showInformationMessage('VibeFlow: Session not found — it may have expired'); }
    }),
    vscode.commands.registerCommand('vibeflow.openAgentActivity', () => {
      // Reveals the "VibeFlow Agent Activity" Output channel. For
      // chat-first / stream-json sessions (todo #1620, doc #285) this
      // is the escape hatch that shows raw normalized agent events
      // (tool_use, tool_result, agent_text, api_retry, …) — the
      // replacement for "reveal the hidden TUI terminal" since
      // stream-json sessions don't have a terminal.
      agentActivityChannel.show();
    }),
    vscode.commands.registerCommand('vibeflow.chat.askSelection', async () => {
      // IDE superpower #1 (todo #1613): right-click an editor
      // selection → composes a fenced-code-block prompt and seeds
      // an open chat panel's textarea via `chatPrefill`.
      //
      // Resolution: prefer the active session panel; if multiple
      // panels are open, ask the user which one. If none are
      // open, point at vibeflow.launchSession.
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showInformationMessage('VibeFlow: Select some code first.');
        return;
      }
      const openIds = sessionPanelManager.getOpenSessionIds();
      if (openIds.length === 0) {
        const action = await vscode.window.showInformationMessage(
          'VibeFlow: Open a chat session first to send a selection.',
          'Launch Session',
        );
        if (action === 'Launch Session') {
          vscode.commands.executeCommand('vibeflow.launchSession');
        }
        return;
      }
      let targetId = openIds[0];
      if (openIds.length > 1) {
        const pick = await vscode.window.showQuickPick(
          openIds.map(id => ({ label: id.slice(-12), description: 'session id (last 12)', id })),
          { placeHolder: 'Send selection to which session?' },
        );
        if (!pick) { return; }
        targetId = pick.id;
      }
      // Build the prompt — workspace-relative path keeps it
      // portable when copied to axiomcloud / agent logs.
      const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
      const rel = folder ? vscode.workspace.asRelativePath(editor.document.uri, false) : editor.document.uri.fsPath;
      const text = composeSelectionPrompt({
        relativePath: rel,
        startLine: editor.selection.start.line,
        endLine: editor.selection.end.line,
        text: editor.document.getText(editor.selection),
        languageId: editor.document.languageId,
      });
      const ok = sessionPanelManager.prefillChat(targetId, text);
      if (!ok) {
        vscode.window.showWarningMessage('VibeFlow: Could not seed the chat panel.');
      }
    }),
    vscode.commands.registerCommand('vibeflow.createWorkItem', () => {
      createWorkItem(client, detector, workItemsProvider);
    }),
    vscode.commands.registerCommand('vibeflow.createDocument', () => {
      createDocument(client, detector, documentsProvider);
    }),
    vscode.commands.registerCommand('vibeflow.openWorkItemPanel', (
      arg1: string | TreeNodeArg,
      label?: string,
      description?: string,
    ) => {
      // Accepts either:
      //  - positional: (nodeId, label, description) — old call sites
      //    (e.g. WorkItemsTreeProvider's per-row click command, which
      //    already passes the parsed strings).
      //  - tree menu: (treeItem) — VS Code hands the TreeItem itself
      //    when a `view/item/context` entry fires this command.
      const ref = resolveWorkItemRef(arg1);
      if (!ref) { return; }
      // From-tree click: treeItem.label is the work-item label, but
      // when invoked positionally label is already the user-visible
      // string and contextValue carries the status. From-tree-menu:
      // treeItem.contextValue is "todo-{status}" so derive status; we
      // don't have a clean label string from contextValue alone.
      const tree = typeof arg1 === 'object' ? arg1 : undefined;
      const treeLabel = typeof tree?.label === 'string'
        ? tree.label
        : (typeof tree?.label === 'object' && tree?.label && 'label' in tree.label ? String(tree.label.label) : '');
      const resolvedLabel = label ?? treeLabel ?? '';
      const resolvedDescription = description ?? ref.status ?? '';
      workItemPanelManager.open({
        type: ref.type,
        id: ref.id,
        title: resolvedLabel.replace(/^#\d+:\s*/, ''),
        status: resolvedDescription,
        priority: 'medium',
      });
    }),
    vscode.commands.registerCommand('vibeflow.changeStatus', (
      arg1: string | TreeNodeArg,
      itemId?: number,
      currentStatus?: string,
    ) => {
      const ref = resolveWorkItemRef(arg1, itemId, currentStatus);
      if (!ref) { return; }
      changeStatus(client, ref.type, ref.id, ref.status ?? '', workItemsProvider);
    }),
    vscode.commands.registerCommand('vibeflow.changePriority', (
      arg1: string | TreeNodeArg,
      itemId?: number,
    ) => {
      const ref = resolveWorkItemRef(arg1, itemId);
      if (!ref) { return; }
      changePriority(client, ref.type, ref.id, workItemsProvider);
    }),
    vscode.commands.registerCommand('vibeflow.viewSessions', () => {
      vscode.commands.executeCommand('vibeflow.agentFleet.focus');
    }),
    vscode.commands.registerCommand('vibeflow.respondToPrompt', () => {
      promptNotifier.showPendingPromptsQuickPick();
    }),
    vscode.commands.registerCommand('vibeflow.qaVerify', (arg1: string | TreeNodeArg, id?: number) => {
      const ref = resolveWorkItemRef(arg1, id);
      if (!ref) { return; }
      qaVerify(client, ref.type, ref.id, workItemsProvider);
    }),
    vscode.commands.registerCommand('vibeflow.qaReject', (arg1: string | TreeNodeArg, id?: number) => {
      const ref = resolveWorkItemRef(arg1, id);
      if (!ref) { return; }
      qaReject(client, ref.type, ref.id, workItemsProvider);
    }),
    vscode.commands.registerCommand('vibeflow.securityApprove', (arg1: string | TreeNodeArg, id?: number) => {
      const ref = resolveWorkItemRef(arg1, id);
      if (!ref) { return; }
      securityApprove(client, ref.type, ref.id, workItemsProvider);
    }),
    vscode.commands.registerCommand('vibeflow.securityReject', (arg1: string | TreeNodeArg, id?: number) => {
      const ref = resolveWorkItemRef(arg1, id);
      if (!ref) { return; }
      securityReject(client, ref.type, ref.id, workItemsProvider);
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
    vscode.commands.registerCommand('vibeflow.openContextViewer', (contextId: number, contextTitle: string) => {
      openContextViewer(client, detector, context.extensionUri, contextId, contextTitle);
    }),
    vscode.commands.registerCommand('vibeflow.openReferenceViewer', (refId: number, refTitle: string, pageUrl: string | undefined) => {
      openReferenceViewer(client, detector, context.extensionUri, refId, refTitle, pageUrl);
    }),
    vscode.commands.registerCommand('vibeflow.openSettings', () => {
      SettingsPanel.open(context.extensionUri, {
        authService,
        client,
        detector,
        stickyModels,
        secrets: context.secrets,
        onProjectSwitched: connectToProject,
      });
    }),
    vscode.commands.registerCommand('vibeflow.clearActivityFeed', () => {
      activityFeedProvider.clearFeed();
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
          contextProxy,
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
    vscode.commands.registerCommand('vibeflow.openTickets', (mode?: TicketsMode) => {
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
      TicketsPanel.open(context.extensionUri, client, project.projectId, project.projectName, mode ?? 'todos');
    }),
    vscode.commands.registerCommand('vibeflow.openBrainstorm', () => {
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
      BrainstormPanel.open(context.extensionUri, client, project.projectId, project.projectName);
    }),
    vscode.commands.registerCommand('vibeflow.pickProject', () => {
      void runProjectPickerCommand({ client, detector, onSwitched: connectToProject });
    }),
    vscode.commands.registerCommand('vibeflow.reportIssue', () => {
      // Open the public issue tracker with environment info pre-filled
      // in the body — bug reports without repro context are useless,
      // so we encode the basics directly into the URL. The user can
      // still edit before submitting.
      const ext = vscode.extensions.getExtension('AxiomStudio.vscode-vibeflow');
      const extVersion = (ext?.packageJSON as { version?: string } | undefined)?.version ?? 'unknown';
      const lines = [
        '<!-- The "Environment" block was filled in automatically. Please describe the bug below. -->',
        '',
        '## What happened',
        '',
        '',
        '## Steps to reproduce',
        '',
        '1. ',
        '2. ',
        '3. ',
        '',
        '## Environment',
        '',
        `- **Extension version**: ${extVersion}`,
        `- **VSCode version**: ${vscode.version}`,
        `- **OS**: ${process.platform} ${process.arch}`,
        `- **Connected to**: ${vscode.workspace.getConfiguration('vibeflow').get<string>('serverUrl', '(unset)')}`,
        '',
      ];
      const body = encodeURIComponent(lines.join('\n'));
      const url = `https://github.com/axiom-studio/vscode-vibeflow/issues/new?template=bug.md&body=${body}`;
      void vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    vscode.commands.registerCommand('vibeflow.openCompliance', () => {
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
      CompliancePanel.open(context.extensionUri, client, project.projectId, project.projectName);
    }),
    vscode.commands.registerCommand('vibeflow.manageWorktrees', () => {
      manageWorktrees();
    }),
    vscode.commands.registerCommand('vibeflow.openWorktreeInNewWindow', (idOrNode: string | { id?: string }) => {
      const id = typeof idOrNode === 'string' ? idOrNode : idOrNode?.id;
      const wt = id ? sessionsProvider.getWorktreeById(id) : undefined;
      if (!wt) {
        vscode.window.showInformationMessage('VibeFlow: Worktree not found — try refreshing.');
        return;
      }
      void vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wt.path), true);
    }),
    vscode.commands.registerCommand('vibeflow.deleteWorktreeFromTree', (idOrNode: string | { id?: string }) => {
      const id = typeof idOrNode === 'string' ? idOrNode : idOrNode?.id;
      const wt = id ? sessionsProvider.getWorktreeById(id) : undefined;
      if (!wt) {
        vscode.window.showInformationMessage('VibeFlow: Worktree not found — try refreshing.');
        return;
      }
      const workDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workDir) {
        vscode.window.showErrorMessage('VibeFlow: No workspace folder open');
        return;
      }
      void deleteWorktree(workDir, wt).then(() => sessionsProvider.refresh());
    }),
    vscode.commands.registerCommand('vibeflow.createSessionInWorktree', async (idOrNode: string | { id?: string }) => {
      const id = typeof idOrNode === 'string' ? idOrNode : idOrNode?.id;
      const wt = id ? sessionsProvider.getWorktreeById(id) : undefined;
      if (!wt) {
        vscode.window.showInformationMessage('VibeFlow: Worktree not found — try refreshing.');
        return;
      }
      // Same silent-rejection guard as the play button (#3195 / #3197) — an
      // un-awaited launch here would swallow a pre-spawn throw and the
      // "Create Session Here" action would silently do nothing.
      await runLaunchGuarded(
        'Create Session in Worktree',
        () => launchSession(
          client,
          detector,
          sessionsProvider,
          context.extensionUri,
          terminalRegistry,
          stickyModels,
          contextProxy,
          streamRegistry,
          tmuxBacking,
          connectToProject,
          { branch: wt.branch, workDir: wt.path },
        ),
        msg => vscode.window.showErrorMessage(msg),
      );
    }),
    vscode.commands.registerCommand('vibeflow.refresh', () => {
      sessionsProvider.refresh();
      workItemsProvider.refresh();
      documentsProvider.refresh();
      pullRequestsProvider.refresh();
      void branchReviewStatusBar.refresh();
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
    projectStatusBar,
    branchReviewStatusBar,
    { dispose: () => activityPoller?.stop() },
  );

  // --- @vibeflow Chat Participant ---
  registerChatParticipant(context, client, detector, promptNotifier);

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

  // Dev-mode convenience: if the extension is running under F5 (Run
  // Extension) with no workspace folder open, auto-add the extension's
  // own folder as a workspace. This avoids the empty-`workDir` failure
  // mode in `launchSession` / `ensureMcpConfig` that surfaces as a
  // "`.mcp.json` not found in ." warning on chat-first launches. Gated
  // strictly on `ExtensionMode.Development` so shipped .vsix installs
  // never see this behavior — replaces the `vibeflow.devMode.workspaceFolder`
  // config knob removed in v1.0.0-R1 (commit `bfd42a0`) with a no-knob
  // dev-only path. Override path with the `VIBEFLOW_DEV_FOLDER` env var
  // when the project lives somewhere other than `--extensionDevelopmentPath`.
  if (
    context.extensionMode === vscode.ExtensionMode.Development &&
    (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0)
  ) {
    const devFolder = process.env.VIBEFLOW_DEV_FOLDER ?? context.extensionUri.fsPath;
    try {
      vscode.workspace.updateWorkspaceFolders(0, 0, {
        uri: vscode.Uri.file(devFolder),
        name: 'vibeflow-dev',
      });
      console.log('[VibeFlow] Dev mode: auto-added workspace folder:', devFolder);
    } catch (err) {
      console.log('[VibeFlow] Dev mode: failed to add workspace folder —', err);
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
      // Reject CLI-imported plaintext URLs with the same rule as the
      // wizard — a CLI config that happens to point at HTTP would
      // otherwise auto-import and silently leak the key on the next
      // poll cycle.
      const cliCheck = validateServerUrl(cliConfig.serverUrl);
      if (cliCheck.ok) {
        const config = vscode.workspace.getConfiguration('vibeflow');
        await config.update('serverUrl', cliConfig.serverUrl, vscode.ConfigurationTarget.Global);
      } else {
        console.warn('[VibeFlow] Rejected CLI serverUrl:', cliCheck.message);
        vscode.window.showWarningMessage(
          `VibeFlow: ignored CLI-imported server URL — ${cliCheck.message}`,
        );
      }
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

  // #1947 Layer 1 — activation preflight. The cached `vibeflow.serverUrl`
  // may have been set to plaintext HTTP before #1745's WRITE-path
  // validation landed. Re-validate the persisted value before auto-connect
  // so the bearer token never rides a plain-HTTP transport silently.
  // Original fix commit: 00c6041 (security-cleared by Sophie). Restored
  // here after silent regression via commit e0ef3ad. Build-time guard at
  // scripts/check-security-guards.mjs prevents another silent revert.
  const cachedServerUrl = vscode.workspace.getConfiguration('vibeflow')
    .get<string>('serverUrl', 'https://cloud.axiomstudio.ai');
  const cachedCheck = validateServerUrl(cachedServerUrl);
  if (!cachedCheck.ok) {
    const message = cachedCheck.message ?? 'Insecure serverUrl.';
    sessionStatusBar.setError(`Insecure serverUrl — open Setup to fix (${message})`);
    void vscode.window.showWarningMessage(
      `VibeFlow: ${message} Auto-connect skipped. Run "VibeFlow: Setup" to update.`,
      'Open Setup',
    ).then(choice => {
      if (choice === 'Open Setup') {
        void vscode.commands.executeCommand('vibeflow.setup');
      }
    });
    console.warn('[VibeFlow] activation preflight skipped tryAutoConnect:', message);
  } else {
    await tryAutoConnect();
  }

  // Re-run the silent git-remote → project match whenever the
  // workspace folder set changes (File → Open, drag-drop folder, etc.).
  // If the new folder maps to a different vibeflow project than
  // currently cached, prompts the user to switch.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void trySwitchOnFolderChange();
    }),
  );

  // --- Session Reattachment ---
  // Detect .vibeflow-session-* files from a previous VSCode window
  // and offer to reattach terminals for them.
  const cachedProject = detector.getCachedProject();
  if (cachedProject) {
    const gitBranch = await detector.getGitBranch();
    // Pull the live session list from the backend so detectPhantoms can
    // sweep sidecars whose session_id was already deleted server-side
    // (older builds left them behind; this path catches the cleanup
    // even if the user upgrades after killing). Wrap in allSettled so
    // a network failure here doesn't block reattach for fresh phantoms.
    let liveSessionIds: Set<string> | undefined;
    try {
      const live = await client.listSessions(cachedProject.projectId);
      liveSessionIds = new Set(live.map(s => s.session_id));
    } catch {
      // Network down or auth missing — skip the cross-check, fall back
      // to the legacy "trust the file" behavior.
    }
    const phantoms = await SessionReattacher.detectPhantoms(terminalRegistry, gitBranch, liveSessionIds);
    if (phantoms.length > 0) {
      const serverUrl = vscode.workspace.getConfiguration('vibeflow')
        .get<string>('serverUrl', 'https://cloud.axiomstudio.ai');
      // Default provider from settings; user can override at reattach time
      const defaultProvider = vscode.workspace.getConfiguration('vibeflow')
        .get<string>('defaultProvider', 'claude');
      // The .vibeflow-session-{persona} file only stores the session id, not
      // the launch mode — so we can't recover the original mode after a
      // window reload. Default to vanilla (safe: per-action permission
      // prompts) and let the user opt in to skip-permissions reattach
      // explicitly via vibeflow.session.reattachMode. Pre-fix this hardcoded
      // 'vibeflow', which silently upgraded a vanilla agent to YOLO mode.
      const reattachMode = vscode.workspace.getConfiguration('vibeflow')
        .get<string>('session.reattachMode', 'vanilla');
      SessionReattacher.promptReattach(
        phantoms,
        terminalRegistry,
        defaultProvider,
        reattachMode,
        gitBranch,
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
        serverUrl,
        contextProxy,
        cachedProject.projectName,
      ).then(() => sessionsProvider.refresh());
    }
  }

}

export function deactivate(): void {
  // Cleanup handled by disposables
}

/**
 * Subset of `vscode.TreeItem` fields we read when a work-item command
 * is invoked from a tree's right-click menu. VS Code passes the
 * TreeItem itself; these are the only fields we use, so the type is
 * deliberately narrow rather than re-exporting the full interface.
 */
interface TreeNodeArg {
  id?: string;
  label?: string | { label: string };
  contextValue?: string;
}

/**
 * Resolve a `(type, id, status?)` triple from the polymorphic command
 * argument shape used by work-item commands. Two call patterns:
 *
 *   1. Positional from existing code paths:
 *        vibeflow.qaVerify('todo', 1234)
 *        vibeflow.changeStatus('todo', 1234, 'done')
 *
 *   2. From a tree right-click menu, where VS Code passes the
 *      TreeItem itself as the first argument. Our tree nodes carry
 *      `id = "todo-1234"` and `contextValue = "todo-done"`, both of
 *      which we parse to recover the same triple.
 *
 * Returns undefined when neither shape parses — every command's
 * registration handles that as a no-op.
 */
function resolveWorkItemRef(
  arg1: string | TreeNodeArg | undefined,
  itemId?: number,
  status?: string,
): { type: 'todo' | 'issue'; id: number; status?: string } | undefined {
  if (typeof arg1 === 'string') {
    const t = arg1 === 'todo' || arg1 === 'issue' ? arg1 : undefined;
    if (t && typeof itemId === 'number') {
      return { type: t, id: itemId, status };
    }
    // Single-string form: `"todo-1234"` (e.g. from openWorkItemPanel
    // call sites that already pre-flatten the node id).
    const m = arg1.match(/^(todo|issue)-(\d+)$/);
    if (m) { return { type: m[1] as 'todo' | 'issue', id: parseInt(m[2], 10), status }; }
    return undefined;
  }
  if (arg1 && typeof arg1 === 'object') {
    const idMatch = (arg1.id ?? '').match(/^(todo|issue)-(\d+)$/);
    if (!idMatch) { return undefined; }
    const type = idMatch[1] as 'todo' | 'issue';
    const id = parseInt(idMatch[2], 10);
    // contextValue is "todo-{status}" / "issue-{status}" — extract
    // the suffix, not the prefix. statusGroup nodes use the literal
    // "statusGroup" so they fail the regex below and fall through.
    const ctx = arg1.contextValue ?? '';
    const statusMatch = ctx.match(/^(?:todo|issue)-(.+)$/);
    return { type, id, status: statusMatch?.[1] ?? status };
  }
  return undefined;
}
