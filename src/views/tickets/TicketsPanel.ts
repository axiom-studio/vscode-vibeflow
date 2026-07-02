import * as vscode from 'vscode';
import { getNonce } from '../../utils/nonce.js';
import type { VibeFlowClient } from '../../api/client.js';
import type { PollingCoordinator, Disposer } from '../../core/PollingCoordinator.js';
import { backgroundIntervalMs } from '../../core/pollingConfig.js';
import type { VibeFlowTodo, VibeFlowIssue } from '../../api/types.js';
import { personaDisplayName } from '../../sessions/personas.js';
import {
  assertNever,
  type TicketsClientMessage,
  type TicketsHostMessage,
  type TicketsMode,
  type TicketsQuery,
  type TicketRow,
} from '../../core/webviewMessages.js';

const MODE_TITLE: Record<TicketsMode, string> = {
  todos: 'Todos',
  issues: 'Issues',
  features: 'Features',
  backlog: 'Backlog',
  security: 'Security Review',
  qa: 'Pending QA',
};

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

  private static readonly PAGE_SIZE = 50;
  /** Load-more cursor per source; reset to page 1 on (re)load, advanced by loadMore. */
  private cursor = { todosPage: 1, issuesPage: 1, hasMore: false };
  /** claimed_by (session id) → persona key, cached on reset so pages don't re-fetch it. */
  private readonly personaMap = new Map<string, string>();
  /** Distinct features for the row filter dropdown, cached on reset. */
  private cachedFeatures: { id: number; name: string }[] = [];
  private query: TicketsQuery = { sortBy: 'updated_at', sortOrder: 'desc' };

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
      void this.maybeAutoRefresh();
    });
    this.panel.onDidDispose(() => this.dispose());
  }

  private async handleMessage(msg: TicketsClientMessage): Promise<void> {
    switch (msg.type) {
      case 'ticketsLoad':
        this.query = normalizeQuery(msg.payload);
        await this.loadReset();
        this.startPolling();
        return;
      case 'ticketsLoadMore':
        await this.loadMore();
        return;
      case 'ticketsRefresh':
        await this.loadReset();
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
      await this.loadReset();
    } catch (err) {
      vscode.window.showErrorMessage(
        `VibeFlow: Failed to update ${itemType} #${itemId} → ${newStatus} — ${err}`,
      );
      await this.loadReset();
    }
  }

  /** Full (re)load — reset the cursor, refresh caches, post page 1. */
  private async loadReset(): Promise<void> {
    this.lastFetchAt = Date.now();
    this.cursor = { todosPage: 1, issuesPage: 1, hasMore: false };
    try {
      // Cache the persona map (claimed_by → display name) + feature list once
      // per (re)load; each page reuses them. Both degraded on purpose — a
      // cosmetic-resolution failure must not blank the whole table (PR #1).
      const [sessions, features] = await Promise.all([
        this.client.listSessions(this.projectId).catch(() => []),
        this.client.listFeatures(this.projectId).catch(() => []),
      ]);
      this.personaMap.clear();
      for (const s of sessions) {
        if (s.session_id && s.persona_key) { this.personaMap.set(s.session_id, s.persona_key); }
      }
      this.cachedFeatures = features.map(f => ({ id: f.id, name: f.name }));

      const { rows, hasMore, total } = await this.fetchRows(true);
      this.cursor.hasMore = hasMore;
      this.post({
        type: 'ticketsData',
        payload: {
          mode: this.mode,
          title: MODE_TITLE[this.mode],
          projectName: this.projectName,
          rows,
          features: this.cachedFeatures,
          generatedAt: new Date().toISOString(),
          hasMore,
          total,
        },
      });
    } catch (err) {
      this.post({
        type: 'ticketsError',
        payload: { message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  /** Append the next page (load-more). A failure leaves the current rows intact. */
  private async loadMore(): Promise<void> {
    if (!this.cursor.hasMore) { return; }
    try {
      const { rows, hasMore } = await this.fetchRows(false);
      this.cursor.hasMore = hasMore;
      this.post({ type: 'ticketsAppend', payload: { rows, hasMore } });
    } catch {
      // Best-effort — the user can retry Load More; don't blank the table.
    }
  }

  /**
   * Auto-refresh (30s poll / becoming visible) — but only when the user hasn't
   * paged past page 1, so we never clobber their loaded-more rows.
   */
  private async maybeAutoRefresh(): Promise<void> {
    if (this.cursor.todosPage > 1 || this.cursor.issuesPage > 1) { return; }
    await this.loadReset();
  }

  /**
   * Fetch one page for the current mode. `reset` starts at page 1; otherwise
   * advances the cursor. Returns this page's rows, whether more remain, and the
   * total across all pages. Single-source modes (todos/issues) paginate via the
   * backend; features + the review-queue modes load their full set on reset
   * (features is unpaginated; backlog/security/qa move to the dedicated
   * paginated endpoints in increment 2).
   */
  private async fetchRows(reset: boolean): Promise<{ rows: TicketRow[]; hasMore: boolean; total: number }> {
    switch (this.mode) {
      case 'features': {
        if (!reset) { return { rows: [], hasMore: false, total: 0 }; }
        const features = await this.client.listFeatures(this.projectId);
        const rows = features
          .map(f => ({ type: 'feature' as const, id: f.id, title: f.name, status: f.status ?? '' }))
          .filter(row => matchesFeatureQuery(row, this.query));
        return {
          rows,
          hasMore: false,
          total: rows.length,
        };
      }
      case 'todos': {
        const page = reset ? 1 : this.cursor.todosPage + 1;
        this.cursor.todosPage = page;
        const { items, totalCount, totalPages } = await this.client.listTodosPage(this.projectId, {
          page, limit: TicketsPanel.PAGE_SIZE, ...this.query,
        });
        return { rows: items.map(t => this.toTodoRow(t)), hasMore: page < totalPages, total: totalCount };
      }
      case 'issues': {
        const page = reset ? 1 : this.cursor.issuesPage + 1;
        this.cursor.issuesPage = page;
        const { items, totalCount, totalPages } = await this.client.listIssuesPage(this.projectId, {
          page, limit: TicketsPanel.PAGE_SIZE, ...this.query,
        });
        return { rows: items.map(i => this.toIssueRow(i)), hasMore: page < totalPages, total: totalCount };
      }
      case 'backlog':
      case 'security':
      case 'qa': {
        const kind = this.mode === 'backlog' ? 'backlog' : this.mode === 'security' ? 'security-pending' : 'qa-pending';
        const todosPage = reset ? 1 : this.cursor.todosPage + 1;
        const issuesPage = reset ? 1 : this.cursor.issuesPage + 1;
        this.cursor.todosPage = todosPage;
        this.cursor.issuesPage = issuesPage;
        // One call returns both lists, each independently paged; an exhausted
        // list just yields an empty page, so we always advance both cursors.
        const { todos, issues } = await this.client.listReviewQueue(kind, this.projectId, {
          todosPage, issuesPage, pageSize: TicketsPanel.PAGE_SIZE,
          search: this.query.search,
          sortBy: this.query.sortBy,
          sortOrder: this.query.sortOrder,
        });
        return {
          rows: [...todos.items.map(t => this.toTodoRow(t)), ...issues.items.map(i => this.toIssueRow(i))],
          hasMore: todosPage < todos.totalPages || issuesPage < issues.totalPages,
          total: todos.totalCount + issues.totalCount,
        };
      }
      default:
        return { rows: [], hasMore: false, total: 0 };
    }
  }

  /** Resolve a claimed_by session id → "@Persona" (or a short id fallback). */
  private claimant(id?: string): string | undefined {
    if (!id) { return undefined; }
    const key = this.personaMap.get(id);
    if (key) { return personaDisplayName(key); }
    const parts = id.split('-');
    return parts.length >= 3 ? parts[parts.length - 1].slice(0, 8) : id.slice(0, 8);
  }

  private toTodoRow(t: VibeFlowTodo): TicketRow {
    return {
      type: 'todo', id: t.id, title: t.title, status: t.status, priority: t.priority,
      featureName: t.feature_name, userEmail: t.user_email, claimedBy: this.claimant(t.claimed_by),
      branch: t.target_branch, securityReviewed: t.security_reviewed, qaVerified: t.qa_verified,
      updatedAt: t.updated_at,
    };
  }

  private toIssueRow(i: VibeFlowIssue): TicketRow {
    return {
      type: 'issue', id: i.id, title: i.title, status: i.status, priority: i.priority,
      userEmail: i.user_email, claimedBy: this.claimant(i.claimed_by),
      branch: i.target_branch, securityReviewed: i.security_reviewed, qaVerified: i.qa_verified,
      updatedAt: i.updated_at,
    };
  }

  private post(msg: TicketsHostMessage): void {
    this.panel.webview.postMessage(msg);
  }

  private startPolling(): void {
    if (this.pollSub) { return; }
    this.pollSub = this.coordinator.subscribe(backgroundIntervalMs(), () => {
      if (this.panel.visible) { void this.maybeAutoRefresh(); }
    }, 'tickets');
  }

  private dispose(): void {
    this.pollSub?.dispose();
    this.pollSub = undefined;
    if (TicketsPanel.instances.get(this.mode) === this) {
      TicketsPanel.instances.delete(this.mode);
    }
  }
}

function normalizeQuery(query?: TicketsQuery): TicketsQuery {
  const search = query?.search?.trim();
  return {
    search: search || undefined,
    status: query?.status || undefined,
    sortBy: query?.sortBy ?? 'updated_at',
    sortOrder: query?.sortOrder ?? 'desc',
    featureId: query?.featureId,
  };
}

function matchesFeatureQuery(row: TicketRow, query: TicketsQuery): boolean {
  if (query.status && row.status !== query.status) { return false; }
  const q = query.search?.toLowerCase();
  if (!q) { return true; }
  return row.title.toLowerCase().includes(q) || String(row.id).includes(q);
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
