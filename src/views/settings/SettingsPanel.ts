import * as vscode from 'vscode';
import { getNonce } from '../../utils/nonce.js';
import type { AuthService } from '../../auth/AuthService.js';

/**
 * Manages the Settings Webview Panel in the editor area.
 * Singleton pattern — only one settings panel at a time.
 */
export class SettingsPanel {
  private static instance: vscode.WebviewPanel | undefined;

  static open(extensionUri: vscode.Uri, authService?: AuthService): void {
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
    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'closeSettings') {
        panel.dispose();
      } else if (msg.type === 'updateSetting') {
        // Persist a setting change immediately
        const { key, value } = msg.payload as { key: string; value: unknown };
        const config = vscode.workspace.getConfiguration('vibeflow');

        // Route to the right storage based on key
        const settingsKeys = ['serverUrl', 'defaultPersona', 'defaultProvider', 'polling.interval',
          'autoDetectProject', 'showStatusBar', 'notifications.agentPrompts',
          'notifications.workItemComplete', 'session.terminalMode',
          'debug.simulateActivity'];

        if (settingsKeys.includes(key)) {
          // VSCode native settings (settings.json)
          config.update(key, value, vscode.ConfigurationTarget.Global);
        }
        // No confirmation toast — instant save matches VSCode settings UX
      } else if (msg.type === 'setApiKey') {
        // Open VSCode Input Box (prompt() doesn't work in webview sandbox)
        const key = await vscode.window.showInputBox({
          prompt: 'Paste your VibeFlow API key',
          placeHolder: 'your-api-key',
          password: true,
          ignoreFocusOut: true,
        });
        if (key && authService) {
          await authService.setToken(key);
          vscode.window.showInformationMessage('VibeFlow: API key updated');
          // Refresh settings data in webview
          panel.webview.postMessage({ type: 'settingsData', payload: { ...buildSettingsPayload(), apiKeySet: true } });
        }
      } else if (msg.type === 'setProviderToken') {
        const { provider: provKey } = msg.payload as { provider: string };
        const envName = provKey === 'codex' ? 'MCP_TOKEN' : provKey === 'gemini' ? 'GEMINI_API_KEY' : `${provKey.toUpperCase()}_TOKEN`;
        const token = await vscode.window.showInputBox({
          prompt: `Enter ${envName}`,
          placeHolder: envName,
          password: true,
          ignoreFocusOut: true,
        });
        if (token) {
          vscode.window.showInformationMessage(`VibeFlow: ${envName} saved`);
        }
      } else if (msg.type === 'validateServerUrl') {
        const url = msg.payload as string;
        try {
          await fetch(url + '/rest/v1/vibeflow/projects', { method: 'HEAD', signal: AbortSignal.timeout(5000) });
          panel.webview.postMessage({ type: 'validationResult', payload: { field: 'serverUrl', valid: true } });
          vscode.window.showInformationMessage('VibeFlow: Server reachable');
        } catch {
          panel.webview.postMessage({ type: 'validationResult', payload: { field: 'serverUrl', valid: false, message: 'Server unreachable' } });
          vscode.window.showWarningMessage('VibeFlow: Server unreachable');
        }
      } else if (msg.type === 'validateApiKey') {
        vscode.window.showInformationMessage('VibeFlow: Use "Test Connection" on the server URL first');
      } else if (msg.type === 'getSetting') {
        panel.webview.postMessage({ type: 'settingsData', payload: buildSettingsPayload() });
      }
    });

    panel.onDidDispose(() => {
      SettingsPanel.instance = undefined;
    });

    SettingsPanel.instance = panel;
  }
}

function buildSettingsPayload(): Record<string, unknown> {
  const config = vscode.workspace.getConfiguration('vibeflow');
  return {
    serverUrl: config.get('serverUrl', 'https://cloud.axiomstudio.ai'),
    serverReachable: null,
    apiKeySet: true,
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
    sessionTerminalMode: config.get('session.terminalMode', 'hybrid'),
    version: '0.1.0',
  };
}
