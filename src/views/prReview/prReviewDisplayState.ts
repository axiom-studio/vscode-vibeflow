import type { PRReviewSummary } from '../../api/prReviewTypes.js';

export type PRReviewTone = 'muted' | 'info' | 'warning' | 'success';

export interface PRReviewDisplayState {
  label: string;
  tone: PRReviewTone;
  description: string;
}

type Row = [string, PRReviewTone, string];

/**
 * The review state a user sees, derived exactly as the web review panel does
 * (axiomcloud frontend/src/components/vibeflow/PRReviewPanel.jsx
 * `getPRReviewDisplayState`, origin/main 2026-10-11), so the extension and
 * the web UI never disagree on a PR's label. The server stores coarse job
 * states; labels like "Fixes queued" and "Verifying fixes" combine the job
 * with its repair, progress and runner. Keep this in lockstep with that file.
 */
export function prReviewDisplayState(data: Partial<PRReviewSummary> | undefined): PRReviewDisplayState {
  const job = data?.review;
  if (!job) { return { label: 'Not reviewed', tone: 'muted', description: 'Request a review of this pull request.' }; }
  const states: Record<string, Row> = {
    disabled: ['Disabled', 'muted', 'Enable reviews in repository settings to start.'],
    paused: ['Paused', 'warning', 'Reviews and automatic repairs are paused. Continue when you are ready.'],
    needs_human: ['Needs attention', 'warning', 'This review has stopped. Check the remaining rounds and findings before continuing.'],
    closed: ['Closed', 'muted', 'The pull request is closed. Review and repair work has stopped.'],
    reviewing: ['Reviewing', 'info', 'The review agent is checking the exact base and head shown below.'],
    queued: ['Waiting for runner', 'info', 'The review is queued for an eligible runner.'],
    idle: ['Not reviewed', 'muted', 'Request a review of the current revision.'],
    changes_requested: ['Findings to address', 'warning', 'Unresolved findings remain. A fresh review must verify any fixes.'],
    clean: ['Reviewed', 'success', 'The current revision has an accepted review with no unresolved blockers.'],
  };
  let [label, tone, description]: Row = states[job.state] ?? ['Needs attention', 'warning', 'Refresh to see the latest review status.'];
  const completed = data.last_completed_round;
  if (job.state === 'clean' && (!completed || completed.head_sha !== job.head_sha || completed.base_sha !== job.base_sha || (data.unresolved_blockers ?? 0) > 0)) {
    [label, tone, description] = ['Review required', 'warning', 'The current base and head do not have a complete, blocker-free review.'];
  }
  if (job.state === 'idle' && job.draft && job.policy?.skip_draft) {
    [label, tone, description] = ['Waiting for ready', 'muted', 'Automatic reviews skip drafts. Authorized project members can request a draft review explicitly.'];
  }
  if (job.state === 'changes_requested') {
    if (data.repair?.state === 'claimed') {
      [label, tone, description] = ['Fixing', 'info', 'The coding agent is repairing the linked issues in one update to this PR.'];
    } else if (data.repair?.state === 'held' && job.policy?.auto_fix && !job.draft && job.rounds_started < job.round_limit) {
      [label, tone, description] = ['Fixes queued', 'info', data.repair.head_ref
        ? `Repair tickets are waiting for a coding session on ${data.repair.head_ref}.`
        : 'Repair tickets are waiting for an eligible coding agent.'];
    }
  }
  if (job.state === 'needs_human') {
    if (data.progress && ['failed', 'expired'].includes(data.progress.state)) {
      [label, tone, description] = ['Review could not complete', 'warning', `The review runner failed ${data.progress.attempt_number} of ${job.policy?.max_attempts || data.progress.attempt_number} attempts on this revision. Check the review runner, then Continue to retry.`];
    } else if (job.rounds_started >= job.round_limit) {
      const raised = job.policy?.max_rounds > job.round_limit ? ` The repository maximum is now ${job.policy.max_rounds}; Continue can use it.` : '';
      [label, tone, description] = ['Review limit reached', 'warning', `Review limit reached (${job.rounds_started} of ${job.round_limit} rounds used on this PR).${raised}`];
    }
  }
  if (job.state === 'queued' && data.runner?.reason === 'runner_upgrade_required') {
    [label, tone, description] = ['Runner upgrade required', 'warning', 'This review remains queued. Upgrade the VibeFlow CLI and restart Vera.'];
  }
  if (data.repair?.state === 'submitted' && (job.state === 'queued' || job.state === 'reviewing')) {
    [label, tone, description] = ['Verifying fixes', 'info', job.state === 'queued'
      ? 'The repair is pushed. A fresh verification review is waiting for a runner.'
      : 'A fresh review is verifying the pushed repair.'];
  }
  return { label, tone, description };
}
