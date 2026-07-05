import * as vscode from 'vscode';
import { getNonce } from '../../utils/nonce.js';
import type { AuthService } from '../../auth/AuthService.js';
import type { VibeFlowClient } from '../../api/client.js';
import type { CreateGitProviderRequest } from '../../api/types.js';
import type { ProjectDetector, DetectedProject } from '../../project/ProjectDetector.js';
import { StickyModels, KNOWN_MODELS } from '../../sessions/stickyModels.js';
import { assertNever, type SettingsClientMessage, type SettingsHostMessage } from '../../core/webviewMessages.js';
import { validateServerUrl } from '../../auth/serverUrl.js';
import { isVibeflowInstalled, getCliVersion, staleCliBinaryPath, logCli } from '../../commands/cliCommands.js';
import { persistEffectiveSetting } from './settingsPersistence.js';
import { setCloudRunnerDebug, isCloudRunnerDebugEnabled } from '../../util/cloudRunnerLog.js';
import { mcpAgentStatuses } from '../../commands/cliBootstrap.js';
import { isBinaryOnPath } from '../../utils/whichBinary.js';
import { confirmAndCloseTabsForProjectSwitch } from '../../commands/projectCommands.js';

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
   * Per-machine encrypted store (`vscode.ExtensionContext.secrets`). The
   * Providers tab uses this to persist per-provider env tokens
   * (`MCP_TOKEN`, `GEMINI_API_KEY`) so the launch wizard can pre-fill them
   * instead of re-prompting on every spawn.
   */
  secrets?: vscode.SecretStorage;
  /**
   * Callback invoked after the user picks a different project from the
   * Settings dropdown. extension.ts wires this to its connectToProject
   * helper so trees, pollers, panels all rebind to the new id without a
   * window reload.
   */
  onProjectSwitched?: (project: DetectedProject) => void;
}

/**
 * Provider key → env-var name. Codex uses `MCP_TOKEN` (per the agent
 * binary's CLI contract); Gemini uses `GEMINI_API_KEY`. Kept as a single
 * source of truth so the message handlers and the snapshot reader can't
 * drift on the literal string. Returning undefined means the provider
 * has no env-token surface (claude, cursor) and the UI hides the row.
 */
function providerEnvName(provKey: string): string | undefined {
  switch (provKey) {
    case 'codex': return 'MCP_TOKEN';
    case 'gemini': return 'GEMINI_API_KEY';
    default: return undefined;
  }
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

    /**
     * Fetch the caller's git providers and push them to the Git Configuration
     * tab (feature #603). Called on the tab's initial `gitProvidersList` and
     * after every create/rename/delete so the list reflects the mutation.
     * Failures surface in-band (the tab renders `payload.error`) — never thrown.
     */
    const refreshGitProviders = async () => {
      if (!deps.client) {
        postToWebview({ type: 'gitProvidersData', payload: { providers: [], error: 'Not connected — sign in first.' } });
        return;
      }
      try {
        const providers = await deps.client.listGitProviders();
        postToWebview({ type: 'gitProvidersData', payload: { providers } });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        postToWebview({ type: 'gitProvidersData', payload: { providers: [], error: message } });
      }
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

          // #3398: cloudRunners.debug persists via globalState, NOT
          // config.update() — VS Code rejects programmatic writes of keys
          // whose contributes.configuration registration hasn't been
          // installed yet ("not a registered configuration").
          if (key === 'cloudRunners.debug') {
            await setCloudRunnerDebug(value === true);
            break;
          }

          const config = vscode.workspace.getConfiguration('vibeflow');

          // Route to the right storage based on key. Keep this list in
          // sync with the schema entries in package.json — keys not listed
          // here silently no-op, which is what bit us on worktree.* and
          // notifications.workItemComplete during the settings audit.
          const settingsKeys = [
            'serverUrl', 'defaultProvider', 'polling.interval', 'polling.liveInterval',
            'notifications.agentPrompts', 'notifications.workItemComplete',
            'session.terminalMode', 'session.headlessBacking',
            'worktree.baseDir', 'worktree.autoCreate', 'worktree.cleanupOnKill',
            'cli.enabled', 'cli.binaryPath', 'cli.mcpName', 'cli.rootPath',
            'chat.diffView',
          ];

          if (settingsKeys.includes(key)) {
            // Persist so the write is EFFECTIVE: also clears any workspace-level
            // override that would otherwise mask the Global write (#3343), and
            // surfaces failures instead of dying as an unhandled rejection while
            // the webview's optimistic update papers over them.
            try {
              const cleared = await persistEffectiveSetting(config, key, value);
              if (key.startsWith('cli.')) {
                logCli(`persisted vibeflow.${key} = ${JSON.stringify(value)} (user settings${cleared.length ? `; removed masking ${cleared.join(' + ')} override` : ''})`);
              }
              if (cleared.length > 0) {
                vscode.window.showInformationMessage(
                  `VibeFlow: removed a ${cleared.join(' and ')} settings override for vibeflow.${key} so your change takes effect.`,
                );
              }
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              if (key.startsWith('cli.')) {
                logCli(`FAILED to persist vibeflow.${key}: ${errMsg}`);
              }
              vscode.window.showWarningMessage(`VibeFlow: failed to save vibeflow.${key} — ${errMsg}`);
            }
            // Only re-push the snapshot for keys whose webview rendering
            // depends on DERIVED state — recomputing the snapshot on
            // every keystroke for a plain text input races the user's
            // typing (the post-key snapshot lands after they've typed
            // more, overwriting the in-progress value). The optimistic
            // update on the React side via CONFIG_KEY_TO_FIELD already
            // keeps controls in sync for plain config values.
            //
            // Keys with derived state today:
            //   - cli.binaryPath → recomputes `cliInstalled` via which/where
            //   - serverUrl, defaultProvider currently have no derived
            //     state in the snapshot, but we leave them in the list
            //     so the test/validate buttons can still trigger
            //     fresh data when wired in the future.
            const derivedStateKeys = new Set(['cli.binaryPath']);
            if (derivedStateKeys.has(key)) {
              await pushSettings();
            }
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
          const envName = providerEnvName(provKey);
          if (!envName) {
            vscode.window.showWarningMessage(`VibeFlow: provider ${provKey} has no env-token surface`);
            break;
          }
          if (!deps.secrets) {
            vscode.window.showWarningMessage('VibeFlow: secret storage unavailable — token not saved');
            break;
          }
          const token = await vscode.window.showInputBox({
            prompt: `Enter ${envName}`,
            placeHolder: envName,
            password: true,
            ignoreFocusOut: true,
          });
          if (token === undefined) {
            // User cancelled — don't touch storage.
            break;
          }
          if (token === '') {
            // Treat empty input as a clear to keep keyboard-only flows
            // viable (Enter on empty == clear).
            await deps.secrets.delete(envName);
            vscode.window.showInformationMessage(`VibeFlow: ${envName} cleared`);
          } else {
            await deps.secrets.store(envName, token);
            vscode.window.showInformationMessage(`VibeFlow: ${envName} saved`);
          }
          await pushSettings();
          break;
        }
        case 'clearProviderToken': {
          const provKey = msg.payload.provider;
          const envName = providerEnvName(provKey);
          if (!envName || !deps.secrets) {
            break;
          }
          await deps.secrets.delete(envName);
          vscode.window.showInformationMessage(`VibeFlow: ${envName} cleared`);
          await pushSettings();
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
            await confirmAndCloseTabsForProjectSwitch(previous, matched.id);
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
        case 'openCli': {
          const config = vscode.workspace.getConfiguration('vibeflow');
          const launchOptions = {
            mcpName: msg.payload.mcpName,
            rootPath: msg.payload.rootPath,
          };
          try {
            const cleared = [
              ...await persistEffectiveSetting(config, 'cli.mcpName', launchOptions.mcpName),
              ...await persistEffectiveSetting(config, 'cli.rootPath', launchOptions.rootPath),
            ];
            logCli(`persisted launch options before open (mcp=${JSON.stringify(launchOptions.mcpName)}, root=${JSON.stringify(launchOptions.rootPath)})${cleared.length ? ` — removed masking ${cleared.join(' + ')} override(s)` : ''}`);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            logCli(`FAILED to persist launch options before open: ${errMsg}`);
            vscode.window.showWarningMessage(`VibeFlow: Open CLI settings were not saved — ${errMsg}`);
          }
          await vscode.commands.executeCommand('vibeflow.openCli', launchOptions);
          await pushSettings();
          break;
        }
        case 'gitProvidersList':
          await refreshGitProviders();
          break;
        case 'gitProviderCreate': {
          if (!deps.client) {
            vscode.window.showWarningMessage('VibeFlow: not connected — sign in first');
            break;
          }
          // Per #3389 (user chose the inline-form design) the webview collects
          // the secret and sends it in the payload. Forward it straight to the
          // server. NEVER log msg.payload — it holds accessToken/sshPrivateKey.
          const { name, authType, userName, accessToken, sshPrivateKey } = msg.payload;
          const gitUrl = msg.payload.gitUrl?.trim() || 'https://github.com';
          const body: CreateGitProviderRequest = { name, gitUrl, authType };
          if (authType === 'pat') {
            if (!accessToken) {
              vscode.window.showWarningMessage('VibeFlow: an access token is required');
              break;
            }
            if (userName) { body.userName = userName; }
            body.accessToken = accessToken;
          } else {
            if (!sshPrivateKey) {
              vscode.window.showWarningMessage('VibeFlow: an SSH private key is required');
              break;
            }
            body.sshPrivateKey = sshPrivateKey;
          }
          try {
            await deps.client.createGitProvider(body);
            vscode.window.showInformationMessage(`VibeFlow: git configuration "${name}" saved`);
            postToWebview({ type: 'gitProviderCreateResult', payload: { ok: true } });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`VibeFlow: could not save git configuration — ${message}`);
            // Surface the failure inline too — a toast is easy to miss, and the
            // form having cleared can read as success (#3393).
            postToWebview({ type: 'gitProviderCreateResult', payload: { ok: false, error: message } });
          }
          await refreshGitProviders();
          break;
        }
        case 'gitProviderRename': {
          if (!deps.client) {
            vscode.window.showWarningMessage('VibeFlow: not connected — sign in first');
            break;
          }
          try {
            await deps.client.renameGitProvider(msg.payload.id, msg.payload.name);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`VibeFlow: rename failed — ${message}`);
          }
          await refreshGitProviders();
          break;
        }
        case 'gitProviderDelete': {
          if (!deps.client) {
            vscode.window.showWarningMessage('VibeFlow: not connected — sign in first');
            break;
          }
          const confirm = await vscode.window.showWarningMessage(
            `Delete git configuration "${msg.payload.name}"? This removes the stored credentials.`,
            { modal: true },
            'Delete',
          );
          if (confirm !== 'Delete') { break; }
          try {
            await deps.client.deleteGitProvider(msg.payload.id);
            vscode.window.showInformationMessage(`VibeFlow: git configuration "${msg.payload.name}" deleted`);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`VibeFlow: delete failed — ${message}`);
          }
          await refreshGitProviders();
          break;
        }
        case 'runCommand':
          // Generic command passthrough — used by buttons in tabs that
          // shouldn't need their own wire shape (e.g. CLI tab "Open
          // CLI"). The command must already be registered on the
          // extension; we don't sanitize beyond that because the
          // webview is host-controlled.
          await vscode.commands.executeCommand(msg.payload);
          // The command may have changed derived state the tab renders
          // (cliInstalled/cliVersion after installCli, mcpAgents after
          // bootstrap/uninstall) — re-push so the panel reflects it live.
          await pushSettings();
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

  // Per-provider env-token presence — read from Secrets API. Empty (or
  // missing) means "Not set"; any non-empty stored value flips to "Set".
  // Only providers with an env-token surface are queried.
  const codexTokenSet = !!(deps.secrets && (await deps.secrets.get('MCP_TOKEN')));
  const geminiTokenSet = !!(deps.secrets && (await deps.secrets.get('GEMINI_API_KEY')));

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
      { key: 'claude', name: 'Claude Code', binary: 'claude', available: isBinaryOnPath('claude'), vibeflowIntegrated: true, envTokenSet: false },
      { key: 'codex', name: 'OpenAI Codex CLI', binary: 'codex', available: isBinaryOnPath('codex'), vibeflowIntegrated: false, envTokenName: 'MCP_TOKEN', envTokenSet: codexTokenSet },
      { key: 'gemini', name: 'Google Gemini CLI', binary: 'gemini', available: isBinaryOnPath('gemini'), vibeflowIntegrated: false, envTokenName: 'GEMINI_API_KEY', envTokenSet: geminiTokenSet },
      // Cursor's IDE-bundled binary is `cursor-agent`; some installs
      // alias it as `agent` (matches what sessionCommands.ts spawns).
      // Either being on PATH counts as available.
      { key: 'cursor', name: 'Cursor Agent', binary: 'agent', available: isBinaryOnPath('agent') || isBinaryOnPath('cursor-agent'), vibeflowIntegrated: true, envTokenSet: false },
    ],
    worktreeBaseDir: config.get('worktree.baseDir', '.claude/worktrees'),
    worktreeAutoCreate: config.get<boolean>('worktree.autoCreate', false),
    worktreeCleanupOnKill: config.get<'ask' | 'always' | 'never'>('worktree.cleanupOnKill', 'ask'),
    pollInterval: config.get('polling.interval', 30),
    liveInterval: config.get('polling.liveInterval', 5),
    notifyAgentPrompts: config.get('notifications.agentPrompts', true),
    notifyWorkComplete: config.get('notifications.workItemComplete', true),
    sessionTerminalMode: config.get('session.terminalMode', 'hybrid'),
    sessionHeadlessBacking: config.get<'auto' | 'tmux' | 'vscode'>('session.headlessBacking', 'auto'),
    chatDiffView: config.get<'unified' | 'split'>('chat.diffView', 'unified'),
    // Diagnostics (#3397/#3398): surfaced in the Settings webview because the
    // package.json declaration only registers on reinstall. State lives in
    // globalState (with a config-key fallback for manual settings.json edits).
    cloudRunnersDebug: isCloudRunnerDebugEnabled(),
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
    cliMcpName: config.get('cli.mcpName', ''),
    cliRootPath: config.get('cli.rootPath', ''),
    cliInstalled: isVibeflowInstalled(),
    cliVersion: getCliVersion() ?? null,
    cliBinaryPathStale: staleCliBinaryPath() ?? null,
    mcpAgents: mcpAgentStatuses(),
    version: vscode.extensions.getExtension('AxiomStudio.vscode-vibeflow')?.packageJSON?.version ?? 'unknown',
  };
}
