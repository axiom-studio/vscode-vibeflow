import * as vscode from 'vscode';
import { getNonce } from '../../utils/nonce.js';

/**
 * Dashboard / Mission Control Webview Panel.
 * Shows agent topology graph, summary metrics, and compliance snapshot.
 * Singleton — only one dashboard panel at a time.
 */
export class DashboardPanel {
  private static instance: vscode.WebviewPanel | undefined;

  static open(extensionUri: vscode.Uri): void {
    if (DashboardPanel.instance) {
      DashboardPanel.instance.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'vibeflow.dashboard',
      'VibeFlow Dashboard',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'webview-ui', 'dist')],
      },
    );

    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'vibeflow-icon.svg');

    const distUri = vscode.Uri.joinPath(extensionUri, 'webview-ui', 'dist');
    const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'assets', 'index.js'));
    const styleUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'assets', 'index.css'));
    const nonce = getNonce();

    panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
      style-src ${panel.webview.cspSource} 'unsafe-inline';
      script-src 'nonce-${nonce}';
      font-src ${panel.webview.cspSource};">
  <link rel="stylesheet" href="${styleUri}">
  <title>Dashboard</title>
</head>
<body data-vf-mode="dashboard">
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;

    panel.onDidDispose(() => { DashboardPanel.instance = undefined; });
    DashboardPanel.instance = panel;
  }
}
