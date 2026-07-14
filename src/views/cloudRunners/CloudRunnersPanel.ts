import * as vscode from 'vscode';
import { getNonce } from '../../utils/nonce.js';
import type { VibeFlowClient } from '../../api/client.js';
import type { PollingCoordinator, Disposer } from '../../core/PollingCoordinator.js';
import { backgroundIntervalMs } from '../../core/pollingConfig.js';
import {
  assertNever,
  type CloudRunnerListRow,
  type CloudRunnersClientMessage,
  type CloudRunnersHostMessage,
} from '../../core/webviewMessages.js';
import { runnerActionErrorMessage, isRunnerTransitioning } from '../../api/cloudRunners.js';

const SETTLE_POLL_MS = 3000;
const SETTLE_POLL_MAX = 10;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Cloud Runners TABLE panel (feature #603) — a single webview (one instance)
 * listing the runners of the CURRENT workspace project (#2825 — the extension
 * always operates in project context, so the page is project-scoped, not the
 * cross-project global list). Opened from the flag-gated "Cloud Runners" row
 * in the Browse nav. Mirrors the TicketsPanel host pattern (load-on-mount,
 * refresh-on-becoming-visible). Rows are enriched with each provisioned pod's
 * cloned repos (member-readable `GET .../repos` fan-out, failure-tolerant) so
 * the table can show Repository/Branch alongside the owning user.
 */
export class CloudRunnersPanel {
  private static instance: CloudRunnersPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private lastFetchAt = 0;
  private disposed = false;
  private pollSub: Disposer | undefined;
  private settling = false; // a post-action settle-poll owns the refresh cadence

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly client: VibeFlowClient,
    private readonly projectId: number,
    private readonly coordinator: PollingCoordinator,
  ) {
    this.panel = panel;
  }

  static open(extensionUri: vscode.Uri, client: VibeFlowClient, projectId: number, projectName: string, coordinator: PollingCoordinator): void {
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

    const instance = new CloudRunnersPanel(panel, client, projectId, coordinator);
    CloudRunnersPanel.instance = instance;
    instance.attach();
  }

  /** Reload the panel if it is currently open (e.g. after a runner is created). */
  static refresh(): void {
    void CloudRunnersPanel.instance?.load();
  }

  private attach(): void {
    this.panel.webview.onDidReceiveMessage((msg: CloudRunnersClientMessage) => this.handleMessage(msg));
    this.panel.onDidChangeViewState(e => {
      if (!e.webviewPanel.visible) { return; }
      // Debounce a becoming-visible refresh so tab-flipping doesn't spam the API.
      if (Date.now() - this.lastFetchAt < 1000) { return; }
      void this.load();
    });
    // Ambient auto-refresh (#2892) — the shared coordinator pauses on window
    // blur and dedups in-flight fetches, so a runner changing state on its own
    // (reconciler, another client) shows up without a manual refresh. Silent:
    // background poll failures must not raise error banners. Skipped while a
    // post-action settle-poll already owns the cadence.
    this.pollSub = this.coordinator.subscribe(backgroundIntervalMs(), () => {
      if (this.panel.visible && !this.settling) { void this.load(true); }
    }, 'cloud-runners');
    this.panel.onDidDispose(() => {
      this.disposed = true;
      this.pollSub?.dispose();
      this.pollSub = undefined;
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
      case 'cloudRunnersCreate':
        // The create flow lives in the vibeflow.createCloudRunner command
        // (#2894) — running it here would cycle the panel↔command import.
        await vscode.commands.executeCommand('vibeflow.createCloudRunner');
        await this.load();
        return;
      case 'cloudRunnerStart':
      case 'cloudRunnerStop': {
        const { projectId, id } = msg.payload;
        try {
          if (msg.type === 'cloudRunnerStart') {
            await this.client.startCloudRunner(projectId, id);
          } else {
            await this.client.stopCloudRunner(projectId, id);
          }
        } catch (err) {
          this.showActionError(err);
          await this.load();
          return;
        }
        await this.load(); // reflect the optimistic starting/stopping status
        void this.pollUntilSettled(projectId, id); // then track the reconciler
        return;
      }
      case 'cloudRunnerDelete': {
        const { projectId, id, name } = msg.payload;
        const confirm = await vscode.window.showWarningMessage(
          `Delete runner "${name}"? This removes the Studio runner.`,
          { modal: true },
          'Delete',
        );
        if (confirm !== 'Delete') { return; }
        try {
          await this.client.deleteCloudRunner(projectId, id);
          vscode.window.showInformationMessage(`VibeFlow: cloud runner "${name}" deleted.`);
        } catch (err) {
          // A 404 means it's already gone — treat as success and just refresh.
          if ((err as { status?: number }).status !== 404) {
            this.showActionError(err);
          }
        }
        await this.load();
        return;
      }
      case 'cloudRunnerManage': {
        await vscode.commands.executeCommand(
          'vibeflow.openCloudRunnerManage',
          msg.payload.projectId,
          msg.payload.id,
          msg.payload.name,
        );
        return;
      }
      case 'cloudRunnerBulkStart':
      case 'cloudRunnerBulkStop': {
        const runners = msg.payload.runners;
        if (runners.length === 0) { return; }
        const start = msg.type === 'cloudRunnerBulkStart';
        const verb = start ? 'start' : 'stop';
        const results = await Promise.allSettled(runners.map(r =>
          start ? this.client.startCloudRunner(r.projectId, r.id) : this.client.stopCloudRunner(r.projectId, r.id),
        ));
        this.reportBulk(verb, results);
        await this.load();
        // Track the reconciler for each runner that accepted the action.
        runners.forEach((r, i) => { if (results[i].status === 'fulfilled') { void this.pollUntilSettled(r.projectId, r.id); } });
        return;
      }
      case 'cloudRunnerBulkDelete': {
        const runners = msg.payload.runners;
        if (runners.length === 0) { return; }
        const names = runners.map(r => r.name).join(', ');
        const confirm = await vscode.window.showWarningMessage(
          `Delete ${runners.length} runner${runners.length === 1 ? '' : 's'} (${names})? This removes the Studio runners.`,
          { modal: true },
          'Delete',
        );
        if (confirm !== 'Delete') { return; }
        const results = await Promise.allSettled(runners.map(async r => {
          try {
            await this.client.deleteCloudRunner(r.projectId, r.id);
          } catch (err) {
            // A 404 means it's already gone — treat as success.
            if ((err as { status?: number }).status === 404) { return; }
            throw err;
          }
        }));
        this.reportBulk('delete', results);
        await this.load();
        return;
      }
      default:
        assertNever(msg);
    }
  }

  /** Summarize a bulk fan-out: "N started · M failed" toast (#2893). */
  private reportBulk(verb: string, results: PromiseSettledResult<unknown>[]): void {
    const ok = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.length - ok;
    const past = verb === 'stop' ? 'stopped' : `${verb}d`; // start→started, delete→deleted, stop→stopped
    if (failed === 0) {
      vscode.window.showInformationMessage(`VibeFlow: ${ok} runner${ok === 1 ? '' : 's'} ${past}.`);
      return;
    }
    // Surface one representative error via the shared mapper.
    const firstErr = results.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined;
    const status = (firstErr?.reason as { status?: number } | undefined)?.status;
    const text = firstErr?.reason instanceof Error ? firstErr.reason.message : String(firstErr?.reason ?? '');
    vscode.window.showWarningMessage(
      `VibeFlow: ${ok} ${past}, ${failed} failed — ${runnerActionErrorMessage(status, text)}`,
    );
  }

  /** Surface a start/stop/delete failure as a toast (keeps the table intact). */
  private showActionError(err: unknown): void {
    const status = (err as { status?: number }).status;
    const text = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`VibeFlow: ${runnerActionErrorMessage(status, text)}`);
  }

  /**
   * After a start/stop, poll the runner's live status and reload the panel as
   * the leader-only reconciler settles it (~15–30s). Stops early once the
   * runner is no longer transitioning, on timeout, or if the panel is disposed.
   */
  private async pollUntilSettled(projectId: number, id: number): Promise<void> {
    this.settling = true; // suppress ambient polling while we own the cadence
    try {
      for (let i = 0; i < SETTLE_POLL_MAX && !this.disposed; i++) {
        await delay(SETTLE_POLL_MS);
        if (this.disposed) { return; }
        let settled = false;
        try {
          const s = await this.client.getRunnerStatus(projectId, id);
          settled = !!s.status && !isRunnerTransitioning(s.status);
        } catch {
          // Transient (e.g. 409 not-provisioned-yet) — keep polling.
        }
        if (this.disposed) { return; }
        await this.load();
        if (settled) { return; }
      }
    } finally {
      this.settling = false;
    }
  }

  /**
   * Reload the table. `silent` (ambient poll) suppresses the error banner so a
   * transient background failure doesn't disrupt the user (#2892).
   */
  private async load(silent = false): Promise<void> {
    this.lastFetchAt = Date.now();
    try {
      const runners = await this.client.listProjectCloudRunners(this.projectId);
      // Enrich each provisioned runner with its cloned repos so the table can
      // show Repository/Branch. Failure-tolerant per row: an unprovisioned
      // pod 409s and a stopped pod may 502 — the row still renders with dashes.
      const rows: CloudRunnerListRow[] = await Promise.all(runners.map(async r => {
        if (!r.studioRunnerId) { return r; }
        try {
          const repos = await this.client.listRunnerRepos(this.projectId, r.id);
          return { ...r, repos };
        } catch {
          return r;
        }
      }));
      this.post({ type: 'cloudRunnersData', payload: { runners: rows, generatedAt: new Date().toISOString() } });
    } catch (err) {
      if (silent) { return; } // background poll — don't surface a banner
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
