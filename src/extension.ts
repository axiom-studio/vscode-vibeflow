import * as vscode from 'vscode';
import { AuthService } from './auth/AuthService.js';
import { VibeFlowUriHandler } from './auth/UriHandler.js';
import { VibeFlowClient } from './api/client.js';
import { SessionsTreeProvider } from './views/sessions/SessionsTreeProvider.js';
import { WorkItemsTreeProvider } from './views/workItems/WorkItemsTreeProvider.js';
import { ActivityFeedProvider } from './views/activity/ActivityFeedProvider.js';
import { DocumentsTreeProvider } from './views/documents/DocumentsTreeProvider.js';
import { createSessionStatusBar } from './statusBar/sessionStatus.js';
import { createWorkSummaryStatusBar } from './statusBar/workSummary.js';
import { ProjectDetector } from './project/ProjectDetector.js';
import { PromptNotifier } from './notifications/PromptNotifier.js';
import { registerChatParticipant } from './chat/participant.js';
import { launchSession, killSession, restartSession } from './commands/sessionCommands.js';
import { createWorkItem, changeStatus } from './commands/workItemCommands.js';
import { SessionPanelManager } from './views/sessions/SessionPanelManager.js';
import { WorkItemPanelManager } from './views/workItems/WorkItemPanelManager.js';
import { ActivityPoller } from './views/activity/ActivityPoller.js';
import { generateBatch, generateOne } from './views/activity/simulateActivity.js';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // --- Auth ---
  const authService = new AuthService(context.secrets);
  await authService.initialize();

  const uriHandler = new VibeFlowUriHandler(authService);
  context.subscriptions.push(
    vscode.window.registerUriHandler(uriHandler),
    authService,
  );

  // --- API Client ---
  const client = new VibeFlowClient(authService);

  // --- Project Detection ---
  const detector = new ProjectDetector(context.workspaceState);
  // Run detection asynchronously — don't block activation.
  // Single detection call wires TreeViews + Activity Feed poller.
  let activityPoller: ActivityPoller | undefined;
  const matchFn = async (remoteUrl: string) => {
    if (!client.isAuthenticated()) { return undefined; }
    try {
      const projects = await client.listProjects();
      return projects.find(p => p.gitRemoteUrl === remoteUrl);
    } catch { return undefined; }
  };
  const listFn = async () => {
    if (!client.isAuthenticated()) { return []; }
    try { return await client.listProjects(); } catch { return []; }
  };

  detector.detect(matchFn, listFn).then(project => {
    if (project) {
      // Wire TreeViews to live data
      sessionsProvider.connect(client, project.projectId);
      workItemsProvider.connect(client, project.projectId);

      // Start real Activity Feed polling
      activityPoller = new ActivityPoller(client, activityFeedProvider, promptNotifier, project.projectId);
      activityPoller.start();

      vscode.window.showInformationMessage(
        `VibeFlow: Connected to "${project.projectName}" (${project.gitBranch})`,
      );
    } else {
      // Demo mode: simulated data when not connected
      activityFeedProvider.pushEntries(generateBatch(500));
      const simTimer = setInterval(() => activityFeedProvider.pushEntry(generateOne()), 3000);
      context.subscriptions.push({ dispose: () => clearInterval(simTimer) });
    }
  });

  // --- Prompt Notifications ---
  const promptNotifier = new PromptNotifier();
  context.subscriptions.push(promptNotifier);

  // --- Focus Panels ---
  const sessionPanelManager = new SessionPanelManager(context.extensionUri, client);
  const workItemPanelManager = new WorkItemPanelManager(context.extensionUri, client);
  context.subscriptions.push(sessionPanelManager, workItemPanelManager);

  // --- TreeView data providers ---
  const sessionsProvider = new SessionsTreeProvider();
  const workItemsProvider = new WorkItemsTreeProvider();
  const activityFeedProvider = new ActivityFeedProvider(context.extensionUri);
  const documentsProvider = new DocumentsTreeProvider();

  // Register TreeViews
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

  // Register WebviewView (Activity Feed)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'vibeflow.activityFeed',
      activityFeedProvider,
    ),
  );

  // --- Status bar items ---
  const sessionStatusBar = createSessionStatusBar(authService, promptNotifier);
  const workSummaryStatusBar = createWorkSummaryStatusBar();

  // --- Commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand('vibeflow.login', () => authService.login()),
    vscode.commands.registerCommand('vibeflow.logout', () => authService.logout()),
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
      // Show Quick Pick of all pending prompts
      // In production, this would fetch current pending prompts from the API
      promptNotifier.showPendingPromptsQuickPick([]);
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

  // --- Disposables ---
  context.subscriptions.push(
    sessionsProvider,
    workItemsProvider,
    sessionsView,
    workItemsView,
    documentsView,
    sessionStatusBar,
    workSummaryStatusBar,
  );

  // --- @vibeflow Chat Participant ---
  // Gracefully no-ops if Copilot isn't installed
  registerChatParticipant(context, client, detector);

  // Cleanup poller on deactivation
  context.subscriptions.push({ dispose: () => activityPoller?.stop() });
}

export function deactivate(): void {
  // Cleanup handled by disposables
}
