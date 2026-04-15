import * as vscode from 'vscode';
import type { VibeFlowClient } from '../api/client.js';
import type { ProjectDetector } from '../project/ProjectDetector.js';
import { checkBranchReviewStatus } from './governanceCommands.js';
import { saveAndNotify, deleteCommentWithErrorHandling } from './commentCommands.js';

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
 * Open a document in the React-based markdown viewer with inline comments.
 * Reuses the webview-ui bundle and routes to CommentableDocumentViewer.
 */
export async function openDocumentViewer(
  client: VibeFlowClient,
  detector: ProjectDetector,
  extensionUri: vscode.Uri,
  docId: number,
  docTitle: string,
): Promise<void> {
  try {
    const doc = await client.getDocument(docId);
    const content = doc.content ?? 'No content available.';
    const project = detector.getCachedProject();
    const projectId = project?.projectId ?? 0;

    const panel = vscode.window.createWebviewPanel(
      'vibeflow.documentViewer',
      docTitle,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'webview-ui', 'dist')],
      },
    );

    panel.webview.html = getDocumentViewerHtml(
      panel.webview, extensionUri, content, docTitle, docId, projectId,
    );

    // Handle messages from the webview (comment operations)
    panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          panel.webview.postMessage({
            type: 'showDocument',
            content,
            title: docTitle,
            entityType: 'document',
            entityId: docId,
            projectId,
          });
          break;

        case 'listComments': {
          const comments = await client.listComments(msg.entityType, msg.entityId);
          panel.webview.postMessage({ type: 'commentsList', payload: comments });
          break;
        }

        case 'createComment': {
          try {
            const created = await client.createComment({
              entityType: msg.entityType,
              entityId: msg.entityId,
              projectId: msg.projectId,
              sectionHeading: msg.sectionHeading,
              content: msg.content,
            });
            panel.webview.postMessage({ type: 'commentCreated', payload: created });
          } catch (err) {
            panel.webview.postMessage({
              type: 'commentError',
              payload: { message: err instanceof Error ? err.message : String(err) },
            });
          }
          break;
        }

        case 'deleteComment': {
          const ok = await deleteCommentWithErrorHandling(client, msg.commentId);
          if (ok) {
            panel.webview.postMessage({ type: 'commentDeleted', payload: { id: msg.commentId } });
          } else {
            // Restore optimistically-removed comment by refetching
            const comments = await client.listComments('document', docId);
            panel.webview.postMessage({ type: 'commentsList', payload: comments });
          }
          break;
        }

        case 'commentsSaveAndNotify': {
          const p = msg.payload;
          try {
            await saveAndNotify(
              client,
              p.projectId,
              p.documentTitle,
              p.entityType,
              p.entityId,
              p.drafts,
              p.sections,
            );
            // Refresh comment list after save
            const comments = await client.listComments('document', docId);
            panel.webview.postMessage({ type: 'commentsList', payload: comments });
          } catch (err) {
            panel.webview.postMessage({
              type: 'commentError',
              payload: { message: err instanceof Error ? err.message : String(err) },
            });
          }
          break;
        }
      }
    });
  } catch (err) {
    vscode.window.showErrorMessage(`VibeFlow: Failed to load document — ${err}`);
  }
}

function getDocumentViewerHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  content: string,
  title: string,
  entityId: number,
  projectId: number,
): string {
  const distUri = vscode.Uri.joinPath(extensionUri, 'webview-ui', 'dist');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'assets', 'index.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'assets', 'index.css'));
  const nonce = Array.from({ length: 32 }, () => Math.random().toString(36)[2]).join('');

  // Encode content as base64 to safely embed in HTML data attribute
  const encodedContent = Buffer.from(content, 'utf-8').toString('base64');
  const encodedTitle = Buffer.from(title, 'utf-8').toString('base64');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
      style-src ${webview.cspSource} 'unsafe-inline';
      script-src 'nonce-${nonce}';
      font-src ${webview.cspSource};
      img-src ${webview.cspSource} https: data:;">
  <link rel="stylesheet" href="${styleUri}">
  <title>Document</title>
</head>
<body
  data-vf-mode="document"
  data-vf-content-b64="${encodedContent}"
  data-vf-title-b64="${encodedTitle}"
  data-vf-entity-type="document"
  data-vf-entity-id="${entityId}"
  data-vf-project-id="${projectId}"
>
  <div id="root"></div>
  <script nonce="${nonce}">
    document.body.dataset.vfContent = atob(document.body.dataset.vfContentB64);
    document.body.dataset.vfTitle = atob(document.body.dataset.vfTitleB64);
    delete document.body.dataset.vfContentB64;
    delete document.body.dataset.vfTitleB64;
  </script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
