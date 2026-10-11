import * as vscode from 'vscode';
import type { VibeFlowClient } from '../../api/client.js';
import type { VibeFlowPullRequest } from '../../api/types.js';
import type { PRReviewProvider, PRReviewRepositorySummary } from '../../api/prReviewTypes.js';
import { prReviewDisplayState, type PRReviewTone } from '../prReview/prReviewDisplayState.js';
import type { SimpleNode } from './surfaceNodes.js';
import { toTreeItem } from './surfaceNodes.js';

/**
 * Pull Requests tree — lists the project's PRs via GET /projects/{id}/prs
 * (ListProjectPRs, server-side). Each row shows its Vera review state, rounds
 * and blockers when the PR is tracked for review (#4039). Clicking a row opens
 * the PR in the browser.
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
    return pullRequestNode(pr);
  }

  /** The PR behind a tree node, for context-menu commands. */
  getPullRequest(nodeId: string): VibeFlowPullRequest | undefined {
    return this.prs.find(pr => pullRequestNodeId(pr) === nodeId);
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

export function pullRequestNodeId(pr: VibeFlowPullRequest): string {
  return `pr-${pr.vibeflow_type || 'review'}-${pr.vibeflow_id || pr.review_job_id || 0}-${pr.pr_number ?? 'na'}`;
}

const TONE_ICON: Record<PRReviewTone, { iconId: string; iconColor?: string }> = {
  success: { iconId: 'pass', iconColor: 'charts.green' },
  warning: { iconId: 'warning', iconColor: 'charts.yellow' },
  info: { iconId: 'sync', iconColor: 'charts.blue' },
  muted: { iconId: 'git-pull-request' },
};

/**
 * One PR row. A PR Vera tracks shows its review label (identical to the web
 * panel's), rounds used and unresolved blockers; others show PR state + branch.
 */
export function pullRequestNode(pr: VibeFlowPullRequest): SimpleNode {
  const num = pr.pr_number ?? undefined;
  const label = num != null
    ? `#${num}: ${pr.title || pr.repo}`
    : (pr.title || pr.repo || 'Pull request');
  const summary = pr.review_summary;
  let description = [pr.state, pr.head_ref].filter(Boolean).join(' · ');
  let tooltip = pr.pr_url;
  let icon: { iconId: string; iconColor?: string } = TONE_ICON.muted;
  if (summary?.review) {
    const display = prReviewDisplayState(summary);
    const job = summary.review;
    const blockers = summary.unresolved_blockers;
    description = [
      display.label,
      `round ${job.rounds_started}/${job.round_limit}`,
      blockers > 0 ? `${blockers} blocker${blockers === 1 ? '' : 's'}` : '',
    ].filter(Boolean).join(' · ');
    tooltip = `Vera: ${display.label}. ${display.description}${pr.pr_url ? `\n${pr.pr_url}` : ''}`;
    icon = TONE_ICON[display.tone];
  }
  return {
    id: pullRequestNodeId(pr),
    label,
    description,
    tooltip,
    ...icon,
    collapsibleState: vscode.TreeItemCollapsibleState.None,
    contextValue: 'pullRequest',
    command: pr.pr_url
      ? { command: 'vscode.open', title: 'Open Pull Request', arguments: [vscode.Uri.parse(pr.pr_url)] }
      : undefined,
  };
}

export interface PRReviewTarget {
  provider: PRReviewProvider;
  repositoryLinkId: number;
  number: number;
}

/**
 * Where to send a review request for a PR row. A tracked PR carries its own
 * provider + repository link; an untracked one is matched to a linked
 * repository by provider and full name (`owner/repo`), case-insensitively.
 * Undefined when the PR has no number or its repository is not linked.
 */
export function resolveReviewTarget(
  pr: VibeFlowPullRequest,
  repositories: readonly PRReviewRepositorySummary[],
): PRReviewTarget | undefined {
  if (pr.pr_number == null) { return undefined; }
  const job = pr.review_summary?.review;
  if (job) {
    return { provider: job.provider, repositoryLinkId: job.repository_link_id, number: pr.pr_number };
  }
  const repo = repositories.find(r =>
    r.provider === pr.provider && r.repository_name.toLowerCase() === pr.repo.toLowerCase());
  return repo ? { provider: repo.provider, repositoryLinkId: repo.repository_link_id, number: pr.pr_number } : undefined;
}
