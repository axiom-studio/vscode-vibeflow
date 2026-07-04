import * as vscode from 'vscode';
import { getNonce } from '../../utils/nonce.js';
import type { VibeFlowClient } from '../../api/client.js';
import {
  assertNever,
  type CloudRunnersClientMessage,
  type CloudRunnersHostMessage,
} from '../../core/webviewMessages.js';

/**
 * Cloud Runners TABLE panel (feature #603) — a single webview (one instance)
 * listing the runners visible to the signed-in user across their org/projects.
 * Opened from the flag-gated "Cloud Runners" row in the Browse nav. Mirrors the
 * TicketsPanel host pattern (load-on-mount, refresh-on-becoming-visible) but is
 * read-only and unpaginated: the global runner list is small and the mutating
 * verbs (create/start/stop/delete) live on other surfaces.
 */
export class CloudRunnersPanel {
  private static instance: CloudRunnersPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private lastFetchAt = 0;

  private constructor(panel: vscode.WebviewPanel, private readonly client: VibeFlowClient) {
    this.panel = panel;
  }

  static open(extensionUri: vscode.Uri, client: VibeFlowClient, projectName: string): void {
    if (CloudRunnersPanel.instance) {
      CloudRunnersPanel.instance.panel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'vibeflow.cloudRunners',
      `Cloud Runners — ${projectName}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'webview-ui', 'dist')],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'vibeflow-icon.svg');
    panel.webview.html = renderHtml(panel.webview, extensionUri);

    const instance = new CloudRunnersPanel(panel, client);
    CloudRunnersPanel.instance = instance;
    instance.attach();
  }

  private attach(): void {
    this.panel.webview.onDidReceiveMessage((msg: CloudRunnersClientMessage) => this.handleMessage(msg));
    this.panel.onDidChangeViewState(e => {
      if (!e.webviewPanel.visible) { return; }
      // Debounce a becoming-visible refresh so tab-flipping doesn't spam the API.
      if (Date.now() - this.lastFetchAt < 1000) { return; }
      void this.load();
    });
    this.panel.onDidDispose(() => {
      if (CloudRunnersPanel.instance === this) {
        CloudRunnersPanel.instance = undefined;
      }
    });
  }

  private async handleMessage(msg: CloudRunnersClientMessage): Promise<void> {
    switch (msg.type) {
      case 'cloudRunnersLoad':
      case 'cloudRunnersRefresh':
        await this.load();
        return;
      default:
        assertNever(msg);
    }
  }

  private async load(): Promise<void> {
    this.lastFetchAt = Date.now();
    try {
      const runners = await this.client.listCloudRunners();
      this.post({ type: 'cloudRunnersData', payload: { runners, generatedAt: new Date().toISOString() } });
    } catch (err) {
      this.post({ type: 'cloudRunnersError', payload: { message: err instanceof Error ? err.message : String(err) } });
    }
  }

  private post(msg: CloudRunnersHostMessage): void {
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
  <title>Cloud Runners</title>
</head>
<body data-vf-mode="cloudRunners">
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
