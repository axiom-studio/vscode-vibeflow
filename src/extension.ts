import * as vscode from 'vscode';
import { SessionsTreeProvider } from './views/sessions/SessionsTreeProvider.js';
import { WorkItemsTreeProvider } from './views/workItems/WorkItemsTreeProvider.js';
import { ActivityFeedProvider } from './views/activity/ActivityFeedProvider.js';
import { DocumentsTreeProvider } from './views/documents/DocumentsTreeProvider.js';
import { createSessionStatusBar } from './statusBar/sessionStatus.js';
import { createWorkSummaryStatusBar } from './statusBar/workSummary.js';

export function activate(context: vscode.ExtensionContext): void {
  // TreeView data providers
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

  // Status bar items
  const sessionStatusBar = createSessionStatusBar();
  const workSummaryStatusBar = createWorkSummaryStatusBar();

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('vibeflow.login', () => {
      vscode.window.showInformationMessage('VibeFlow: Login — coming soon');
    }),
    vscode.commands.registerCommand('vibeflow.launchSession', () => {
      vscode.window.showInformationMessage('VibeFlow: Launch Session — coming soon');
    }),
    vscode.commands.registerCommand('vibeflow.createWorkItem', () => {
      vscode.window.showInformationMessage('VibeFlow: Create Work Item — coming soon');
    }),
    vscode.commands.registerCommand('vibeflow.viewSessions', () => {
      vscode.commands.executeCommand('vibeflow.agentFleet.focus');
    }),
    vscode.commands.registerCommand('vibeflow.respondToPrompt', () => {
      vscode.window.showInformationMessage('VibeFlow: Respond to Prompt — coming soon');
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

  // Add disposables
  context.subscriptions.push(
    sessionsView,
    workItemsView,
    documentsView,
    sessionStatusBar,
    workSummaryStatusBar,
  );
}

export function deactivate(): void {
  // Cleanup handled by disposables
}
