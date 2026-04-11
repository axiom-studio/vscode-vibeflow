import * as vscode from 'vscode';
import type { VibeFlowClient } from '../../api/client.js';
import type { VibeFlowDocument } from '../../api/types.js';

interface DocumentNode {
  id: string;
  label: string;
  description?: string;
  iconId?: string;
  collapsibleState: vscode.TreeItemCollapsibleState;
  children?: DocumentNode[];
  contextValue?: string;
  docId?: number;
}

const TYPE_CONFIG: { key: VibeFlowDocument['type']; label: string; icon: string }[] = [
  { key: 'prd', label: 'PRDs', icon: 'file-text' },
  { key: 'architecture', label: 'Architecture', icon: 'file-code' },
  { key: 'style_guide', label: 'Style Guides', icon: 'paintcan' },
  { key: 'design_system', label: 'Design System', icon: 'symbol-color' },
  { key: 'general', label: 'General', icon: 'file' },
];

/**
 * Documents TreeView — PRDs, architecture docs, contexts grouped by type.
 * Wired to live API data with on-demand refresh.
 */
export class DocumentsTreeProvider implements vscode.TreeDataProvider<DocumentNode>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<DocumentNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private client: VibeFlowClient | undefined;
  private projectId: number | undefined;
  private documents: VibeFlowDocument[] = [];

  refresh(): void {
    this.fetchAndRefresh();
  }

  connect(client: VibeFlowClient, projectId: number): void {
    this.client = client;
    this.projectId = projectId;
    this.fetchAndRefresh();
  }

  private async fetchAndRefresh(): Promise<void> {
    if (!this.client || !this.projectId) {
      this._onDidChangeTreeData.fire();
      return;
    }

    try {
      this.documents = await this.client.listDocuments(this.projectId);
    } catch {
      // Keep stale
    }
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
    // Click a document → open viewer panel
    if (element.docId) {
      item.command = {
        command: 'vibeflow.openDocumentViewer',
        title: 'Open Document',
        arguments: [element.docId, element.label],
      };
    }
    return item;
  }

  getChildren(element?: DocumentNode): DocumentNode[] {
    if (!element) {
      return this.buildCategoryTree();
    }
    return element.children ?? [];
  }

  private buildCategoryTree(): DocumentNode[] {
    return TYPE_CONFIG.map(cat => {
      const docs = this.documents.filter(d => d.type === cat.key);
      return {
        id: `cat-${cat.key}`,
        label: cat.label,
        description: `${docs.length}`,
        iconId: cat.icon,
        collapsibleState: docs.length > 0
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None,
        contextValue: 'docCategory',
        children: docs.map(d => ({
          id: `doc-${d.id}`,
          label: d.title,
          iconId: 'file',
          collapsibleState: vscode.TreeItemCollapsibleState.None,
          contextValue: 'document',
          docId: d.id,
        })),
      };
    }).filter(cat => cat.children!.length > 0 || this.documents.length === 0);
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
