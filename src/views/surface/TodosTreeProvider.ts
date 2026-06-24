import * as vscode from 'vscode';
import type { WorkItemsTreeProvider } from '../workItems/WorkItemsTreeProvider.js';
import type { VibeFlowTodo } from '../../api/types.js';
import type { SimpleNode } from './surfaceNodes.js';
import { toTreeItem } from './surfaceNodes.js';

const TODO_GROUPS: { key: string; label: string; icon: string; statuses: string[] }[] = [
  { key: 'active', label: 'In Progress', icon: 'zap', statuses: ['implementing', 'planning'] },
  { key: 'ready', label: 'Ready', icon: 'checklist', statuses: ['ready_to_implement', 'architecture_review_complete'] },
  { key: 'review', label: 'In Review', icon: 'search', statuses: ['in_review', 'needs_pm_input', 'needs_ux_input'] },
  { key: 'done', label: 'Done', icon: 'check', statuses: ['done'] },
  { key: 'closed', label: 'Closed', icon: 'archive', statuses: ['archived', 'rejected'] },
];

/**
 * Dedicated Todos tree — todos only (issues live under Project Items), grouped
 * by status. Derives from WorkItemsTreeProvider's already-fetched data, so it
 * adds zero network calls; it just re-renders on that provider's refresh event.
 */
export class TodosTreeProvider implements vscode.TreeDataProvider<SimpleNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SimpleNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly workItems: WorkItemsTreeProvider) {
    this.sub = this.workItems.onDidRefresh(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(node: SimpleNode): vscode.TreeItem {
    return toTreeItem(node);
  }

  getChildren(element?: SimpleNode): SimpleNode[] {
    if (element) {
      return element.children ?? [];
    }
    const todos = this.workItems.getTodos();
    return TODO_GROUPS.map(group => {
      const items = todos.filter(t => group.statuses.includes(t.status));
      const expanded = items.length > 0 && group.key !== 'done' && group.key !== 'closed';
      const node: SimpleNode = {
        id: `todos-group-${group.key}`,
        label: group.label,
        description: `${items.length}`,
        iconId: group.icon,
        collapsibleState: expanded
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
        contextValue: 'todosGroup',
        children: items.map(t => this.todoNode(t)),
      };
      return node;
    });
  }

  private todoNode(todo: VibeFlowTodo): SimpleNode {
    return {
      id: `todo-${todo.id}`,
      label: `#${todo.id}: ${todo.title}`,
      description: todo.feature_name ?? '',
      iconId: 'issues',
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      contextValue: `todo-${todo.status}`,
      command: {
        command: 'vibeflow.openWorkItemPanel',
        title: 'View Details',
        arguments: [`todo-${todo.id}`, todo.title, todo.status],
      },
    };
  }

  dispose(): void {
    this.sub.dispose();
    this._onDidChangeTreeData.dispose();
  }
}
