import * as vscode from 'vscode';
import { getNonce } from '../../utils/nonce.js';
import type { VibeFlowClient } from '../../api/client.js';
import {
  assertNever,
  type CloudRunnerManageClientMessage,
  type CloudRunnerManageHostMessage,
  type CloudRunnerManageState,
  type ManageLaunchConfig,
} from '../../core/webviewMessages.js';
import {
  routeInitialStep,
  firstPresent,
  isPodReady,
  authCompletesAutomatically,
  buildRunnerManifest,
  runnerActionErrorMessage,
  manifestToSavedConfig,
} from '../../api/cloudRunners.js';
import { openRunnerTerminal } from './CloudRunnerTerminal.js';

const STATUS_POLL_MS = 3000;
const HEALTH_POLL_MS = 3000;
const HEALTH_POLL_MAX = 20;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * The Cloud Runner **Manage** wizard (#2817, spec #435/#436 §4) — one webview
 * per (project, runner) that authenticates (device-code OAuth), configures, and
 * launches a vibeflow session on the runner pod. The host owns all async work
 * (hydrate, status/health polling) and pushes a single {@link CloudRunnerManageState}
 * snapshot; the webview is presentational and replies with intents.
 *
 * Security: LOCAL ids only; the launch manifest is built host-side with
 * `${VAULT:...}` placeholders (never a real secret); reuses `client.request()`.
 */
export class CloudRunnerManagePanel {
  private static readonly panels = new Map<string, CloudRunnerManagePanel>();

  private disposed = false;
  private statusPolling = false;
  private state: CloudRunnerManageState;
  /**
   * OAuth login method from the runner detail (spec #433 §7.3) — carried into
   * the launch manifest like the web's `detail.loginMethod`. Host-side only;
   * the Configure UI never re-asks it.
   */
  private runnerLoginMethod = '';

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly client: VibeFlowClient,
    private readonly projectId: number,
    private readonly runnerId: number,
    runnerName: string,
  ) {
    this.state = {
      step: 'configure',
      runnerName,
      agentType: '',
      authMode: '',
      authenticated: false,
      configured: false,
      podStatus: '',
      podReady: false,
      needsPasteBack: true,
      repos: [],
      agentProjects: [],
      gitProviders: [],
      defaultProject: '',
      launching: false,
      busy: true,
    };
  }

  private static key(projectId: number, runnerId: number): string {
    return `${projectId}:${runnerId}`;
  }

  static open(
    extensionUri: vscode.Uri,
    client: VibeFlowClient,
    projectId: number,
    runnerId: number,
    runnerName: string,
  ): void {
    const key = CloudRunnerManagePanel.key(projectId, runnerId);
    const existing = CloudRunnerManagePanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'vibeflow.cloudRunnerManage',
      `Manage — ${runnerName}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'webview-ui', 'dist')],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'vibeflow-icon.svg');
    panel.webview.html = renderHtml(panel.webview, extensionUri);

    const instance = new CloudRunnerManagePanel(panel, client, projectId, runnerId, runnerName);
    CloudRunnerManagePanel.panels.set(key, instance);
    instance.attach();
  }

  private attach(): void {
    this.panel.webview.onDidReceiveMessage((msg: CloudRunnerManageClientMessage) => this.handleMessage(msg));
    this.panel.onDidDispose(() => {
      this.disposed = true;
      CloudRunnerManagePanel.panels.delete(CloudRunnerManagePanel.key(this.projectId, this.runnerId));
    });
  }

  private async handleMessage(msg: CloudRunnerManageClientMessage): Promise<void> {
    switch (msg.type) {
      case 'manageLoad':
        await this.hydrate();
        return;
      case 'manageStartOAuth':
        await this.startOAuth();
        return;
      case 'manageSubmitOAuth':
        await this.submitOAuth(msg.payload.code);
        return;
      case 'manageClone':
        await this.clone(msg.payload);
        return;
      case 'manageLaunch':
        await this.launch(msg.payload);
        return;
      case 'manageAdvance':
        this.state.step = msg.payload.step;
        this.push();
        if (msg.payload.step === 'configure') { void this.loadConfigureData(); }
        if (msg.payload.step === 'authenticate') { void this.pollStatus(); }
        return;
      case 'manageOpenTerminal':
        openRunnerTerminal(this.client, this.projectId, this.runnerId, this.state.runnerName);
        return;
      default:
        assertNever(msg);
    }
  }

  /** Parallel, failure-tolerant hydrate → route to the initial step (#436 §4.0). */
  private async hydrate(): Promise<void> {
    this.state.busy = true;
    this.push();
    const [runner, status, manifest] = await Promise.all([
      this.client.getCloudRunner(this.projectId, this.runnerId).catch(() => undefined),
      this.client.getRunnerStatus(this.projectId, this.runnerId).catch(() => undefined),
      this.client.getRunnerManifest(this.projectId, this.runnerId).catch(() => undefined),
    ]);
    if (this.disposed) { return; }

    // Pre-fill Configure from the saved manifest only when the runner is
    // already configured (web parity, #2885) — a fresh runner keeps defaults.
    this.state.savedConfig = status?.configured ? manifestToSavedConfig(manifest) : undefined;

    this.state.agentType = runner?.agentType ?? '';
    this.state.authMode = runner?.authMode ?? '';
    this.runnerLoginMethod = runner?.loginMethod ?? '';
    this.state.authenticated = status?.authenticated ?? false;
    this.state.configured = status?.configured ?? false;
    this.state.podStatus = status?.podStatus ?? runner?.podStatus ?? '';
    this.state.podReady = isPodReady(this.state.podStatus);
    this.state.needsPasteBack = !authCompletesAutomatically(this.state.agentType);
    this.state.step = routeInitialStep({
      authenticated: this.state.authenticated,
      configured: this.state.configured,
      authMode: this.state.authMode,
      // authenticating → auth workflow even if the relay dropped authMode (#437).
      status: status?.status ?? runner?.status,
    });
    this.state.busy = false;
    this.state.error = undefined;
    this.push();

    if (this.state.step === 'authenticate') { void this.pollStatus(); }
    else { void this.loadConfigureData(); }
  }

  private async startOAuth(): Promise<void> {
    if (!this.state.podReady) { return; } // gate the device-code start (#436 §4.1)
    try {
      const start = await this.client.getRunnerOAuthStart(this.projectId, this.runnerId);
      if (this.disposed) { return; }
      this.state.oauthUrl = firstPresent(start.url, start.verificationUrl, start.verification_url);
      this.state.oauthCode = firstPresent(start.code, start.userCode, start.user_code);
      this.push();
    } catch (err) {
      this.showError(err);
    }
  }

  private async submitOAuth(code: string): Promise<void> {
    this.state.busy = true;
    this.push();
    try {
      await this.client.submitRunnerOAuth(this.projectId, this.runnerId, code);
    } catch (err) {
      this.showError(err);
      return;
    }
    this.state.busy = false;
    this.push();
    void this.pollStatus(); // re-poll; advance to configure on authenticated
  }

  /** Poll live status while on the Authenticate step; auto-advance when authed. */
  private async pollStatus(): Promise<void> {
    if (this.statusPolling) { return; }
    this.statusPolling = true;
    try {
      while (!this.disposed && this.state.step === 'authenticate') {
        await delay(STATUS_POLL_MS);
        if (this.disposed || this.state.step !== 'authenticate') { return; }
        try {
          const s = await this.client.getRunnerStatus(this.projectId, this.runnerId);
          this.state.authenticated = s.authenticated ?? false;
          this.state.podStatus = s.podStatus ?? this.state.podStatus;
          this.state.podReady = isPodReady(this.state.podStatus);
          if (this.state.authenticated) {
            this.state.step = 'configure';
            this.push();
            void this.loadConfigureData();
            return;
          }
          this.push();
        } catch {
          // transient (409 not-provisioned / pod DNS) — keep polling
        }
      }
    } finally {
      this.statusPolling = false;
    }
  }

  private async loadConfigureData(): Promise<void> {
    const [repos, projects, providers] = await Promise.all([
      this.client.listRunnerRepos(this.projectId, this.runnerId).catch(() => []),
      this.client.listRunnerAgentProjects(this.projectId, this.runnerId).catch(() => []),
      this.client.listGitProviders().catch(() => []),
    ]);
    if (this.disposed) { return; }
    this.state.repos = repos.map(r => ({ name: r.name, path: r.path, branch: r.branch }));
    this.state.agentProjects = projects;
    this.state.gitProviders = providers.map(p => ({ id: p.id, name: p.name }));
    if (!this.state.defaultProject) { this.state.defaultProject = projects[0] ?? ''; }
    this.push();
  }

  private async clone(payload: { gitProviderId?: number; url: string; branch: string }): Promise<void> {
    this.state.busy = true;
    this.push();
    try {
      // Inject credentials BEFORE the clone so a private repo can authenticate.
      if (payload.gitProviderId) {
        await this.client.injectRunnerGitCredentials(this.projectId, this.runnerId, payload.gitProviderId);
      }
      await this.client.cloneRunnerRepo(this.projectId, this.runnerId, { url: payload.url, branch: payload.branch });
    } catch (err) {
      this.showError(err);
      return;
    }
    this.state.busy = false;
    this.push();
    await this.loadConfigureData();
  }

  private async launch(cfg: ManageLaunchConfig): Promise<void> {
    const manifest = buildRunnerManifest({
      agentType: this.state.agentType || 'claude',
      authMode: this.state.authMode || 'oauth',
      loginMethod: this.runnerLoginMethod || undefined,
      model: cfg.model || undefined,
      project: cfg.project,
      personas: cfg.personas,
      sessionType: cfg.sessionType,
      workingDir: cfg.workingDir,
      branch: cfg.branch,
      worktree: cfg.worktree,
      newBranch: cfg.newBranch,
      llmGateway: cfg.llmGateway,
      skipPermissions: cfg.skipPermissions,
    });
    this.state.step = 'launch';
    this.state.launching = true;
    this.state.launchPhase = undefined;
    this.state.launchErrors = undefined;
    this.state.error = undefined;
    this.push();
    try {
      await this.client.putRunnerManifest(this.projectId, this.runnerId, manifest);
    } catch (err) {
      this.state.launching = false;
      this.showError(err);
      return;
    }
    await this.pollHealth();
  }

  private async pollHealth(): Promise<void> {
    for (let i = 0; i < HEALTH_POLL_MAX && !this.disposed; i++) {
      await delay(HEALTH_POLL_MS);
      if (this.disposed) { return; }
      try {
        const h = await this.client.getRunnerHealth(this.projectId, this.runnerId);
        this.state.launchPhase = h.phase;
        this.state.launchErrors = h.errors;
        if (h.phase === 'running' || h.phase === 'error') {
          this.state.launching = false;
          this.push();
          return;
        }
        this.push();
      } catch {
        // transient — keep polling
      }
    }
    if (!this.disposed) {
      this.state.launching = false;
      this.state.launchPhase = this.state.launchPhase ?? 'timeout';
      this.push();
    }
  }

  private showError(err: unknown): void {
    const status = (err as { status?: number }).status;
    const text = err instanceof Error ? err.message : String(err);
    this.state.busy = false;
    this.state.error = runnerActionErrorMessage(status, text);
    this.push();
  }

  private push(): void {
    if (this.disposed) { return; }
    const msg: CloudRunnerManageHostMessage = { type: 'manageState', payload: this.state };
    void this.panel.webview.postMessage(msg);
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
  <title>Manage Cloud Runner</title>
</head>
<body data-vf-mode="cloudRunnerManage">
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
