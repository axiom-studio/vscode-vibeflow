import * as vscode from 'vscode';
import { getNonce } from '../../utils/nonce.js';

/**
 * Manages the Settings Webview Panel in the editor area.
 * Singleton pattern — only one settings panel at a time.
 */
export class SettingsPanel {
  private static instance: vscode.WebviewPanel | undefined;

  static open(extensionUri: vscode.Uri): void {
    // Reuse existing panel if open
    if (SettingsPanel.instance) {
      SettingsPanel.instance.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'vibeflow.settings',
      'VibeFlow Settings',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'webview-ui', 'dist')],
      },
    );

    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'settings.svg');

    const distUri = vscode.Uri.joinPath(extensionUri, 'webview-ui', 'dist');
    const scriptUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(distUri, 'assets', 'index.js'),
    );
    const styleUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(distUri, 'assets', 'index.css'),
    );
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
  <title>VibeFlow Settings</title>
</head>
<body data-vf-mode="settings">
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;

    // Handle messages from the settings webview
    panel.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'closeSettings') {
        panel.dispose();
      }
      // Other settings message types handled by the existing
      // settingsHandler on ActivityFeedProvider — but for the
      // dedicated panel, we handle them here too.
    });

    panel.onDidDispose(() => {
      SettingsPanel.instance = undefined;
    });

    SettingsPanel.instance = panel;
  }
}
