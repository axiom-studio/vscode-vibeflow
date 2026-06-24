import * as vscode from 'vscode';
import type { WorkItemsTreeProvider } from '../workItems/WorkItemsTreeProvider.js';
import type { SimpleNode } from './surfaceNodes.js';
import { toTreeItem } from './surfaceNodes.js';

/** Minimal shape both todos and issues satisfy for review-queue filtering. */
interface Reviewable {
  status: string;
  security_reviewed?: boolean;
  qa_verified?: boolean;
}

/**
 * Parameterized review-queue tree, reused for both Security Review and Pending
 * QA. Shows the todos + issues matching a predicate, derived from
 * WorkItemsTreeProvider's data (no own network calls — re-renders on its refresh).
 */
export class ReviewQueueTreeProvider implements vscode.TreeDataProvider<SimpleNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SimpleNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly sub: vscode.Disposable;

  constructor(
    private readonly workItems: WorkItemsTreeProvider,
    private readonly predicate: (item: Reviewable) => boolean,
    private readonly emptyLabel: string,
  ) {
    this.sub = this.workItems.onDidRefresh(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(node: SimpleNode): vscode.TreeItem {
    return toTreeItem(node);
  }

  getChildren(element?: SimpleNode): SimpleNode[] {
    if (element) {
      return element.children ?? [];
    }
    const rows: SimpleNode[] = [
      ...this.workItems.getTodos().filter(t => this.predicate(t)).map(t => this.row('todo', t.id, t.title)),
      ...this.workItems.getIssues().filter(i => this.predicate(i)).map(i => this.row('issue', i.id, i.title)),
    ];
    if (rows.length === 0) {
      return [{
        id: 'empty',
        label: this.emptyLabel,
        iconId: 'check',
        collapsibleState: vscode.TreeItemCollapsibleState.None,
      }];
    }
    return rows;
  }

  private row(type: 'todo' | 'issue', id: number, title: string): SimpleNode {
    return {
      id: `${type}-${id}`,
      label: `#${id}: ${title}`,
      iconId: type === 'todo' ? 'issues' : 'bug',
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      contextValue: type,
      command: {
        command: 'vibeflow.openWorkItemPanel',
        title: 'View Details',
        arguments: [`${type}-${id}`, title, ''],
      },
    };
  }

  dispose(): void {
    this.sub.dispose();
    this._onDidChangeTreeData.dispose();
  }
}
