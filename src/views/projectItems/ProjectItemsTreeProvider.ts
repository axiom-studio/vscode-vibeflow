import * as vscode from 'vscode';
import type { VibeFlowFeature, VibeFlowTodo, VibeFlowIssue } from '../../api/types.js';
import type { WorkItemsTreeProvider } from '../workItems/WorkItemsTreeProvider.js';

/**
 * "Project Items" sidebar — the hierarchical lens onto the same work
 * items the Work Items pane shows status-grouped. Mirrors Jira's
 * Backlog mental model: epics (Features) own their todos, issues live
 * alongside as a separate group because they have no feature parent.
 *
 * Tree shape:
 *   Features (N)
 *     Authentication
 *       #1234: hook up SSO     (todo)
 *       #1235: token refresh   (todo)
 *     Compliance
 *       #1671: …
 *     (No Feature)             ← orphan todos with null feature_id
 *       #1234: standalone task
 *   Issues (M)
 *     #2084: …
 *     #2123: …
 *
 * No independent polling — subscribes to the WorkItemsTreeProvider's
 * `onDidRefresh` event and re-renders off the same fetched data.
 * Single source of truth, single network footprint.
 */

type NodeType = 'featuresGroup' | 'feature' | 'orphanFeature' | 'issuesGroup' | 'todo' | 'issue';

interface ProjectItemNode {
  id: string;
  type: NodeType;
  label: string;
  description?: string;
  tooltip?: string;
  iconId?: string;
  iconColor?: vscode.ThemeColor;
  collapsibleState: vscode.TreeItemCollapsibleState;
  children?: ProjectItemNode[];
  contextValue?: string;
}

/** Feature status → icon. Mirrors the Work Items provider's status iconography. */
const FEATURE_STATUS_ICON: Record<string, string> = {
  implementing: 'zap',
  planning: 'zap',
  ready_to_implement: 'checklist',
  architecture_review_complete: 'checklist',
  in_review: 'search',
  needs_pm_input: 'search',
  needs_ux_input: 'search',
  done: 'check',
  archived: 'archive',
  rejected: 'archive',
};

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

export class ProjectItemsTreeProvider implements vscode.TreeDataProvider<ProjectItemNode>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<ProjectItemNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly refreshSubscription: vscode.Disposable;

  constructor(private readonly workItems: WorkItemsTreeProvider) {
    this.refreshSubscription = workItems.onDidRefresh(() => {
      this._onDidChangeTreeData.fire();
    });
  }

  refresh(): void {
    // Manual refresh button defers to the WorkItemsTreeProvider's
    // polling cycle, which fires our onDidChangeTreeData via the
    // refreshSubscription above. We can't fetch independently without
    // duplicating polling — and that's the whole point of sharing
    // data through the sibling provider.
    this.workItems.refresh();
  }

  getTreeItem(element: ProjectItemNode): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label, element.collapsibleState);
    item.id = element.id;
    item.description = element.description;
    item.tooltip = element.tooltip;
    item.contextValue = element.contextValue;
    if (element.iconId) {
      item.iconPath = new vscode.ThemeIcon(element.iconId, element.iconColor);
    }
    // Same click-handler the Work Items tree uses — opens the work
    // item detail panel for todos/issues. Feature clicks don't open
    // anything (no Feature panel today; defer to a follow-up).
    if (element.type === 'todo' || element.type === 'issue') {
      item.command = {
        command: 'vibeflow.openWorkItemPanel',
        title: 'View Details',
        arguments: [element.id, element.label, element.description ?? ''],
      };
    }
    return item;
  }

  getChildren(element?: ProjectItemNode): ProjectItemNode[] {
    if (!element) {
      return this.buildTopLevel();
    }
    return element.children ?? [];
  }

  private buildTopLevel(): ProjectItemNode[] {
    const features = this.workItems.getFeatures();
    const todos = this.workItems.getTodos();
    const issues = this.workItems.getIssues();

    return [
      this.buildFeaturesGroup(features, todos),
      this.buildIssuesGroup(issues),
    ];
  }

  private buildFeaturesGroup(
    features: readonly VibeFlowFeature[],
    todos: readonly VibeFlowTodo[],
  ): ProjectItemNode {
    // Sort features: non-done first (in id order for stability),
    // then done/archived/rejected at the bottom.
    const isLive = (s: string): boolean => s !== 'done' && s !== 'archived' && s !== 'rejected';
    const sortedFeatures = [...features].sort((a, b) => {
      const liveDiff = (isLive(b.status) ? 1 : 0) - (isLive(a.status) ? 1 : 0);
      if (liveDiff !== 0) { return liveDiff; }
      return a.id - b.id;
    });

    const featureNodes: ProjectItemNode[] = sortedFeatures.map(f => {
      const featureTodos = todos.filter(t => t.feature_id === f.id);
      return this.buildFeatureNode(f, featureTodos);
    });

    // Orphan todos — feature_id is null/undefined OR the referenced
    // feature isn't in this project's feature list (data drift).
    const featureIds = new Set(sortedFeatures.map(f => f.id));
    const orphanTodos = todos.filter(t =>
      t.feature_id == null || !featureIds.has(t.feature_id),
    );
    if (orphanTodos.length > 0) {
      featureNodes.push(this.buildOrphanGroup(orphanTodos));
    }

    return {
      id: 'group-features',
      type: 'featuresGroup',
      label: 'Features',
      description: `${sortedFeatures.length}`,
      iconId: 'symbol-namespace',
      collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
      children: featureNodes,
    };
  }

  private buildFeatureNode(feature: VibeFlowFeature, featureTodos: VibeFlowTodo[]): ProjectItemNode {
    const total = featureTodos.length;
    const done = featureTodos.filter(t => t.status === 'done').length;
    const open = total - done;
    const desc = total === 0
      ? feature.status
      : `${feature.status} · ${open}/${total} open`;
    return {
      id: `feature-${feature.id}`,
      type: 'feature',
      label: feature.name,
      description: desc,
      tooltip: feature.description ?? feature.name,
      iconId: FEATURE_STATUS_ICON[feature.status] ?? 'symbol-namespace',
      collapsibleState: total === 0
        ? vscode.TreeItemCollapsibleState.None
        : vscode.TreeItemCollapsibleState.Collapsed,
      contextValue: `feature-${feature.status}`,
      children: featureTodos.map(t => this.buildTodoNode(t)),
    };
  }

  private buildOrphanGroup(orphans: VibeFlowTodo[]): ProjectItemNode {
    return {
      id: 'group-orphan-todos',
      type: 'orphanFeature',
      label: '(No Feature)',
      description: `${orphans.length}`,
      iconId: 'question',
      collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
      children: orphans.map(t => this.buildTodoNode(t)),
    };
  }

  private buildIssuesGroup(issues: readonly VibeFlowIssue[]): ProjectItemNode {
    // Order: live issues first by id, terminal states at the bottom.
    const isLive = (s: string): boolean => s !== 'done' && s !== 'archived' && s !== 'rejected';
    const sorted = [...issues].sort((a, b) => {
      const liveDiff = (isLive(b.status) ? 1 : 0) - (isLive(a.status) ? 1 : 0);
      if (liveDiff !== 0) { return liveDiff; }
      return a.id - b.id;
    });
    return {
      id: 'group-issues',
      type: 'issuesGroup',
      label: 'Issues',
      description: `${issues.length}`,
      iconId: 'bug',
      collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
      children: sorted.map(i => this.buildIssueNode(i)),
    };
  }

  private buildTodoNode(todo: VibeFlowTodo): ProjectItemNode {
    const priorityIcon = PRIORITY_ICONS[todo.priority] ?? 'dash';
    const priorityColor = PRIORITY_COLORS[todo.priority];
    const claimant = this.formatClaimant(todo.claimed_by);
    const desc = [todo.status, claimant].filter(Boolean).join(' · ');
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

  private buildIssueNode(issue: VibeFlowIssue): ProjectItemNode {
    const priorityIcon = PRIORITY_ICONS[issue.priority] ?? 'dash';
    const priorityColor = PRIORITY_COLORS[issue.priority];
    const claimant = this.formatClaimant(issue.claimed_by);
    const desc = [issue.status, claimant].filter(Boolean).join(' · ');
    return {
      id: `issue-${issue.id}`,
      type: 'issue',
      label: `#${issue.id}: ${issue.title}`,
      description: desc,
      iconId: priorityIcon,
      iconColor: priorityColor ? new vscode.ThemeColor(priorityColor) : undefined,
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      contextValue: `issue-${issue.status}`,
    };
  }

  private formatClaimant(claimedBy: string | undefined): string {
    const persona = this.workItems.getPersonaForSession(claimedBy);
    return persona ? `@${persona}` : '';
  }

  dispose(): void {
    this.refreshSubscription.dispose();
    this._onDidChangeTreeData.dispose();
  }
}
