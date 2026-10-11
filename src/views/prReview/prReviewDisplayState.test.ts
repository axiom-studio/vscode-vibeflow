import { describe, expect, it } from 'vitest';
import type { PRReviewJob, PRReviewSummary } from '../../api/prReviewTypes.js';
import { prReviewDisplayState } from './prReviewDisplayState.js';

// A summary shaped like axiomcloud's GetPRReviewSummary JSON (PRReviewSummary
// with an embedded PRReviewJob), here for PR #2 after Vera's first round.
function summary(job: Partial<PRReviewJob> = {}, rest: Partial<PRReviewSummary> = {}): Partial<PRReviewSummary> {
  return {
    review: {
      id: '65afbcc6-ae06-4754-a675-88c8a2608125',
      organization_id: 'org',
      project_id: 28,
      owner_user_id: 0,
      provider: 'github',
      provider_host: 'github.com',
      repository_id: '1243012821',
      number: 2,
      head_sha: 'head',
      base_sha: 'base',
      draft: false,
      repository_link_id: 46,
      details: { title: 't', url: 'https://github.com/o/r/pull/2', head_ref: 'fix/x', base_ref: 'main', head_repository_id: '1', head_repository_name: 'o/r', head_clone_url: '' },
      policy: { mode: 'manual', max_rounds: 4, max_attempts: 3, skip_draft: true, auto_fix: true },
      state: 'changes_requested',
      version: 5,
      rounds_started: 1,
      round_limit: 4,
      ownership_mode: 'repository',
      active_round_id: '',
      reopen_state: 'idle',
      follow_updates: false,
      created_at: 0,
      updated_at: 0,
      ...job,
    },
    unresolved_blockers: 1,
    ...rest,
  };
}

const label = (data: Partial<PRReviewSummary> | undefined) => prReviewDisplayState(data).label;

describe('prReviewDisplayState (port of the web panel derivation)', () => {
  it('reports Not reviewed when there is no review yet', () => {
    expect(label(undefined)).toBe('Not reviewed');
    expect(label({})).toBe('Not reviewed');
  });

  it('maps plain job states', () => {
    expect(label(summary({ state: 'queued' }))).toBe('Waiting for runner');
    expect(label(summary({ state: 'reviewing' }))).toBe('Reviewing');
    expect(label(summary({ state: 'paused' }))).toBe('Paused');
    expect(label(summary({ state: 'closed' }))).toBe('Closed');
    expect(label(summary({ state: 'disabled' }))).toBe('Disabled');
    expect(label(summary({ state: 'changes_requested' }))).toBe('Findings to address');
  });

  it('degrades an unknown future state instead of throwing', () => {
    expect(prReviewDisplayState(summary({ state: 'brand_new_state' }))).toMatchObject({ label: 'Needs attention', tone: 'warning' });
  });

  it('only calls a clean review Reviewed when the completed round matches the current revision', () => {
    const round = { id: 'r', job_id: 'j', number: 1, head_sha: 'head', base_sha: 'base', state: 'completed', attempt_count: 1, result: 'clean' };
    expect(label(summary({ state: 'clean' }, { last_completed_round: round, unresolved_blockers: 0 }))).toBe('Reviewed');
    expect(label(summary({ state: 'clean' }, { last_completed_round: { ...round, head_sha: 'old' }, unresolved_blockers: 0 }))).toBe('Review required');
    expect(label(summary({ state: 'clean' }, { last_completed_round: null, unresolved_blockers: 0 }))).toBe('Review required');
  });

  it('distinguishes Fixes queued from Fixing by the repair state', () => {
    const held = { id: 'b', state: 'held', reason: '', attempts: 0, deadline_at: 0, issue_count: 1, head_ref: 'fix/cli-pid-lock-root' };
    expect(prReviewDisplayState(summary({}, { repair: held }))).toMatchObject({
      label: 'Fixes queued',
      description: 'Repair tickets are waiting for a coding session on fix/cli-pid-lock-root.',
    });
    expect(label(summary({}, { repair: { ...held, state: 'claimed' } }))).toBe('Fixing');
    // No auto-fix, a draft, or no rounds left: tickets wait for a human.
    expect(label(summary({ policy: { mode: 'manual', max_rounds: 4, max_attempts: 3, skip_draft: true, auto_fix: false } }, { repair: held }))).toBe('Findings to address');
    expect(label(summary({ rounds_started: 4 }, { repair: held }))).toBe('Findings to address');
  });

  it('shows Verifying fixes once the repair is pushed', () => {
    const submitted = { id: 'b', state: 'submitted', reason: '', attempts: 1, deadline_at: 0, issue_count: 1, head_ref: 'x' };
    expect(label(summary({ state: 'queued' }, { repair: submitted }))).toBe('Verifying fixes');
    expect(label(summary({ state: 'reviewing' }, { repair: submitted }))).toBe('Verifying fixes');
  });

  it('explains why a review stopped', () => {
    const failed = { round_id: 'r', round_number: 1, attempt_number: 3, head_sha: '', base_sha: '', request_accepted: true, runner_assigned: true, checkout_prepared_at: 0, review_completed_at: 0, result_recorded: false, state: 'failed' };
    expect(label(summary({ state: 'needs_human' }, { progress: failed }))).toBe('Review could not complete');
    expect(prReviewDisplayState(summary({ state: 'needs_human', rounds_started: 4, round_limit: 4, policy: { mode: 'manual', max_rounds: 6, max_attempts: 3, skip_draft: true, auto_fix: true } })).description)
      .toBe('Review limit reached (4 of 4 rounds used on this PR). The repository maximum is now 6; Continue can use it.');
  });

  it('flags drafts waiting to be marked ready and runners needing an upgrade', () => {
    expect(label(summary({ state: 'idle', draft: true }))).toBe('Waiting for ready');
    expect(label(summary({ state: 'queued' }, { runner: { user_id: 0, state: 'offline', name: '', reason: 'runner_upgrade_required', checked_at: 0, last_seen_at: 0 } }))).toBe('Runner upgrade required');
  });
});
