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
      } else if (msg.type === 'getSetting') {
        // Return current settings so the SettingsView can render
        const config = vscode.workspace.getConfiguration('vibeflow');
        panel.webview.postMessage({
          type: 'settingsData',
          payload: {
            serverUrl: config.get('serverUrl', 'https://cloud.axiomstudio.ai'),
            serverReachable: null,
            apiKeySet: true, // Assume set if settings opened (user is authenticated)
            apiKeyValid: null,
            projectId: null,
            projectName: null,
            projects: [],
            defaultProvider: config.get('defaultProvider', 'claude'),
            providers: [
              { key: 'claude', name: 'Claude Code', binary: 'claude', available: true, vibeflowIntegrated: true, llmGatewayEnabled: false, envTokenSet: false },
              { key: 'codex', name: 'OpenAI Codex CLI', binary: 'codex', available: false, vibeflowIntegrated: false, llmGatewayEnabled: false, envTokenName: 'MCP_TOKEN', envTokenSet: false },
              { key: 'gemini', name: 'Google Gemini CLI', binary: 'gemini', available: false, vibeflowIntegrated: false, llmGatewayEnabled: false, envTokenName: 'GEMINI_API_KEY', envTokenSet: false },
              { key: 'cursor', name: 'Cursor Agent', binary: 'agent', available: false, vibeflowIntegrated: true, llmGatewayEnabled: false, envTokenSet: false },
            ],
            worktreeBaseDir: config.get('worktree.baseDir', '.claude/worktrees'),
            worktreeAutoCreate: true,
            worktreeCleanupOnKill: 'ask',
            pollInterval: config.get('polling.interval', 30),
            viewMode: 'flat',
            skipPermissions: false,
            errorRecoveryEnabled: true,
            errorRecoveryMaxRetries: 10,
            errorRecoveryDebounce: 5,
            notifyAgentPrompts: config.get('notifications.agentPrompts', true),
            notifyWorkComplete: config.get('notifications.workItemComplete', true),
            debugSimulateActivity: config.get('debug.simulateActivity', false),
            debugVerboseLogging: false,
            version: '0.1.0',
          },
        });
      }
    });

    panel.onDidDispose(() => {
      SettingsPanel.instance = undefined;
    });

    SettingsPanel.instance = panel;
  }
}
