import * as vscode from 'vscode';
import { getNonce } from '../../utils/nonce.js';
import type { VibeFlowClient } from '../../api/client.js';
import type { VibeFlowSwimlaneItem, VibeFlowSwimlaneResult } from '../../api/types.js';
import { assertNever, type KanbanClientMessage, type KanbanHostMessage } from '../../core/webviewMessages.js';

/**
 * Five logical kanban columns mapped to the eight backend statuses.
 *
 * The swimlane endpoint returns 8 status arrays but eight columns are too
 * dense for a Kanban — we collapse the sub-statuses ("needs_pm_input",
 * "needs_ux_input", "architecture_review_complete") into their parent
 * columns and surface them as a sub-tag on each card. Dragging a card to a
 * column always moves it to the column's `primary` status — this keeps
 * drag-and-drop predictable and matches the PRD layout.
 */
export const KANBAN_COLUMNS: Array<{
  key: string;
  label: string;
  /** Status set whose items appear in this column. */
  statuses: string[];
  /** Status assigned when an item is dragged INTO this column. */
  primary: string;
}> = [
  { key: 'planning', label: 'Planning', statuses: ['planning', 'needs_pm_input', 'needs_ux_input'], primary: 'planning' },
  { key: 'ready', label: 'Ready', statuses: ['ready_to_implement', 'architecture_review_complete'], primary: 'ready_to_implement' },
  { key: 'implementing', label: 'In Progress', statuses: ['implementing'], primary: 'implementing' },
  { key: 'in_review', label: 'In Review', statuses: ['in_review'], primary: 'in_review' },
  { key: 'done', label: 'Done', statuses: ['done'], primary: 'done' },
];

/** Card payload sent to the webview — flattened from VibeFlowSwimlaneItem. */
export interface KanbanCard {
  type: 'todo' | 'issue';
  id: number;
  title: string;
  status: string;
  priority: string;
  featureName?: string;
  currentPersona?: string;
  securityReviewed: boolean;
  updatedAt: string;
}

// Canonical message types live in src/core/webviewMessages.ts so each
// panel's protocol is documented in one place. Imported below.

const POLL_INTERVAL_MS = 30_000;
/** Status set valid as a drag target — also enforced server-side. */
const ALLOWED_PRIMARY_STATUSES = new Set(KANBAN_COLUMNS.map(c => c.primary));

/**
 * Kanban Board webview panel — drag-and-drop swimlane view scoped to the
 * current project. Singleton (one panel per window).
 */
export class KanbanPanel {
  private static instance: KanbanPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
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
  ) {
    this.panel = panel;
  }

  static open(
    extensionUri: vscode.Uri,
    client: VibeFlowClient,
    projectId: number,
    projectName: string,
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

    const instance = new KanbanPanel(panel, client, projectId, projectName);
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
    if (this.pollTimer) { return; }
    if (this.refreshIntervalMs <= 0) { return; } // paused
    this.pollTimer = setInterval(() => {
      // Only poll while the panel is visible; postMessage to a hidden panel
      // is fine but wakes the webview's React tree unnecessarily.
      if (this.panel.visible) { void this.sendData(); }
    }, this.refreshIntervalMs);
  }

  /** Tear down and re-arm the poll timer at the current cadence (or leave it
   *  off when paused). Called when the user changes the refresh interval. */
  private restartPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.startPolling();
  }

  private dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (KanbanPanel.instance === this) {
      KanbanPanel.instance = undefined;
    }
  }
}

/**
 * Flatten the 8-column swimlane payload into a flat card list scoped to one
 * project. Excludes `project` and `feature` rows (those don't belong on a
 * todo/issue kanban) and items missing required fields.
 */
function flattenForProject(
  swimlane: VibeFlowSwimlaneResult,
  projectId: number,
): KanbanCard[] {
  const cards: KanbanCard[] = [];
  const buckets: VibeFlowSwimlaneItem[][] = [
    swimlane.in_review,
    swimlane.needs_pm_input,
    swimlane.needs_ux_input,
    swimlane.planning,
    swimlane.ready_to_implement,
    swimlane.architecture_review_complete,
    swimlane.implementing,
    swimlane.done,
  ];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) { continue; }
    for (const item of bucket) {
      if (item.project_id !== projectId) { continue; }
      if (item.type !== 'todo' && item.type !== 'issue') { continue; }
      cards.push({
        type: item.type,
        id: item.id,
        title: item.name,
        status: item.status,
        priority: item.priority ?? 'medium',
        featureName: item.feature_name,
        currentPersona: item.current_persona,
        securityReviewed: !!item.security_reviewed,
        updatedAt: item.updated_at,
      });
    }
  }
  return cards;
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
