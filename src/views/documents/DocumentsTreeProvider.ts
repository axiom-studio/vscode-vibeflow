import * as vscode from 'vscode';

interface DocumentNode {
  id: string;
  label: string;
  description?: string;
  iconId?: string;
  collapsibleState: vscode.TreeItemCollapsibleState;
  children?: DocumentNode[];
  contextValue?: string;
}

/**
 * Documents TreeView — PRDs, architecture docs, contexts grouped by type.
 * Phase 1: static categories with no items. Will be wired to VibeFlowClient.
 */
export class DocumentsTreeProvider implements vscode.TreeDataProvider<DocumentNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<DocumentNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private rootNodes: DocumentNode[] = [
    {
      id: 'cat-prd',
      label: 'PRDs',
      description: '0',
      iconId: 'file-text',
      collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
      contextValue: 'docCategory',
      children: [],
    },
    {
      id: 'cat-architecture',
      label: 'Architecture',
      description: '0',
      iconId: 'file-code',
      collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
      contextValue: 'docCategory',
      children: [],
    },
    {
      id: 'cat-contexts',
      label: 'Contexts',
      description: '0',
      iconId: 'file',
      collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
      contextValue: 'docCategory',
      children: [],
    },
  ];

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: DocumentNode): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label, element.collapsibleState);
    item.id = element.id;
    item.description = element.description;
    item.contextValue = element.contextValue;
    if (element.iconId) {
      item.iconPath = new vscode.ThemeIcon(element.iconId);
    }
    return item;
  }

  getChildren(element?: DocumentNode): DocumentNode[] {
    if (!element) {
      return this.rootNodes;
    }
    return element.children ?? [];
  }
}
