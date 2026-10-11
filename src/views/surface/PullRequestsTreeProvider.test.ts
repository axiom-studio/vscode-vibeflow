import { describe, expect, it } from 'vitest';
import type { VibeFlowPullRequest } from '../../api/types.js';
import type { PRReviewSummary } from '../../api/prReviewTypes.js';
import { pullRequestNode, resolveReviewTarget } from './PullRequestsTreeProvider.js';

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

  it('opens the review panel for a tracked PR and the browser otherwise', () => {
    expect(pullRequestNode(reviewed('changes_requested')).command?.command).toBe('vibeflow.openPrReview');
    expect(pullRequestNode(basePr).command?.command).toBe('vscode.open');
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
