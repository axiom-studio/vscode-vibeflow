import * as vscode from 'vscode';
import type { VibeFlowClient } from '../api/client.js';
import type { ProjectDetector } from '../project/ProjectDetector.js';
import { checkBranchReviewStatus } from './governanceCommands.js';
import { saveAndNotify, deleteCommentWithErrorHandling } from './commentCommands.js';
import { getNonce } from '../utils/nonce.js';

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
    openCommentableEntityViewer(
      client, extensionUri, 'document', docId, docTitle, content, projectId,
    );
  } catch (err) {
    vscode.window.showErrorMessage(`VibeFlow: Failed to load document — ${err}`);
  }
}

/**
 * Open a context ("Memory" in axiomcloud UI) in the same React-based
 * markdown viewer used for documents. Comments are wired the same way —
 * the comment subsystem already supports `entity_type: 'context'` per
 * `axiomcloud/handlers/vibeflow_comments.go`.
 */
export async function openContextViewer(
  client: VibeFlowClient,
  detector: ProjectDetector,
  extensionUri: vscode.Uri,
  contextId: number,
  contextTitle: string,
): Promise<void> {
  try {
    const ctx = await client.getContext(contextId);
    const content = ctx.content ?? 'No content available.';
    const project = detector.getCachedProject();
    const projectId = project?.projectId ?? ctx.project_id ?? 0;
    openCommentableEntityViewer(
      client, extensionUri, 'context', contextId, contextTitle, content, projectId,
    );
  } catch (err) {
    vscode.window.showErrorMessage(`VibeFlow: Failed to load context — ${err}`);
  }
}

/**
 * Open a Confluence reference. Fetches the cached page body server-side and
 * renders read-only — references don't carry comments in axiomcloud either,
 * and the page lives upstream in Confluence so editing here would diverge.
 * The header CTA jumps to the original page.
 */
export async function openReferenceViewer(
  client: VibeFlowClient,
  detector: ProjectDetector,
  extensionUri: vscode.Uri,
  refId: number,
  refTitle: string,
  pageUrl: string | undefined,
): Promise<void> {
  const project = detector.getCachedProject();
  if (!project) {
    vscode.window.showErrorMessage('VibeFlow: No project detected.');
    return;
  }

  try {
    const data = await client.getReferenceContent(project.projectId, refId);
    const content = data.content ?? 'No content available.';

    const panel = vscode.window.createWebviewPanel(
      'vibeflow.referenceViewer',
      refTitle,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'webview-ui', 'dist')],
      },
    );

    panel.webview.html = getEntityViewerHtml(
      panel.webview, extensionUri, content, refTitle, 'reference', refId, project.projectId,
    );

    panel.webview.onDidReceiveMessage((msg) => {
      // The webview reuses the same React shell; for references we only
      // need to honor the initial `ready` handshake (no comment routes).
      if (msg?.type === 'ready') {
        panel.webview.postMessage({
          type: 'showDocument',
          content,
          title: refTitle,
          entityType: 'reference',
          entityId: refId,
          projectId: project.projectId,
        });
      } else if (msg?.type === 'openExternal' && pageUrl) {
        vscode.env.openExternal(vscode.Uri.parse(pageUrl));
      }
    });
  } catch (err) {
    vscode.window.showErrorMessage(`VibeFlow: Failed to load reference — ${err}`);
  }
}

/**
 * Shared implementation: wire a markdown entity (document or context) into
 * the CommentableDocumentViewer webview, including the full comment CRUD
 * round-trip. Extracted so document and context callers share one path —
 * the comment endpoints already accept either entity type.
 */
function openCommentableEntityViewer(
  client: VibeFlowClient,
  extensionUri: vscode.Uri,
  entityType: 'document' | 'context',
  entityId: number,
  title: string,
  content: string,
  projectId: number,
): void {
  const panel = vscode.window.createWebviewPanel(
    `vibeflow.${entityType}Viewer`,
    title,
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'webview-ui', 'dist')],
    },
  );

  panel.webview.html = getEntityViewerHtml(
    panel.webview, extensionUri, content, title, entityType, entityId, projectId,
  );

  panel.webview.onDidReceiveMessage(async (msg) => {
    switch (msg.type) {
      case 'ready':
        panel.webview.postMessage({
          type: 'showDocument',
          content,
          title,
          entityType,
          entityId,
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
          const comments = await client.listComments(entityType, entityId);
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
          const comments = await client.listComments(entityType, entityId);
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
}

function getEntityViewerHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  content: string,
  title: string,
  entityType: 'document' | 'context' | 'reference',
  entityId: number,
  projectId: number,
): string {
  const distUri = vscode.Uri.joinPath(extensionUri, 'webview-ui', 'dist');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'assets', 'index.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'assets', 'index.css'));
  const nonce = getNonce();

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
  data-vf-entity-type="${entityType}"
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
