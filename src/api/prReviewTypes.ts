/**
 * Vera PR review API shapes (#4038, design doc #627 §4).
 *
 * Every type mirrors the JSON the axiomcloud producer actually encodes, not
 * the web UI's usage of it. Sources (axiomcloud origin/main, 2026-10-11):
 *   - routes:   handlers/vibeflow_pr_reviews.go RegisterPRReviewRoutes,
 *               mounted on /rest/v1/vibeflow (main.go:2111)
 *   - job:      database/vibeflow_pr_reviews.go PRReviewJob / PRReviewInput /
 *               PRReviewDetails / PRReviewPolicy / PRReviewScope / PRReviewRound
 *   - summary:  database/vibeflow_pr_review_summaries.go PRReviewSummary and
 *               its Owner / Action / Runner / Repair / Publication parts
 *   - progress: database/vibeflow_pr_review_execution.go PRReviewProgress
 *   - finding:  database/vibeflow_pr_review_findings.go PRReviewFinding /
 *               PRReviewFindingInput / PRReviewFindingDecision
 * Fields the Go structs tag `json:"-"` are deliberately absent.
 */

export type PRReviewProvider = 'github' | 'bitbucket' | 'azure_devops';

/**
 * Server job state (PRReviewJob.State): idle | queued | reviewing | clean |
 * changes_requested | needs_human | paused | closed | disabled. Typed as a
 * plain string because the server may add states; display code must default.
 */
export type PRReviewJobState = string;

export interface PRReviewPolicy {
  /** disabled | manual | once | every_update */
  mode: string;
  max_rounds: number;
  max_attempts: number;
  skip_draft: boolean;
  auto_fix: boolean;
  max_questions?: number;
  questions_off?: boolean;
}

export interface PRReviewDetails {
  title: string;
  url: string;
  head_ref: string;
  base_ref: string;
  head_repository_id: string;
  head_repository_name: string;
  head_clone_url: string;
  base_repository_name?: string;
  base_clone_url?: string;
}

/** PRReviewJob with its embedded PRReviewScope + PRReviewInput flattened. */
export interface PRReviewJob {
  id: string;
  organization_id: string;
  project_id: number;
  owner_user_id: number;
  provider: PRReviewProvider;
  provider_host: string;
  repository_id: string;
  number: number;
  head_sha: string;
  base_sha: string;
  draft: boolean;
  repository_link_id: number;
  details: PRReviewDetails;
  policy: PRReviewPolicy;
  state: PRReviewJobState;
  version: number;
  rounds_started: number;
  round_limit: number;
  /** repository (GitHub: shared by the project) | user-owned (Bitbucket/Azure) */
  ownership_mode: string;
  active_round_id: string;
  reopen_state: string;
  follow_updates: boolean;
  created_at: number;
  updated_at: number;
}

export interface PRReviewRound {
  id: string;
  job_id: string;
  number: number;
  head_sha: string;
  base_sha: string;
  state: string;
  attempt_count: number;
  result: string;
}

export interface PRReviewProgress {
  round_id: string;
  round_number: number;
  attempt_number: number;
  head_sha: string;
  base_sha: string;
  request_accepted: boolean;
  runner_assigned: boolean;
  checkout_prepared_at: number;
  review_completed_at: number;
  result_recorded: boolean;
  state: string;
}

export interface PRReviewSummaryAction {
  allowed: boolean;
  reason: string;
  minimum_additional_rounds?: number;
}

/** Keys the server sets in PRReviewSummary.Actions (summaries.go set(...)). */
export type PRReviewActionName = 'review' | 'pause' | 'resume' | 'dismiss' | 'reopen' | 'retry_publication';

export interface PRReviewSummaryRunner {
  user_id: number;
  runner_selection?: string;
  preferred_runner_id?: string;
  state: string;
  name: string;
  reason: string;
  checked_at: number;
  last_seen_at: number;
}

export interface PRReviewSummaryRepair {
  id: string;
  /** held | claimed | submitted | cancelled | failed */
  state: string;
  reason: string;
  attempts: number;
  deadline_at: number;
  issue_count: number;
  head_ref: string;
}

export interface PRReviewSummaryPublication {
  generation: number;
  /** e.g. published | blocked | failed */
  state: string;
  attempts: number;
  last_error: string;
  next_attempt_at: number;
  updated_at: number;
}

export interface PRReviewSummary {
  review: PRReviewJob;
  owner: { user_id: number; name: string };
  progress: PRReviewProgress | null;
  last_completed_round: PRReviewRound | null;
  /** Vera's latest summary, GitHub Flavored Markdown. Untrusted text. */
  summary: string;
  finding_count: number;
  unresolved_blockers: number;
  repair: PRReviewSummaryRepair | null;
  publication: PRReviewSummaryPublication | null;
  runner: PRReviewSummaryRunner;
  actions: Partial<Record<PRReviewActionName, PRReviewSummaryAction>>;
  questions_asked: number;
  question_limit: number;
}

export interface PRReviewFindingDecision {
  action: string;
  actor_user_id: number;
  reason: string;
  evidence?: string;
  decided_at: number;
}

export interface PRReviewFinding {
  id: string;
  job_id: string;
  repair_issue_id?: number;
  key: string;
  title: string;
  /** blocker | advisory */
  severity: string;
  path: string;
  line: number;
  symbol?: string;
  trigger: string;
  impact: string;
  evidence: string;
  verification: string;
  /** present | uncertain | fixed | dismissed */
  state: string;
  head_sha: string;
  base_sha: string;
  human_decision?: PRReviewFindingDecision;
  created_at: number;
  updated_at: number;
}

export interface PRReviewRepositorySummary {
  provider: PRReviewProvider;
  provider_host: string;
  repository_link_id: number;
  repository_name: string;
  webhook_configured: boolean;
}

/** One page of a cursor-paged list (`after_id` → `next_after_id`). */
export interface PRReviewPage<T> {
  items: T[];
  nextAfterId: string;
}

/** POST /projects/{id}/pr-reviews (RequestPRReview). */
export interface RequestPRReviewBody {
  provider: PRReviewProvider;
  repository_link_id: number;
  number: number;
  /** Idempotency key, 1-160 chars. */
  request_id: string;
}

/** POST /projects/{id}/pr-reviews/{job}/control (ControlPRReview). */
export interface ControlPRReviewBody {
  request_id: string;
  expected_version: number;
  action: 'pause' | 'resume';
  /** 0-20; must be 0 for pause. */
  additional_rounds: number;
  /** Required, at most 2000 chars. */
  reason: string;
}

/** POST /projects/{id}/pr-reviews/{job}/findings/{finding}/control. */
export interface ControlPRReviewFindingBody {
  request_id: string;
  expected_version: number;
  action: 'dismiss' | 'reopen';
  reason: string;
  /** Required for reopen, at most 8192 chars. */
  evidence?: string;
}

/** POST /projects/{id}/pr-reviews/{job}/publication/retry. */
export interface RetryPRReviewPublicationBody {
  request_id: string;
  expected_generation: number;
}
