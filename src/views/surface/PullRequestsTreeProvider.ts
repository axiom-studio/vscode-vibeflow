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
  /** The project `prs` was fetched for, so a row is never acted on in another project. */
  private prsProjectId: number | undefined;
  /** Bumped per fetch; only the latest fetch may replace `prs` or move the notification baseline. */
  private fetchSeq = 0;
  /** Last review label seen per review job; undefined until the first load. */
  private reviewLabels: Map<string, string> | undefined;
  /** Fired with PRs whose review newly reached a state worth a toast (#4041). */
  private readonly _onDidReviewChange = new vscode.EventEmitter<ReviewTransition[]>();
  readonly onDidReviewChange = this._onDidReviewChange.event;

  connect(client: VibeFlowClient, projectId: number): void {
    this.client = client;
    if (projectId !== this.projectId) {
      // Drop the old project's rows now rather than when the new list lands.
      this.prs = [];
      this.prsProjectId = undefined;
    }
    this.projectId = projectId;
    this.reviewLabels = undefined; // a new project starts a new baseline
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
    const seq = ++this.fetchSeq;
    const projectId = this.projectId;
    let prs: VibeFlowPullRequest[] | undefined;
    try {
      prs = await this.client.listPullRequests(projectId);
    } catch {
      prs = undefined;
    }
    if (seq !== this.fetchSeq) { return; } // a newer fetch (or project) superseded this one
    this.prs = prs ?? [];
    this.prsProjectId = projectId;
    if (prs) {
      // Only the latest poll moves the notification baseline: a slower, older
      // response would roll it back and re-announce a completion.
      const { transitions, labels } = reviewTransitions(this.reviewLabels, prs);
      this.reviewLabels = labels;
      if (transitions.length) { this._onDidReviewChange.fire(transitions); }
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

  /** The PR behind a tree node and the project it was listed in, for context-menu commands. */
  getPullRequest(nodeId: string): { pr: VibeFlowPullRequest; projectId: number } | undefined {
    const pr = this.prs.find(p => pullRequestNodeId(p) === nodeId);
    return pr && this.prsProjectId !== undefined ? { pr, projectId: this.prsProjectId } : undefined;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    this._onDidReviewChange.dispose();
  }
}

export interface ReviewTransition {
  pr: VibeFlowPullRequest;
  label: string;
}

/** Review outcomes worth interrupting for. */
const NOTIFY_LABELS = new Set(['Reviewed', 'Findings to address']);

/**
 * Diff review labels between two loads of the PR list (#4041). Reports a PR
 * only when its label CHANGES into Reviewed / Findings to address, never on
 * the first load (no baseline) and never twice for the same label, so a
 * refresh cadence cannot repeat a toast. O(n) in PRs.
 */
export function reviewTransitions(
  previous: ReadonlyMap<string, string> | undefined,
  prs: readonly VibeFlowPullRequest[],
): { transitions: ReviewTransition[]; labels: Map<string, string> } {
  const labels = new Map<string, string>();
  const transitions: ReviewTransition[] = [];
  for (const pr of prs) {
    if (!pr.review_job_id || !pr.review_summary) { continue; }
    const label = prReviewDisplayState(pr.review_summary).label;
    labels.set(pr.review_job_id, label);
    const before = previous?.get(pr.review_job_id);
    if (previous && before !== label && NOTIFY_LABELS.has(label)) {
      transitions.push({ pr, label });
    }
  }
  return { transitions, labels };
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
    // A PR Vera tracks opens its review panel (#4040); others open in the browser.
    command: pr.review_job_id
      ? { command: 'vibeflow.openPrReview', title: 'Open Review', arguments: [pullRequestNodeId(pr)] }
      : pr.pr_url
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
