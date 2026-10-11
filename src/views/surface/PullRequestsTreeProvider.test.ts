import { describe, expect, it } from 'vitest';
import { VibeFlowClient } from '../../api/client.js';
import type { VibeFlowPullRequest } from '../../api/types.js';
import type { PRReviewSummary } from '../../api/prReviewTypes.js';
import { PullRequestsTreeProvider, pullRequestNode, pullRequestNodeId, resolveReviewTarget } from './PullRequestsTreeProvider.js';

// Rows shaped like axiomcloud ListProjectPRs `prInfo` (vibeflow_features.go).
const basePr: VibeFlowPullRequest = {
  provider: 'github',
  vibeflow_type: 'issue',
  vibeflow_id: 5742,
  pr_number: 2,
  state: 'open',
  title: 'fix(cli): check the PID lock',
  repo: 'axiom-studio/vscode-vibeflow',
  pr_url: 'https://github.com/axiom-studio/vscode-vibeflow/pull/2',
  head_ref: 'fix/cli-pid-lock-root',
};

function reviewed(state: string, extra: Partial<PRReviewSummary> = {}): VibeFlowPullRequest {
  return {
    ...basePr,
    review_job_id: 'job-1',
    review_summary: {
      review: {
        id: 'job-1', organization_id: 'o', project_id: 28, owner_user_id: 0, provider: 'github', provider_host: 'github.com',
        repository_id: '1', number: 2, head_sha: 'h', base_sha: 'b', draft: false, repository_link_id: 46,
        details: { title: '', url: '', head_ref: '', base_ref: '', head_repository_id: '', head_repository_name: '', head_clone_url: '' },
        policy: { mode: 'manual', max_rounds: 4, max_attempts: 3, skip_draft: true, auto_fix: true },
        state, version: 1, rounds_started: 1, round_limit: 4, ownership_mode: 'repository', active_round_id: '',
        reopen_state: 'idle', follow_updates: false, created_at: 0, updated_at: 0,
      },
      unresolved_blockers: 1,
      ...extra,
    } as PRReviewSummary,
  };
}

describe('pullRequestNode', () => {
  it('shows PR state and branch for a PR Vera does not track', () => {
    const node = pullRequestNode(basePr);
    expect(node.label).toBe('#2: fix(cli): check the PID lock');
    expect(node.description).toBe('open · fix/cli-pid-lock-root');
    expect(node.iconId).toBe('git-pull-request');
  });

  it('shows the Vera label, rounds and blockers for a tracked PR', () => {
    const node = pullRequestNode(reviewed('changes_requested'));
    expect(node.description).toBe('Findings to address · round 1/4 · 1 blocker');
    expect(node.iconId).toBe('warning');
    expect(node.tooltip).toContain('Vera: Findings to address.');
  });

  it('omits the blocker count when there are none and marks a clean review', () => {
    const node = pullRequestNode(reviewed('clean', {
      unresolved_blockers: 0,
      last_completed_round: { id: 'r', job_id: 'job-1', number: 1, head_sha: 'h', base_sha: 'b', state: 'completed', attempt_count: 1, result: 'clean' },
    }));
    expect(node.description).toBe('Reviewed · round 1/4');
    expect(node.iconId).toBe('pass');
  });
});

describe('resolveReviewTarget', () => {
  const repos = [{ provider: 'github' as const, provider_host: 'github.com', repository_link_id: 46, repository_name: 'Axiom-Studio/vscode-vibeflow', webhook_configured: true }];

  it('uses the tracked review\'s own repository link', () => {
    expect(resolveReviewTarget(reviewed('idle'), [])).toEqual({ provider: 'github', repositoryLinkId: 46, number: 2 });
  });

  it('matches an untracked PR to its linked repository by provider and name, case-insensitively', () => {
    expect(resolveReviewTarget(basePr, repos)).toEqual({ provider: 'github', repositoryLinkId: 46, number: 2 });
  });

  it('refuses when the repository is not linked or the PR has no number', () => {
    expect(resolveReviewTarget({ ...basePr, repo: 'someone/else' }, repos)).toBeUndefined();
    expect(resolveReviewTarget({ ...basePr, provider: 'bitbucket' }, repos)).toBeUndefined();
    expect(resolveReviewTarget({ ...basePr, pr_number: null }, repos)).toBeUndefined();
  });
});

describe('listPullRequests', () => {
  it('walks every page until has_more is false', async () => {
    const urls: string[] = [];
    const request = async (url: string) => {
      urls.push(url);
      const page = Number(new URL(url, 'http://x').searchParams.get('page'));
      return page === 1
        ? { pull_requests: Array.from({ length: 100 }, (_, i) => ({ ...basePr, pr_number: i + 1 })), has_more: true }
        : { pull_requests: [{ ...basePr, pr_number: 101 }], has_more: false };
    };
    const prs = await VibeFlowClient.prototype.listPullRequests.call({ request } as unknown as VibeFlowClient, 28);
    expect(prs).toHaveLength(101);
    expect(prs[100].pr_number).toBe(101);
    expect(urls).toEqual(['/rest/v1/vibeflow/projects/28/prs?page=1&limit=100', '/rest/v1/vibeflow/projects/28/prs?page=2&limit=100']);
  });
});

describe('PullRequestsTreeProvider project binding', () => {
  it('never hands out a row under a project other than the one it was listed in', async () => {
    const pending = new Map<number, (rows: VibeFlowPullRequest[]) => void>();
    const client = {
      listPullRequests: (projectId: number) => new Promise<VibeFlowPullRequest[]>(r => pending.set(projectId, r)),
    } as unknown as VibeFlowClient;
    const provider = new PullRequestsTreeProvider();
    const rowA = { ...basePr, pr_number: 2 };
    const rowB = { ...basePr, pr_number: 3, vibeflow_id: 9 };

    provider.connect(client, 10);
    pending.get(10)!([rowA]);
    await Promise.resolve();
    expect(provider.getPullRequest(pullRequestNodeId(rowA))).toEqual({ pr: rowA, projectId: 10 });

    // Switch to 20: A's rows are dropped immediately, not when B's list lands.
    provider.connect(client, 20);
    expect(provider.getPullRequest(pullRequestNodeId(rowA))).toBeUndefined();

    // B resolves first, then a late A response arrives and must be ignored.
    provider.connect(client, 10);
    provider.connect(client, 20);
    pending.get(20)!([rowB]);
    pending.get(10)!([rowA]);
    await new Promise(r => setTimeout(r, 0));
    expect(provider.getPullRequest(pullRequestNodeId(rowA))).toBeUndefined();
    expect(provider.getPullRequest(pullRequestNodeId(rowB))).toEqual({ pr: rowB, projectId: 20 });
    provider.dispose();
  });
});
