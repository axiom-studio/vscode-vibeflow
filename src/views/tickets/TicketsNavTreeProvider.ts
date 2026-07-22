import * as vscode from 'vscode';
import type { VibeFlowClient } from '../../api/client.js';
import type { WorkItemsTreeProvider } from '../workItems/WorkItemsTreeProvider.js';
import type { SimpleNode } from '../surface/surfaceNodes.js';
import { toTreeItem } from '../surface/surfaceNodes.js';
import type { TicketsMode } from '../../core/webviewMessages.js';

const SECTIONS: { mode: TicketsMode; label: string; icon: string }[] = [
  { mode: 'todos', label: 'Todos', icon: 'checklist' },
  { mode: 'issues', label: 'Issues', icon: 'bug' },
  { mode: 'features', label: 'Features', icon: 'milestone' },
  { mode: 'backlog', label: 'Backlog', icon: 'list-unordered' },
  { mode: 'security', label: 'Security Review', icon: 'shield' },
  { mode: 'qa', label: 'Pending QA', icon: 'verified' },
];

const TERMINAL = new Set(['done', 'archived', 'rejected']);

/**
 * Sidebar "Browse" nav — each row opens a cloud-style ticket TABLE panel
 * (TicketsPanel) in its own editor tab, and shows a live count as its
 * description. The six built-in counts are derived from WorkItemsTreeProvider's
 * already-fetched todos/issues/features (no extra network calls); the nav
 * re-renders on that provider's refresh event. The flag-gated Cloud Runners row
 * is the one exception — runners aren't in that provider, so its count comes
 * from a list call made on the same refresh event (see refreshCloudRunnerCount).
 */
export class TicketsNavTreeProvider implements vscode.TreeDataProvider<SimpleNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SimpleNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly sub: vscode.Disposable;

  /**
   * Whether the org has the Cloud Runners capability (feature #603). Resolved
   * asynchronously per connect via `client.isCloudRunnersEnabled()`; the
   * "Cloud Runners" browse row only appears when this is true. Defaults to
   * hidden so a disabled org (or a pre-connect state) never shows the row.
   */
  private cloudRunnersEnabled = false;

  private client: VibeFlowClient | undefined;
  private projectId: number | undefined;
  /**
   * Runner count for the Cloud Runners row's description. `undefined` until the
   * first fetch lands, so the row renders bare rather than flashing a wrong "0".
   */
  private cloudRunnerCount: number | undefined;

  constructor(private readonly workItems: WorkItemsTreeProvider) {
    // The work-items provider polls on the shared PollingCoordinator's
    // background tier and fires this after every fetch. Riding it gives the
    // runner count the same cadence — and the coordinator's focus-pause —
    // without a second subscription.
    this.sub = this.workItems.onDidRefresh(() => {
      void this.refreshCloudRunnerCount();
      this._onDidChangeTreeData.fire();
    });
  }

  /** Bind the project whose runners the Cloud Runners row counts. */
  connect(client: VibeFlowClient, projectId: number): void {
    this.client = client;
    this.projectId = projectId;
    this.cloudRunnerCount = undefined; // a previous project's count is not ours
    void this.refreshCloudRunnerCount();
  }

  /** Toggle visibility of the Cloud Runners browse row; re-renders on change. */
  setCloudRunnersEnabled(enabled: boolean): void {
    if (this.cloudRunnersEnabled === enabled) { return; }
    this.cloudRunnersEnabled = enabled;
    this._onDidChangeTreeData.fire();
    // The flag resolves after connect(), so fetch now rather than leaving the
    // row uncounted until the next background tick.
    if (enabled) { void this.refreshCloudRunnerCount(); }
  }

  /**
   * Refresh the Cloud Runners count. Gated on the org flag because the list is
   * not cheap upstream — axiomcloud enriches every row with a per-runner live
   * status call to cortex — so it must never run for orgs that can't see the
   * row, and never on render. Failure-tolerant: a transient background error
   * keeps the last known count instead of blanking the row.
   */
  private async refreshCloudRunnerCount(): Promise<void> {
    if (!this.cloudRunnersEnabled || !this.client || this.projectId === undefined) { return; }
    try {
      const runners = await this.client.listProjectCloudRunners(this.projectId);
      if (this.cloudRunnerCount === runners.length) { return; }
      this.cloudRunnerCount = runners.length;
      this._onDidChangeTreeData.fire();
    } catch {
      // Background refresh — keep the previous count and try again next tick.
    }
  }

  getTreeItem(node: SimpleNode): vscode.TreeItem {
    return toTreeItem(node);
  }

  getChildren(element?: SimpleNode): SimpleNode[] {
    if (element) { return []; }
    const counts = this.counts();
    const rows: SimpleNode[] = SECTIONS.map(s => ({
      id: `tickets-nav-${s.mode}`,
      label: s.label,
      description: String(counts[s.mode]),
      iconId: s.icon,
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      contextValue: 'ticketsNavItem',
      command: { command: 'vibeflow.openTickets', title: `Open ${s.label}`, arguments: [s.mode] },
    }));
    if (this.cloudRunnersEnabled) {
      rows.push({
        id: 'tickets-nav-cloud-runners',
        label: 'Cloud Runners',
        description: this.cloudRunnerCount === undefined ? undefined : String(this.cloudRunnerCount),
        iconId: 'cloud',
        collapsibleState: vscode.TreeItemCollapsibleState.None,
        contextValue: 'ticketsNavItem',
        command: { command: 'vibeflow.openCloudRunners', title: 'Open Cloud Runners' },
      });
      // Git providers share the feature_cloud_runners gate — their routes are
      // behind the same org capability (#2822).
      rows.push({
        id: 'tickets-nav-git-providers',
        label: 'Git Providers',
        iconId: 'key',
        collapsibleState: vscode.TreeItemCollapsibleState.None,
        contextValue: 'ticketsNavItem',
        command: { command: 'vibeflow.openGitProviders', title: 'Open Git Providers' },
      });
    }
    return rows;
  }

  /** Per-section counts, matching the filters TicketsPanel applies per mode. */
  private counts(): Record<TicketsMode, number> {
    const todos = this.workItems.getTodos();
    const issues = this.workItems.getIssues();
    const features = this.workItems.getFeatures();
    const all = [...todos, ...issues];
    return {
      todos: todos.length,
      issues: issues.length,
      features: features.length,
      backlog: all.filter(i => !TERMINAL.has(i.status)).length,
      security: all.filter(i => i.status === 'done' && !i.security_reviewed).length,
      qa: all.filter(i => i.status === 'done' && i.security_reviewed && !i.qa_verified).length,
    };
  }

  dispose(): void {
    this.sub.dispose();
    this._onDidChangeTreeData.dispose();
  }
}
