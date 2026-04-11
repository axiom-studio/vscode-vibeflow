import * as vscode from 'vscode';

interface SessionNode {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  iconId?: string;
  collapsibleState: vscode.TreeItemCollapsibleState;
  children?: SessionNode[];
  contextValue?: string;
}

/**
 * Agent Fleet TreeView — shows sessions grouped by branch.
 * Phase 1: placeholder data. Will be wired to VibeFlowClient.
 */
export class SessionsTreeProvider implements vscode.TreeDataProvider<SessionNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SessionNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private rootNodes: SessionNode[] = this.buildPlaceholderTree();

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SessionNode): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label, element.collapsibleState);
    item.id = element.id;
    item.description = element.description;
    item.tooltip = element.tooltip;
    item.contextValue = element.contextValue;
    if (element.iconId) {
      item.iconPath = new vscode.ThemeIcon(element.iconId);
    }
    return item;
  }

  getChildren(element?: SessionNode): SessionNode[] {
    if (!element) {
      return this.rootNodes;
    }
    return element.children ?? [];
  }

  private buildPlaceholderTree(): SessionNode[] {
    return [
      {
        id: 'branch-main',
        label: 'main',
        description: '0 active',
        collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
        contextValue: 'branch',
        children: [
          {
            id: 'placeholder-empty',
            label: 'No active sessions',
            description: 'Launch a session to get started',
            iconId: 'circle-outline',
            collapsibleState: vscode.TreeItemCollapsibleState.None,
            contextValue: 'placeholder',
          },
        ],
      },
    ];
  }
}
