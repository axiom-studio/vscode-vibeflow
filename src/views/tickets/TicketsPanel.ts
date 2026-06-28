import * as vscode from 'vscode';
import { getNonce } from '../../utils/nonce.js';
import type { VibeFlowClient } from '../../api/client.js';
import type { PollingCoordinator, Disposer } from '../../core/PollingCoordinator.js';
import type { VibeFlowTodo, VibeFlowIssue } from '../../api/types.js';
import { personaDisplayName } from '../../sessions/personas.js';
import {
  assertNever,
  type TicketsClientMessage,
  type TicketsHostMessage,
  type TicketsMode,
  type TicketRow,
} from '../../core/webviewMessages.js';

const POLL_INTERVAL_MS = 30_000;

const MODE_TITLE: Record<TicketsMode, string> = {
  todos: 'Todos',
  issues: 'Issues',
  features: 'Features',
  backlog: 'Backlog',
  security: 'Security Review',
  qa: 'Pending QA',
};

const DONE = 'done';
const TERMINAL = new Set(['done', 'archived', 'rejected']);

/**
 * Cloud-style ticket TABLE panel — one parameterized webview per "mode"
 * (Todos / Issues / Features / Backlog / Security Review / Pending QA), each
 * in its own editor tab. The React view (TicketsView) renders the table; a row
 * click reopens the existing work-item detail panel in a new tab. Mirrors the
 * KanbanPanel host pattern (load-on-mount, 30s visible-only poll).
 */
export class TicketsPanel {
  private static readonly instances = new Map<TicketsMode, TicketsPanel>();

  private readonly panel: vscode.WebviewPanel;
  private pollSub: Disposer | undefined;
  private lastFetchAt = 0;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly client: VibeFlowClient,
    private readonly projectId: number,
    private readonly projectName: string,
    private readonly mode: TicketsMode,
    private readonly coordinator: PollingCoordinator,
  ) {
    this.panel = panel;
  }

  static open(
    extensionUri: vscode.Uri,
    client: VibeFlowClient,
    projectId: number,
    projectName: string,
    mode: TicketsMode,
    coordinator: PollingCoordinator,
  ): void {
    const existing = TicketsPanel.instances.get(mode);
    if (existing) {
      existing.panel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'vibeflow.tickets',
      `${MODE_TITLE[mode]} — ${projectName}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'webview-ui', 'dist')],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'vibeflow-icon.svg');
    panel.webview.html = renderHtml(panel.webview, extensionUri, mode);

    const instance = new TicketsPanel(panel, client, projectId, projectName, mode, coordinator);
    TicketsPanel.instances.set(mode, instance);
    instance.attach();
  }

  private attach(): void {
    this.panel.webview.onDidReceiveMessage((msg: TicketsClientMessage) => this.handleMessage(msg));
    this.panel.onDidChangeViewState(e => {
      if (!e.webviewPanel.visible) { return; }
      if (Date.now() - this.lastFetchAt < 1000) { return; }
      void this.sendData();
    });
    this.panel.onDidDispose(() => this.dispose());
  }

  private async handleMessage(msg: TicketsClientMessage): Promise<void> {
    switch (msg.type) {
      case 'ticketsLoad':
        await this.sendData();
        this.startPolling();
        return;
      case 'ticketsRefresh':
        await this.sendData();
        return;
      case 'ticketsOpenItem':
        // Reuse the work-item detail panel — opens in a new editor tab.
        // resolveWorkItemRef only handles todo/issue, so a feature row is a
        // safe no-op there.
        vscode.commands.executeCommand(
          'vibeflow.openWorkItemPanel',
          `${msg.payload.itemType}-${msg.payload.itemId}`,
          msg.payload.title,
          '',
        );
        return;
      case 'ticketsChangeStatus':
        await this.handleChangeStatus(msg.payload);
        return;
      default:
        assertNever(msg);
    }
  }

  private async handleChangeStatus(payload: { itemType: 'todo' | 'issue'; itemId: number; newStatus: string }): Promise<void> {
    const { itemType, itemId, newStatus } = payload;
    try {
      if (itemType === 'todo') {
        await this.client.updateTodoStatus(itemId, newStatus);
      } else {
        await this.client.updateIssueStatus(itemId, newStatus);
      }
      await this.sendData();
    } catch (err) {
      vscode.window.showErrorMessage(
        `VibeFlow: Failed to update ${itemType} #${itemId} → ${newStatus} — ${err}`,
      );
      await this.sendData();
    }
  }

  private async sendData(): Promise<void> {
    this.lastFetchAt = Date.now();
    try {
      const [rows, features] = await Promise.all([
        this.collectRows(),
        // The feature-filter dropdown only — degraded on purpose: an empty filter
        // shouldn't blank the table (PR #1 review). The 'features' MODE fetches
        // listFeatures un-caught inside collectRows so it DOES surface errors.
        this.client.listFeatures(this.projectId).catch(() => []),
      ]);
      this.post({
        type: 'ticketsData',
        payload: {
          mode: this.mode,
          title: MODE_TITLE[this.mode],
          projectName: this.projectName,
          rows,
          features: features.map(f => ({ id: f.id, name: f.name })),
          generatedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      this.post({
        type: 'ticketsError',
        payload: { message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  private async collectRows(): Promise<TicketRow[]> {
    // Resolve claimed_by (a session id) → persona display name, same map the
    // WorkItemsTreeProvider builds. Degraded on purpose: if this fails, claimant()
    // falls back to a truncated id — the table still renders, so a name-resolution
    // failure must not blank it (PR #1 review).
    const sessions = await this.client.listSessions(this.projectId).catch(() => []);
    const personaMap = new Map<string, string>();
    for (const s of sessions) {
      if (s.session_id && s.persona_key) { personaMap.set(s.session_id, s.persona_key); }
    }
    const claimant = (id?: string): string | undefined => {
      if (!id) { return undefined; }
      const key = personaMap.get(id);
      if (key) { return personaDisplayName(key); }
      const parts = id.split('-');
      return parts.length >= 3 ? parts[parts.length - 1].slice(0, 8) : id.slice(0, 8);
    };

    if (this.mode === 'features') {
      const features = await this.client.listFeatures(this.projectId);
      return features.map(f => ({
        type: 'feature' as const,
        id: f.id,
        title: f.name,
        status: f.status ?? '',
      }));
    }

    // PRIMARY table data — do NOT swallow. A real fetch failure here propagates
    // to sendData()'s try/catch, which posts `ticketsError` so the panel shows a
    // banner instead of a misleading empty table (PR #1 review). The supplementary
    // fetches above/below (listSessions for claimant names, listFeatures for the
    // filter) stay degraded on purpose — a cosmetic-resolution failure shouldn't
    // blank the whole table.
    const [todos, issues] = await Promise.all([
      this.client.listTodosByProject(this.projectId),
      this.client.listIssues(this.projectId),
    ]);
    const todoRow = (t: VibeFlowTodo): TicketRow => ({
      type: 'todo',
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      featureName: t.feature_name,
      userEmail: t.user_email,
      claimedBy: claimant(t.claimed_by),
      branch: t.target_branch,
      securityReviewed: t.security_reviewed,
      qaVerified: t.qa_verified,
      updatedAt: t.updated_at,
    });
    const issueRow = (i: VibeFlowIssue): TicketRow => ({
      type: 'issue',
      id: i.id,
      title: i.title,
      status: i.status,
      priority: i.priority,
      userEmail: i.user_email,
      claimedBy: claimant(i.claimed_by),
      branch: i.target_branch,
      securityReviewed: i.security_reviewed,
      qaVerified: i.qa_verified,
      updatedAt: i.updated_at,
    });

    switch (this.mode) {
      case 'todos':
        return todos.map(todoRow);
      case 'issues':
        return issues.map(issueRow);
      case 'security':
        return [
          ...todos.filter(t => t.status === DONE && !t.security_reviewed).map(todoRow),
          ...issues.filter(i => i.status === DONE && !i.security_reviewed).map(issueRow),
        ];
      case 'qa':
        return [
          ...todos.filter(t => t.status === DONE && t.security_reviewed && !t.qa_verified).map(todoRow),
          ...issues.filter(i => i.status === DONE && i.security_reviewed && !i.qa_verified).map(issueRow),
        ];
      case 'backlog':
        return [
          ...todos.filter(t => !TERMINAL.has(t.status)).map(todoRow),
          ...issues.filter(i => !TERMINAL.has(i.status)).map(issueRow),
        ];
      default:
        return [];
    }
  }

  private post(msg: TicketsHostMessage): void {
    this.panel.webview.postMessage(msg);
  }

  private startPolling(): void {
    if (this.pollSub) { return; }
    this.pollSub = this.coordinator.subscribe(POLL_INTERVAL_MS, () => {
      if (this.panel.visible) { void this.sendData(); }
    });
  }

  private dispose(): void {
    this.pollSub?.dispose();
    this.pollSub = undefined;
    if (TicketsPanel.instances.get(this.mode) === this) {
      TicketsPanel.instances.delete(this.mode);
    }
  }
}

function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri, mode: TicketsMode): string {
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
  <title>Tickets</title>
</head>
<body data-vf-mode="tickets" data-vf-tickets-mode="${mode}">
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
