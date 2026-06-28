import * as vscode from 'vscode';
import { getNonce } from '../../utils/nonce.js';
import type { VibeFlowClient } from '../../api/client.js';
import type { PollingCoordinator, Disposer } from '../../core/PollingCoordinator.js';
import { assertNever, type KanbanClientMessage, type KanbanHostMessage } from '../../core/webviewMessages.js';
import { ALLOWED_PRIMARY_STATUSES, flattenForProject } from './kanbanData.js';

// Canonical message types live in src/core/webviewMessages.ts so each
// panel's protocol is documented in one place. Imported below.
// Column model + swimlane→card flattening live in ./kanbanData.ts (shared
// with the dashboard embed, DashboardPanel).

const POLL_INTERVAL_MS = 30_000;

/**
 * Kanban Board webview panel — drag-and-drop swimlane view scoped to the
 * current project. Singleton (one panel per window).
 */
export class KanbanPanel {
  private static instance: KanbanPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private pollSub: Disposer | undefined;
  // Throttle the mount-time `kanbanLoad` against the "became visible"
  // event so we don't fan out two consecutive swimlane fetches on open.
  private lastFetchAt = 0;
  // Auto-refresh cadence, tunable from the board's live control. `0` pauses
  // the timer (manual Refresh + focus-refetch still work). In-memory only —
  // resets to the default on reopen.
  private refreshIntervalMs: number = POLL_INTERVAL_MS;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly client: VibeFlowClient,
    private readonly projectId: number,
    private readonly projectName: string,
    private readonly coordinator: PollingCoordinator,
  ) {
    this.panel = panel;
  }

  static open(
    extensionUri: vscode.Uri,
    client: VibeFlowClient,
    projectId: number,
    projectName: string,
    coordinator: PollingCoordinator,
  ): void {
    if (KanbanPanel.instance) {
      KanbanPanel.instance.panel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'vibeflow.kanban',
      `VibeFlow Kanban — ${projectName}`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'webview-ui', 'dist')],
      },
    );

    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'vibeflow-icon.svg');
    panel.webview.html = renderHtml(panel.webview, extensionUri);

    const instance = new KanbanPanel(panel, client, projectId, projectName, coordinator);
    KanbanPanel.instance = instance;
    instance.attach();
  }

  private attach(): void {
    this.panel.webview.onDidReceiveMessage((msg: KanbanClientMessage) => this.handleMessage(msg));
    this.panel.onDidChangeViewState(e => {
      if (!e.webviewPanel.visible) { return; }
      if (Date.now() - this.lastFetchAt < 1000) { return; }
      void this.sendData();
    });
    this.panel.onDidDispose(() => this.dispose());
    // Initial load is triggered by the webview sending `kanbanLoad` on mount.
  }

  private async handleMessage(msg: KanbanClientMessage): Promise<void> {
    switch (msg.type) {
      case 'kanbanLoad':
        await this.sendData();
        this.startPolling();
        return;
      case 'kanbanRefresh':
        await this.sendData();
        return;
      case 'kanbanMove':
        await this.handleMove(msg.payload);
        return;
      case 'kanbanOpenItem':
        // Reuse the work item detail panel command. Tree-item ids are
        // "todo-{id}" / "issue-{id}" — mirror that string format here.
        vscode.commands.executeCommand(
          'vibeflow.openWorkItemPanel',
          `${msg.payload.itemType}-${msg.payload.itemId}`,
          msg.payload.title,
          '',
        );
        return;
      case 'kanbanSetRefreshInterval': {
        // Clamp to sane bounds: 0 (paused) or >= 5s so a typo can't hammer
        // the heavy org-wide swimlane. The webview only offers 0/10/30/60s.
        const ms = msg.payload.ms;
        this.refreshIntervalMs = ms <= 0 ? 0 : Math.max(5_000, ms);
        this.restartPolling();
        // Re-push immediately so the new cadence + generatedAt reach the UI.
        await this.sendData();
        return;
      }
      default:
        assertNever(msg);
    }
  }

  private async handleMove(payload: { itemType: 'todo' | 'issue'; itemId: number; newStatus: string }): Promise<void> {
    const { itemType, itemId, newStatus } = payload;

    if (!ALLOWED_PRIMARY_STATUSES.has(newStatus)) {
      vscode.window.showErrorMessage(
        `VibeFlow: Refused kanban move — "${newStatus}" is not a valid target column.`,
      );
      // Re-send fresh data so the webview snaps back.
      await this.sendData();
      return;
    }
    if (itemType !== 'todo' && itemType !== 'issue') {
      vscode.window.showErrorMessage(`VibeFlow: Refused kanban move — invalid item type.`);
      await this.sendData();
      return;
    }
    if (!Number.isFinite(itemId) || itemId <= 0) {
      vscode.window.showErrorMessage(`VibeFlow: Refused kanban move — invalid item id.`);
      await this.sendData();
      return;
    }

    try {
      if (itemType === 'todo') {
        await this.client.updateTodoStatus(itemId, newStatus);
      } else {
        await this.client.updateIssueStatus(itemId, newStatus);
      }
      // Reload to confirm the server-side state — agent claims, security
      // review gates, etc. can affect what actually persisted.
      await this.sendData();
    } catch (err) {
      vscode.window.showErrorMessage(
        `VibeFlow: Failed to move ${itemType} #${itemId} → ${newStatus} — ${err}`,
      );
      await this.sendData();
    }
  }

  private async sendData(): Promise<void> {
    this.lastFetchAt = Date.now();
    try {
      const swimlane = await this.client.getSwimlane();
      const cards = flattenForProject(swimlane, this.projectId);
      this.postToWebview({
        type: 'kanbanData',
        payload: {
          projectId: this.projectId,
          projectName: this.projectName,
          cards,
          // Drives the board's live "updated Ns ago · next in Ns" countdown.
          generatedAt: new Date().toISOString(),
          refreshIntervalMs: this.refreshIntervalMs,
        },
      });
    } catch (err) {
      this.postToWebview({
        type: 'kanbanError',
        payload: { message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  /** Typed wrapper so host/webview union drift fails the compile. */
  private postToWebview(msg: KanbanHostMessage): void {
    this.panel.webview.postMessage(msg);
  }

  private startPolling(): void {
    if (this.pollSub) { return; }
    if (this.refreshIntervalMs <= 0) { return; } // paused
    this.pollSub = this.coordinator.subscribe(this.refreshIntervalMs, () => {
      // Only poll while the panel is visible; postMessage to a hidden panel
      // is fine but wakes the webview's React tree unnecessarily.
      if (this.panel.visible) { void this.sendData(); }
    });
  }

  /** Tear down and re-arm the poll timer at the current cadence (or leave it
   *  off when paused). Called when the user changes the refresh interval. */
  private restartPolling(): void {
    this.pollSub?.dispose();
    this.pollSub = undefined;
    this.startPolling();
  }

  private dispose(): void {
    this.pollSub?.dispose();
    this.pollSub = undefined;
    if (KanbanPanel.instance === this) {
      KanbanPanel.instance = undefined;
    }
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
  <title>Kanban</title>
</head>
<body data-vf-mode="kanban">
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
