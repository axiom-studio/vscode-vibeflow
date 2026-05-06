import * as vscode from 'vscode';
import { getNonce } from '../../utils/nonce.js';
import type { AuthService } from '../../auth/AuthService.js';
import type { VibeFlowClient } from '../../api/client.js';
import type { ProjectDetector, DetectedProject } from '../../project/ProjectDetector.js';
import { StickyModels, KNOWN_MODELS } from '../../sessions/stickyModels.js';
import { assertNever, type SettingsClientMessage, type SettingsHostMessage } from '../../core/webviewMessages.js';
import { validateServerUrl } from '../../auth/serverUrl.js';
import { isVibeflowInstalled } from '../../commands/cliCommands.js';

/**
 * Optional dependencies the panel needs to wire interactive controls.
 * All optional so a partially-initialized extension activate path can
 * still open the panel and edit pure-VS-Code settings (server URL,
 * polling interval, etc.) — actions that need a project simply degrade.
 */
export interface SettingsPanelDeps {
  authService?: AuthService;
  client?: VibeFlowClient;
  detector?: ProjectDetector;
  /** Per-persona sticky model store; the Models tab reads/writes through this. */
  stickyModels?: StickyModels;
  /**
   * Callback invoked after the user picks a different project from the
   * Settings dropdown. extension.ts wires this to its connectToProject
   * helper so trees, pollers, panels all rebind to the new id without a
   * window reload.
   */
  onProjectSwitched?: (project: DetectedProject) => void;
}

/**
 * Manages the Settings Webview Panel in the editor area.
 * Singleton pattern — only one settings panel at a time.
 */
export class SettingsPanel {
  private static instance: vscode.WebviewPanel | undefined;

  static open(extensionUri: vscode.Uri, deps: SettingsPanelDeps = {}): void {
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

    /** Typed wrapper so a future drift in SettingsHostMessage fails the compile. */
    const postToWebview = (msg: SettingsHostMessage) => {
      panel.webview.postMessage(msg);
    };

    /** Push a fresh settings snapshot to the webview. */
    const pushSettings = async () => {
      const payload = await buildSettingsPayload(deps);
      postToWebview({ type: 'settingsData', payload });
    };

    // Handle messages from the settings webview
    panel.webview.onDidReceiveMessage(async (msg: SettingsClientMessage) => {
      switch (msg.type) {
        case 'closeSettings':
          panel.dispose();
          break;
        case 'updateSetting': {
          // Persist a setting change immediately
          const { key, value } = msg.payload;
          const config = vscode.workspace.getConfiguration('vibeflow');

          // Route to the right storage based on key
          const settingsKeys = ['serverUrl', 'defaultPersona', 'defaultProvider', 'polling.interval',
            'autoDetectProject', 'showStatusBar', 'notifications.agentPrompts',
            'notifications.workItemComplete', 'session.terminalMode',
            'debug.simulateActivity',
            'cli.enabled', 'cli.binaryPath'];

          if (settingsKeys.includes(key)) {
            config.update(key, value, vscode.ConfigurationTarget.Global);
          }
          break;
        }
        case 'setApiKey': {
          const key = await vscode.window.showInputBox({
            prompt: 'Paste your VibeFlow API key',
            placeHolder: 'your-api-key',
            password: true,
            ignoreFocusOut: true,
          });
          if (key && deps.authService) {
            await deps.authService.setToken(key);
            vscode.window.showInformationMessage('VibeFlow: API key updated');
            await pushSettings();
          }
          break;
        }
        case 'setProviderToken': {
          const provKey = msg.payload.provider;
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
          break;
        }
        case 'validateServerUrl': {
          const url = msg.payload;
          // Scheme check FIRST — a reachability probe against an HTTP URL
          // succeeds and would mislead the user into trusting a value
          // that subsequently leaks the API key on every request.
          const schemeCheck = validateServerUrl(url);
          if (!schemeCheck.ok) {
            postToWebview({
              type: 'validationResult',
              payload: { field: 'serverUrl', valid: false, message: schemeCheck.message },
            });
            vscode.window.showWarningMessage(`VibeFlow: ${schemeCheck.message}`);
            break;
          }
          try {
            await fetch(url + '/rest/v1/vibeflow/projects', { method: 'HEAD', signal: AbortSignal.timeout(5000) });
            postToWebview({ type: 'validationResult', payload: { field: 'serverUrl', valid: true } });
            vscode.window.showInformationMessage('VibeFlow: Server reachable');
          } catch {
            postToWebview({ type: 'validationResult', payload: { field: 'serverUrl', valid: false, message: 'Server unreachable' } });
            vscode.window.showWarningMessage('VibeFlow: Server unreachable');
          }
          break;
        }
        case 'validateApiKey': {
          if (!deps.client) {
            vscode.window.showInformationMessage('VibeFlow: Use "Test Connection" on the server URL first');
            break;
          }
          try {
            const projects = await deps.client.listProjects();
            postToWebview({ type: 'validationResult', payload: { field: 'apiKey', valid: true } });
            vscode.window.showInformationMessage(`VibeFlow: API key valid — found ${projects.length} project(s)`);
            await pushSettings();
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            postToWebview({ type: 'validationResult', payload: { field: 'apiKey', valid: false, message: errMsg } });
            vscode.window.showWarningMessage(`VibeFlow: API key invalid — ${errMsg}`);
          }
          break;
        }
        case 'getSetting':
          await pushSettings();
          break;
        case 'refreshProjects':
          // Just rebuild the payload — buildSettingsPayload re-fetches the
          // project list from the server on every call.
          await pushSettings();
          break;
        case 'selectProject': {
          if (!deps.client || !deps.detector) {
            vscode.window.showWarningMessage('VibeFlow: not connected — sign in first');
            break;
          }
          const projectId = msg.payload;
          try {
            const projects = await deps.client.listProjects();
            const matched = projects.find(p => p.id === projectId);
            if (!matched) {
              vscode.window.showErrorMessage(`VibeFlow: project ${projectId} not found`);
              break;
            }
            // Preserve the workspace's git remote/branch — we're switching
            // the linked project, not the workspace itself.
            //
            // gitBranch must come from the live workspace, NOT from the
            // cached DetectedProject: getCachedProject() always returns
            // gitBranch: '' because the cache schema (ContextProxy
            // GlobalStateSchema) doesn't persist the branch. Pre-fix this
            // path passed '' to connectToProject, which silently kept the
            // empty-state placeholder showing "main" forever.
            const previous = deps.detector.getCachedProject();
            const liveBranch = await deps.detector.getGitBranch();
            const detected: DetectedProject = {
              projectId: matched.id,
              projectName: matched.name,
              gitRemoteUrl: matched.git_remote_url ?? previous?.gitRemoteUrl ?? '',
              gitBranch: liveBranch,
            };
            await deps.detector.cacheProject(detected);
            deps.onProjectSwitched?.(detected);
            vscode.window.showInformationMessage(`VibeFlow: Switched to project "${matched.name}"`);
            await pushSettings();
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`VibeFlow: project switch failed — ${errMsg}`);
          }
          break;
        }
        case 'updateStickyModel':
          if (!deps.stickyModels) {
            vscode.window.showWarningMessage('VibeFlow: model preferences are not initialized');
            break;
          }
          await deps.stickyModels.setModel(msg.payload.persona, msg.payload.model);
          await pushSettings();
          break;
        case 'resetStickyModel':
          if (!deps.stickyModels) {
            vscode.window.showWarningMessage('VibeFlow: model preferences are not initialized');
            break;
          }
          await deps.stickyModels.resetToDefault(msg.payload.persona);
          await pushSettings();
          break;
        case 'runCommand':
          // Generic command passthrough — used by buttons in tabs that
          // shouldn't need their own wire shape (e.g. CLI tab "Open
          // CLI"). The command must already be registered on the
          // extension; we don't sanitize beyond that because the
          // webview is host-controlled.
          await vscode.commands.executeCommand(msg.payload);
          break;
        default:
          assertNever(msg);
      }
    });

    panel.onDidDispose(() => {
      SettingsPanel.instance = undefined;
    });

    SettingsPanel.instance = panel;
  }
}

/**
 * Build the snapshot the SettingsView consumes. Reads project list from
 * the server when a client is wired so the dropdown actually populates;
 * otherwise returns an empty list and the UI degrades to "no project
 * selected".
 */
async function buildSettingsPayload(deps: SettingsPanelDeps): Promise<Record<string, unknown>> {
  const config = vscode.workspace.getConfiguration('vibeflow');
  const cached = deps.detector?.getCachedProject();

  let projects: { id: number; name: string }[] = [];
  let apiKeyValid: boolean | null = null;
  if (deps.client) {
    try {
      const list = await deps.client.listProjects();
      projects = list.map(p => ({ id: p.id, name: p.name }));
      apiKeyValid = true;
    } catch {
      // Network or auth failure — leave projects empty, surface as "API
      // key not validated" rather than a hard error.
      apiKeyValid = false;
    }
  }

  return {
    serverUrl: config.get('serverUrl', 'https://cloud.axiomstudio.ai'),
    serverReachable: null,
    apiKeySet: !!deps.authService?.getToken(),
    apiKeyValid,
    projectId: cached?.projectId ?? null,
    projectName: cached?.projectName ?? null,
    projects,
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
    // Models tab data — empty objects when stickyModels isn't wired
    // so the tab can still render its empty-state UI.
    stickyModels: deps.stickyModels?.getAll() ?? {},
    knownModels: KNOWN_MODELS,
    // CLI Interface — toggle drives whether session launches go through
    // the per-persona TerminalRegistry path or are delegated to the
    // vibeflow CLI's TUI. cliInstalled is computed eagerly so the tab
    // can render install guidance without an extra round-trip.
    cliEnabled: config.get('cli.enabled', false),
    cliBinaryPath: config.get('cli.binaryPath', ''),
    cliInstalled: isVibeflowInstalled(),
    version: '0.1.0',
  };
}
