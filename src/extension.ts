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
  // Run detection asynchronously — don't block activation
  detector.detect(
    async (remoteUrl) => {
      if (!client.isAuthenticated()) { return undefined; }
      try {
        const projects = await client.listProjects();
        return projects.find(p => p.gitRemoteUrl === remoteUrl);
      } catch { return undefined; }
    },
    async () => {
      if (!client.isAuthenticated()) { return []; }
      try {
        return await client.listProjects();
      } catch { return []; }
    },
  ).then(project => {
    if (project) {
      // Wire TreeViews to live data now that we know the project
      sessionsProvider.connect(client, project.projectId);
      workItemsProvider.connect(client, project.projectId);
      vscode.window.showInformationMessage(
        `VibeFlow: Connected to "${project.projectName}" (${project.gitBranch})`,
      );
    }
  });

  // Also detect existing session files
  detector.detectSessionFiles().then(personas => {
    if (personas.length > 0) {
      // Session files found — sessions are active or were recently active
      // This info will be used by the Agent Fleet TreeView when wired to live data
    }
  });

  // --- Prompt Notifications ---
  const promptNotifier = new PromptNotifier();
  context.subscriptions.push(promptNotifier);

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
      vscode.window.showInformationMessage('VibeFlow: Create Work Item — coming soon');
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

  // --- Spike: simulate activity feed data ---
  // Push 500 historical entries on activation, then stream 1 new entry every 3s.
  // Remove this block once wired to real MCP polling.
  activityFeedProvider.pushEntries(generateBatch(500));

  const simulationTimer = setInterval(() => {
    activityFeedProvider.pushEntry(generateOne());
  }, 3000);

  context.subscriptions.push({ dispose: () => clearInterval(simulationTimer) });
}

export function deactivate(): void {
  // Cleanup handled by disposables
}
