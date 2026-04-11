import * as vscode from 'vscode';

interface WorkItemNode {
  id: string;
  label: string;
  description?: string;
  iconId?: string;
  collapsibleState: vscode.TreeItemCollapsibleState;
  children?: WorkItemNode[];
  contextValue?: string;
}

/**
 * Work Items TreeView — features/todos/issues grouped by status.
 * Phase 1: static groups with no items. Will be wired to VibeFlowClient.
 */
export class WorkItemsTreeProvider implements vscode.TreeDataProvider<WorkItemNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<WorkItemNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private rootNodes: WorkItemNode[] = [
    {
      id: 'group-in-progress',
      label: 'In Progress',
      description: '0',
      iconId: 'zap',
      collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
      contextValue: 'statusGroup',
      children: [],
    },
    {
      id: 'group-ready',
      label: 'Ready',
      description: '0',
      iconId: 'checklist',
      collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
      contextValue: 'statusGroup',
      children: [],
    },
    {
      id: 'group-in-review',
      label: 'In Review',
      description: '0',
      iconId: 'search',
      collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
      contextValue: 'statusGroup',
      children: [],
    },
    {
      id: 'group-done',
      label: 'Done',
      description: '0',
      iconId: 'check',
      collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
      contextValue: 'statusGroup',
      children: [],
    },
  ];

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: WorkItemNode): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label, element.collapsibleState);
    item.id = element.id;
    item.description = element.description;
    item.contextValue = element.contextValue;
    if (element.iconId) {
      item.iconPath = new vscode.ThemeIcon(element.iconId);
    }
    return item;
  }

  getChildren(element?: WorkItemNode): WorkItemNode[] {
    if (!element) {
      return this.rootNodes;
    }
    return element.children ?? [];
  }
}
