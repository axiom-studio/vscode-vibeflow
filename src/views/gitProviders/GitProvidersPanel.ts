import * as vscode from 'vscode';
import { getNonce } from '../../utils/nonce.js';
import type { VibeFlowClient } from '../../api/client.js';
import {
  assertNever,
  type GitProvidersPageClientMessage,
  type GitProvidersPageHostMessage,
} from '../../core/webviewMessages.js';

/**
 * Git Providers page (#2822) — a single webview listing the signed-in user's
 * account-level git providers, opened from the flag-gated "Git Providers" row
 * in the Browse nav. Mirrors the CloudRunnersPanel host pattern (load-on-mount,
 * becoming-visible debounce). Read + delete only: `GitProviderView` is
 * secret-free by API design (#433 §7.6 — id/name/gitUrl/authMode), and delete
 * is gated by a native modal confirm, matching the Settings tab's behavior.
 */
export class GitProvidersPanel {
  private static instance: GitProvidersPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private lastFetchAt = 0;

  private constructor(panel: vscode.WebviewPanel, private readonly client: VibeFlowClient) {
    this.panel = panel;
  }

  static open(extensionUri: vscode.Uri, client: VibeFlowClient): void {
    if (GitProvidersPanel.instance) {
      GitProvidersPanel.instance.panel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'vibeflow.gitProviders',
      'Git Providers',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'webview-ui', 'dist')],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'vibeflow-icon.svg');
    panel.webview.html = renderHtml(panel.webview, extensionUri);

    const instance = new GitProvidersPanel(panel, client);
    GitProvidersPanel.instance = instance;
    instance.attach();
  }

  private attach(): void {
    this.panel.webview.onDidReceiveMessage((msg: GitProvidersPageClientMessage) => this.handleMessage(msg));
    this.panel.onDidChangeViewState(e => {
      if (!e.webviewPanel.visible) { return; }
      // Debounce a becoming-visible refresh so tab-flipping doesn't spam the API.
      if (Date.now() - this.lastFetchAt < 1000) { return; }
      void this.load();
    });
    this.panel.onDidDispose(() => {
      if (GitProvidersPanel.instance === this) {
        GitProvidersPanel.instance = undefined;
      }
    });
  }

  private async handleMessage(msg: GitProvidersPageClientMessage): Promise<void> {
    switch (msg.type) {
      case 'gitProvidersPageLoad':
      case 'gitProvidersPageRefresh':
        await this.load();
        return;
      case 'gitProvidersPageDelete': {
        const { id, name } = msg.payload;
        const confirm = await vscode.window.showWarningMessage(
          `Delete git configuration "${name}"? This removes the stored credentials.`,
          { modal: true },
          'Delete',
        );
        if (confirm !== 'Delete') { return; }
        try {
          await this.client.deleteGitProvider(id);
          vscode.window.showInformationMessage(`VibeFlow: git configuration "${name}" deleted.`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`VibeFlow: delete failed — ${message}`);
        }
        await this.load();
        return;
      }
      default:
        assertNever(msg);
    }
  }

  private async load(): Promise<void> {
    this.lastFetchAt = Date.now();
    try {
      const providers = await this.client.listGitProviders();
      this.post({ type: 'gitProvidersPageData', payload: { providers, generatedAt: new Date().toISOString() } });
    } catch (err) {
      this.post({ type: 'gitProvidersPageError', payload: { message: err instanceof Error ? err.message : String(err) } });
    }
  }

  private post(msg: GitProvidersPageHostMessage): void {
    this.panel.webview.postMessage(msg);
  }
}

function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const distUri = vscode.Uri.joinPath(extensionUri, 'webview-ui', 'dist');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'assets', 'index.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'assets', 'index.css'));
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
      style-src ${webview.cspSource} 'unsafe-inline';
      script-src 'nonce-${nonce}';
      font-src ${webview.cspSource};">
  <link rel="stylesheet" href="${styleUri}">
  <title>Git Providers</title>
</head>
<body data-vf-mode="gitProviders">
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
