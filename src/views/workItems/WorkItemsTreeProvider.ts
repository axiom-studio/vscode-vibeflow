import * as vscode from 'vscode';
import type { VibeFlowClient } from '../../api/client.js';
import type { VibeFlowFeature, VibeFlowTodo, VibeFlowIssue } from '../../api/types.js';
import { personaDisplayName } from '../../sessions/personas.js';

type NodeType = 'statusGroup' | 'feature' | 'todo' | 'issue' | 'placeholder';

interface WorkItemNode {
  id: string;
  type: NodeType;
  label: string;
  description?: string;
  tooltip?: string | vscode.MarkdownString;
  iconId?: string;
  iconColor?: vscode.ThemeColor;
  collapsibleState: vscode.TreeItemCollapsibleState;
  children?: WorkItemNode[];
  contextValue?: string;
}

/**
 * Maps the 10 backend statuses (axiomcloud/database/vibeflow_models.go:36-46)
 * onto the 5 UI buckets the user sees. Every status MUST appear in exactly
 * one bucket — otherwise items in the missing status disappear from the
 * tree silently.
 *
 * Coverage assertion: in_review, needs_pm_input, needs_ux_input, planning,
 * ready_to_implement, architecture_review_complete, implementing, done,
 * archived, rejected. (10 total.)
 */
const STATUS_GROUP_CONFIG: { key: string; label: string; icon: string; statuses: string[] }[] = [
  { key: 'implementing', label: 'In Progress', icon: 'zap', statuses: ['implementing', 'planning'] },
  { key: 'ready', label: 'Ready', icon: 'checklist', statuses: ['ready_to_implement', 'architecture_review_complete'] },
  { key: 'review', label: 'In Review', icon: 'search', statuses: ['in_review', 'needs_pm_input', 'needs_ux_input'] },
  { key: 'done', label: 'Done', icon: 'check', statuses: ['done'] },
  // Terminal states get their own bucket so users can audit closed work
  // without scrolling — and so items in `archived` or `rejected` don't
  // silently vanish (which they did pre-fix, with the same set missing
  // from VALID_TRANSITIONS in workItemCommands.ts).
  { key: 'closed', label: 'Closed', icon: 'archive', statuses: ['archived', 'rejected'] },
];

const PRIORITY_ICONS: Record<string, string> = {
  high: 'arrow-up',
  medium: 'dash',
  low: 'arrow-down',
};

const PRIORITY_COLORS: Record<string, string> = {
  high: 'testing.iconFailed',
  medium: 'editorWarning.foreground',
  low: 'disabledForeground',
};

/**
 * Work Items TreeView — features/todos/issues grouped by status.
 * Polls API every 30s. Falls back to empty groups when disconnected.
 */
export class WorkItemsTreeProvider implements vscode.TreeDataProvider<WorkItemNode>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<WorkItemNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private client: VibeFlowClient | undefined;
  private projectId: number | undefined;
  private features: VibeFlowFeature[] = [];
  private todos: VibeFlowTodo[] = [];
  private issues: VibeFlowIssue[] = [];
  /**
   * Snapshot of `{type}-{id} → status` from the previous poll. Used by
   * notifyCompletions() to detect !done → done transitions. `undefined`
   * before the first successful poll so we don't fire toasts for the
   * baseline state at activation time.
   */
  private prevStatuses: Map<string, { status: string; title: string; type: 'todo' | 'issue'; id: number }> | undefined;

  /**
   * Count of todos+issues an agent could pick up right now — anything in
   * `ready_to_implement` or `architecture_review_complete`. Drives the
   * "M ready" half of the work-summary status bar.
   */
  getReadyWorkItemCount(): number {
    const ready = (s: string) => s === 'ready_to_implement' || s === 'architecture_review_complete';
    return this.todos.filter(t => ready(t.status)).length
      + this.issues.filter(i => ready(i.status)).length;
  }

  /**
   * Fired after every successful poll. Lets sibling tree providers
   * (e.g. the Browse nav) consume the same fetched data
   * without polling independently. Keeps the network footprint flat
   * regardless of how many trees read this data.
   */
  private _onDidRefresh = new vscode.EventEmitter<void>();
  readonly onDidRefresh = this._onDidRefresh.event;

  /** Snapshots for sibling consumers. Read-only by convention. */
  getFeatures(): readonly VibeFlowFeature[] { return this.features; }
  getTodos(): readonly VibeFlowTodo[] { return this.todos; }
  getIssues(): readonly VibeFlowIssue[] { return this.issues; }
  /**
   * session_id → persona display name, surfaces under sibling
   * providers' "claimed by" rendering so they don't have to re-derive
   * the map.
   */
  getPersonaForSession(sessionId: string | undefined): string | undefined {
    if (!sessionId) { return undefined; }
    const key = this.sessionPersonaMap.get(sessionId);
    return key ? personaDisplayName(key) : undefined;
  }
  /**
   * session_id → persona_key, refreshed each poll cycle. Used to render
   * the "claimed by" tag on tree nodes — `claimed_by` on a work item is
   * a session id like "session-20260411-200221-e9cdf438", which is
   * useless to a human. We resolve it back to a persona display name so
   * the user sees "@Architect" instead of "@session".
   */
  private sessionPersonaMap = new Map<string, string>();
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  refresh(): void {
    this.fetchAndRefresh();
  }

  connect(client: VibeFlowClient, projectId: number): void {
    this.client = client;
    this.projectId = projectId;
    this.startPolling();
    this.fetchAndRefresh();
  }

  private startPolling(): void {
    this.stopPolling();
    const config = vscode.workspace.getConfiguration('vibeflow');
    const interval = config.get<number>('polling.interval', 30) * 1000;
    this.pollTimer = setInterval(() => this.fetchAndRefresh(), interval);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private async fetchAndRefresh(): Promise<void> {
    if (!this.client || !this.projectId) {
      this._onDidChangeTreeData.fire();
      return;
    }

    try {
      const [features, issues, sessions] = await Promise.all([
        this.client.listFeatures(this.projectId),
        this.client.listIssues(this.projectId),
        this.client.listSessions(this.projectId).catch(() => []),
      ]);
      this.features = features;
      this.issues = issues;

      // Rebuild session_id -> persona_key map. Same pattern as
      // ActivityPoller.pollSessions — keep the snapshot fresh so the
      // "claimed by" tag survives session restarts.
      this.sessionPersonaMap.clear();
      for (const s of sessions) {
        if (s.session_id && s.persona_key) {
          this.sessionPersonaMap.set(s.session_id, s.persona_key);
        }
      }

      // Fetch todos for ALL features (some todos may be active even if feature is done)
      const todoLists = await Promise.all(
        features.map(f => this.client!.listTodos(f.id).catch(() => [])),
      );
      this.todos = todoLists.flat();

      // Detect transitions to `done` since the previous poll. Only fires
      // toasts on the !done → done edge, so an item sitting in done
      // across many polls notifies exactly once. First-ever poll seeds
      // the baseline silently — items that were already done before the
      // window opened don't get spurious notifications.
      this.notifyCompletions();
      // Tell sibling tree providers (the Browse nav) that
      // fresh data is available. Fires only on successful polls so
      // consumers don't refresh on transient errors.
      this._onDidRefresh.fire();
    } catch {
      // Keep stale data on error — and skip the diff so a transient
      // failure doesn't drop transitions on the floor (next successful
      // poll catches them via the unchanged prevStatuses snapshot).
    }

    this._onDidChangeTreeData.fire();
  }

  /**
   * Per-item status diff for the "Work Item Complete" notification toggle
   * (vibeflow.notifications.workItemComplete). Maintains an internal
   * Map of `{type}-{id}` → status across polls so we can fire a toast
   * exactly once on the !done → done edge.
   *
   * Long-term this should be driven by the backend's SSE channel
   * (`work_available` event with `NewStatus: "done"` — see
   * axiomcloud/handlers/vibeflow_sse.go:156). Polling diff is the
   * pragmatic version: ≤30s latency, no new connection, but lossy if
   * an item flips done → archived between two polls. File a follow-up
   * to migrate to SSE when we want richer real-time updates.
   */
  private notifyCompletions(): void {
    const curr = new Map<string, { status: string; title: string; type: 'todo' | 'issue'; id: number }>();
    for (const t of this.todos) {
      curr.set(`todo-${t.id}`, { status: t.status, title: t.title, type: 'todo', id: t.id });
    }
    for (const i of this.issues) {
      curr.set(`issue-${i.id}`, { status: i.status, title: i.title, type: 'issue', id: i.id });
    }

    const prev = this.prevStatuses;
    this.prevStatuses = curr;

    // First poll seeds the baseline silently. We don't know which items
    // were already done before activation, so notifying for every
    // currently-done row would flood the user.
    if (prev === undefined) { return; }

    const enabled = vscode.workspace.getConfiguration('vibeflow')
      .get<boolean>('notifications.workItemComplete', true);
    if (!enabled) { return; }

    for (const [key, { status, title, type, id }] of curr) {
      // Only the !done → done edge. Items already done across polls,
      // or items reappearing in done after being elsewhere, both pass
      // — only the actual transition fires.
      const prevStatus = prev.get(key)?.status;
      if (prevStatus === 'done' || status !== 'done') { continue; }
      this.showCompletionToast(type, id, title);
    }
  }

  private showCompletionToast(type: 'todo' | 'issue', id: number, title: string): void {
    const truncated = title.length > 60 ? title.slice(0, 57) + '…' : title;
    const label = type === 'todo' ? 'Todo' : 'Issue';
    void vscode.window.showInformationMessage(
      `VibeFlow: ${label} #${id} done — ${truncated}`,
      'View',
    ).then((choice) => {
      if (choice === 'View') {
        vscode.commands.executeCommand('vibeflow.openWorkItemPanel', `${type}-${id}`);
      }
    });
  }

  getTreeItem(element: WorkItemNode): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label, element.collapsibleState);
    item.id = element.id;
    item.description = element.description;
    item.contextValue = element.contextValue;

    if (element.tooltip) {
      item.tooltip = element.tooltip;
    }

    if (element.iconId) {
      item.iconPath = new vscode.ThemeIcon(
        element.iconId,
        element.iconColor,
      );
    }

    // Click a todo/issue → open Work Item Detail Panel
    // Pass only serializable primitives — ThemeColor/MarkdownString break serialization
    if (element.type === 'todo' || element.type === 'issue') {
      item.command = {
        command: 'vibeflow.openWorkItemPanel',
        title: 'View Details',
        arguments: [element.id, element.label, element.description ?? ''],
      };
    }

    return item;
  }

  getChildren(element?: WorkItemNode): WorkItemNode[] {
    if (!element) {
      return this.buildStatusGroups();
    }
    return element.children ?? [];
  }

  private buildStatusGroups(): WorkItemNode[] {
    return STATUS_GROUP_CONFIG.map(group => {
      const groupTodos = this.todos.filter(t => group.statuses.includes(t.status));
      const groupIssues = this.issues.filter(i => group.statuses.includes(i.status));
      const count = groupTodos.length + groupIssues.length;

      const children: WorkItemNode[] = [
        ...groupTodos.map(t => this.buildTodoNode(t)),
        ...groupIssues.map(i => this.buildIssueNode(i)),
      ];

      return {
        id: `group-${group.key}`,
        type: 'statusGroup' as const,
        label: group.label,
        description: `${count}`,
        iconId: group.icon,
        collapsibleState: group.key === 'done'
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded,
        contextValue: 'statusGroup',
        children,
      };
    });
  }

  private buildTodoNode(todo: VibeFlowTodo): WorkItemNode {
    const feature = this.features.find(f => f.id === todo.feature_id);
    const priorityIcon = PRIORITY_ICONS[todo.priority] ?? 'dash';
    const priorityColor = PRIORITY_COLORS[todo.priority];
    const claimant = this.formatClaimant(todo.claimed_by);
    const featureName = feature ? feature.name : '';

    const desc = [claimant, featureName].filter(Boolean).join(' · ');

    return {
      id: `todo-${todo.id}`,
      type: 'todo',
      label: `#${todo.id}: ${todo.title}`,
      description: desc,
      iconId: priorityIcon,
      iconColor: priorityColor ? new vscode.ThemeColor(priorityColor) : undefined,
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      contextValue: `todo-${todo.status}`,
    };
  }

  private buildIssueNode(issue: VibeFlowIssue): WorkItemNode {
    const priorityIcon = PRIORITY_ICONS[issue.priority] ?? 'dash';
    const priorityColor = PRIORITY_COLORS[issue.priority];
    const claimant = this.formatClaimant(issue.claimed_by);

    return {
      id: `issue-${issue.id}`,
      type: 'issue',
      label: `#${issue.id}: ${issue.title}`,
      description: claimant,
      iconId: priorityIcon,
      iconColor: priorityColor ? new vscode.ThemeColor(priorityColor) : undefined,
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      contextValue: `issue-${issue.status}`,
    };
  }

  /**
   * Resolve a claimed_by session id to "@PersonaName". Falls back to a
   * shortened session-id chunk when we don't yet have the session in
   * our map (e.g. the session refresh races behind the work-item
   * fetch on the first poll cycle).
   */
  private formatClaimant(claimedBy: string | undefined): string {
    if (!claimedBy) { return ''; }
    const personaKey = this.sessionPersonaMap.get(claimedBy);
    if (personaKey) {
      return `@${personaDisplayName(personaKey)}`;
    }
    // Last-resort fallback: short prefix of the session id, never the
    // useless literal "session-" head. Format is
    // "session-{date}-{hash}" so we surface the hash if present.
    const parts = claimedBy.split('-');
    const tail = parts.length >= 3 ? parts[parts.length - 1] : parts[0];
    return `@${tail.slice(0, 8)}`;
  }

  dispose(): void {
    this.stopPolling();
    this._onDidChangeTreeData.dispose();
    this._onDidRefresh.dispose();
  }
}
