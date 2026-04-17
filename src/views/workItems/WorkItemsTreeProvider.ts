import * as vscode from 'vscode';
import type { VibeFlowClient } from '../../api/client.js';
import type { VibeFlowFeature, VibeFlowTodo, VibeFlowIssue } from '../../api/types.js';

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

const STATUS_GROUP_CONFIG: { key: string; label: string; icon: string; statuses: string[] }[] = [
  { key: 'implementing', label: 'In Progress', icon: 'zap', statuses: ['implementing', 'planning'] },
  { key: 'ready', label: 'Ready', icon: 'checklist', statuses: ['ready_to_implement', 'architecture_review_complete'] },
  { key: 'review', label: 'In Review', icon: 'search', statuses: ['in_review', 'needs_pm_input', 'needs_ux_input'] },
  { key: 'done', label: 'Done', icon: 'check', statuses: ['done'] },
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
      const [features, issues] = await Promise.all([
        this.client.listFeatures(this.projectId),
        this.client.listIssues(this.projectId),
      ]);
      this.features = features;
      this.issues = issues;

      // Fetch todos for ALL features (some todos may be active even if feature is done)
      const todoLists = await Promise.all(
        features.map(f => this.client!.listTodos(f.id).catch(() => [])),
      );
      this.todos = todoLists.flat();
    } catch {
      // Keep stale data on error
    }

    this._onDidChangeTreeData.fire();
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
    const feature = this.features.find(f => f.id === todo.featureId);
    const priorityIcon = PRIORITY_ICONS[todo.priority] ?? 'dash';
    const priorityColor = PRIORITY_COLORS[todo.priority];
    const claimant = todo.claimedBy ? `@${todo.claimedBy.split('-')[0]}` : '';
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
    const claimant = issue.claimedBy ? `@${issue.claimedBy.split('-')[0]}` : '';

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

  dispose(): void {
    this.stopPolling();
    this._onDidChangeTreeData.dispose();
  }
}
