import * as vscode from 'vscode';
import type { VibeFlowClient } from '../api/client.js';
import type { ProjectDetector } from '../project/ProjectDetector.js';
import { checkBranchReviewStatus } from './governanceCommands.js';

/**
 * Create a PR with auto-populated body from completed work items.
 * Gates on branch review status first.
 */
export async function createPR(
  client: VibeFlowClient,
  detector: ProjectDetector,
): Promise<void> {
  const project = detector.getCachedProject();
  if (!project) {
    vscode.window.showErrorMessage('VibeFlow: No project detected.');
    return;
  }

  if (!client.isAuthenticated()) {
    vscode.window.showErrorMessage('VibeFlow: Not logged in.');
    return;
  }

  // Check branch review status first
  const ready = await checkBranchReviewStatus(client, detector);
  if (!ready) {
    const proceed = await vscode.window.showWarningMessage(
      'Branch has unreviewed items. Create PR anyway?',
      'Create PR',
      'Cancel',
    );
    if (proceed !== 'Create PR') { return; }
  }

  // Get PR title
  const title = await vscode.window.showInputBox({
    prompt: 'PR title',
    placeHolder: `feat: ${project.gitBranch}`,
    value: `feat: ${project.gitBranch}`,
  });
  if (!title) { return; }

  // Select target branch
  const baseBranch = await vscode.window.showInputBox({
    prompt: 'Base branch (merge into)',
    value: 'main',
  });
  if (!baseBranch) { return; }

  try {
    const result = await client.createPR(project.projectId, {
      title,
      head: project.gitBranch,
      base: baseBranch,
    });

    if (result.url) {
      const open = await vscode.window.showInformationMessage(
        `VibeFlow: PR created — ${result.url}`,
        'Open in Browser',
      );
      if (open) {
        vscode.env.openExternal(vscode.Uri.parse(result.url));
      }
    } else {
      vscode.window.showInformationMessage('VibeFlow: PR created successfully');
    }
  } catch (err) {
    vscode.window.showErrorMessage(`VibeFlow: Failed to create PR — ${err}`);
  }
}

/**
 * Open a document in a simple markdown viewer panel.
 */
export async function openDocumentViewer(
  client: VibeFlowClient,
  docId: number,
  docTitle: string,
): Promise<void> {
  try {
    const doc = await client.getDocument(docId);

    const panel = vscode.window.createWebviewPanel(
      'vibeflow.documentViewer',
      docTitle,
      vscode.ViewColumn.One,
      { enableScripts: false },
    );

    // Render markdown as simple HTML
    const content = doc.content ?? 'No content available.';
    const htmlContent = content
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');

    panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 20px; line-height: 1.6; max-width: 800px; }
    h1, h2, h3 { color: var(--vscode-foreground); }
    code { background: var(--vscode-textCodeBlock-background); padding: 2px 6px; border-radius: 3px; font-family: var(--vscode-editor-font-family); }
    strong { color: var(--vscode-foreground); }
  </style>
</head>
<body>${htmlContent}</body>
</html>`;
  } catch (err) {
    vscode.window.showErrorMessage(`VibeFlow: Failed to load document — ${err}`);
  }
}
