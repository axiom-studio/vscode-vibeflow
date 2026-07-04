import * as vscode from 'vscode';
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
 * description. Counts are derived from WorkItemsTreeProvider's already-fetched
 * todos/issues/features (no extra network calls); the nav re-renders on that
 * provider's refresh event.
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

  constructor(private readonly workItems: WorkItemsTreeProvider) {
    this.sub = this.workItems.onDidRefresh(() => this._onDidChangeTreeData.fire());
  }

  /** Toggle visibility of the Cloud Runners browse row; re-renders on change. */
  setCloudRunnersEnabled(enabled: boolean): void {
    if (this.cloudRunnersEnabled === enabled) { return; }
    this.cloudRunnersEnabled = enabled;
    this._onDidChangeTreeData.fire();
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
        iconId: 'cloud',
        collapsibleState: vscode.TreeItemCollapsibleState.None,
        contextValue: 'ticketsNavItem',
        command: { command: 'vibeflow.openCloudRunners', title: 'Open Cloud Runners' },
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
