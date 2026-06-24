import * as vscode from 'vscode';
import type { VibeFlowClient } from '../../api/client.js';
import type { VibeFlowPullRequest } from '../../api/types.js';
import type { SimpleNode } from './surfaceNodes.js';
import { toTreeItem } from './surfaceNodes.js';

/**
 * Pull Requests tree — lists the project's PRs via GET /projects/{id}/prs
 * (ListProjectPRs, server-side). Clicking a row opens the PR in the browser.
 */
export class PullRequestsTreeProvider implements vscode.TreeDataProvider<SimpleNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SimpleNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private client: VibeFlowClient | undefined;
  private projectId: number | undefined;
  private prs: VibeFlowPullRequest[] = [];

  connect(client: VibeFlowClient, projectId: number): void {
    this.client = client;
    this.projectId = projectId;
    void this.fetch();
  }

  refresh(): void {
    void this.fetch();
  }

  private async fetch(): Promise<void> {
    if (!this.client || this.projectId === undefined) {
      this._onDidChangeTreeData.fire();
      return;
    }
    try {
      this.prs = await this.client.listPullRequests(this.projectId);
    } catch {
      this.prs = [];
    }
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: SimpleNode): vscode.TreeItem {
    return toTreeItem(node);
  }

  getChildren(element?: SimpleNode): SimpleNode[] {
    if (element) {
      return element.children ?? [];
    }
    if (this.prs.length === 0) {
      return [{
        id: 'empty',
        label: 'No pull requests',
        iconId: 'git-pull-request',
        collapsibleState: vscode.TreeItemCollapsibleState.None,
      }];
    }
    return this.prs.map(pr => this.prNode(pr));
  }

  private prNode(pr: VibeFlowPullRequest): SimpleNode {
    const num = pr.pr_number ?? undefined;
    const label = num != null
      ? `#${num}: ${pr.title || pr.repo}`
      : (pr.title || pr.repo || 'Pull request');
    const desc = [pr.state, pr.head_ref].filter(Boolean).join(' · ');
    return {
      id: `pr-${pr.vibeflow_type}-${pr.vibeflow_id}-${num ?? 'na'}`,
      label,
      description: desc,
      tooltip: pr.pr_url,
      iconId: 'git-pull-request',
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      contextValue: 'pullRequest',
      command: pr.pr_url
        ? { command: 'vscode.open', title: 'Open Pull Request', arguments: [vscode.Uri.parse(pr.pr_url)] }
        : undefined,
    };
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
