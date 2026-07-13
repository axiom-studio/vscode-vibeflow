// Typed postMessage protocol for extension <-> webview communication.
// This abstraction allows swapping transport (postMessage -> gRPC) without touching consumers.

export type MessageType =
  | 'activityEntry'
  | 'activityEntries'
  | 'clearActivity'
  | 'respondToPrompt'
  | 'ready';

export interface Message<T extends MessageType = MessageType, P = unknown> {
  type: T;
  payload: P;
}

// --- Extension -> Webview messages ---

export interface ActivityEntry {
  id: string;
  timestamp: string;
  personaKey: string;
  personaName: string;
  messageType:
    | 'status_change'
    | 'thinking'
    | 'action'
    | 'observation'
    | 'prompt'
    | 'commit'
    | 'completion'
    | 'error'
    | 'summary';
  content: string;
  metadata?: Record<string, unknown>;
}

export type ActivityEntryMessage = Message<'activityEntry', ActivityEntry>;
export type ActivityEntriesMessage = Message<'activityEntries', ActivityEntry[]>;
export type ClearActivityMessage = Message<'clearActivity', undefined>;

// --- Webview -> Extension messages ---

export interface PromptResponsePayload {
  promptId: string;
  response: string;
}

export type RespondToPromptMessage = Message<'respondToPrompt', PromptResponsePayload>;
export type ReadyMessage = Message<'ready', undefined>;

// Union types for type-safe message handling
export type ExtensionToWebviewMessage =
  | ActivityEntryMessage
  | ActivityEntriesMessage
  | ClearActivityMessage;

export type WebviewToExtensionMessage =
  | RespondToPromptMessage
  | ReadyMessage;

// --- MCP API response types (placeholders) ---

export interface VibeFlowProject {
  id: number;
  name: string;
  status: string;
  /** Backend wire is `git_remote_url` — see VibeflowSession.git_remote_url field for shape. */
  git_remote_url?: string;
}

/**
 * Matches axiomcloud /rest/v1/vibeflow/sessions/active response shape exactly.
 * snake_case fields are intentional — this mirrors the wire format.
 */
export interface VibeFlowSession {
  id: number; // DB row ID
  session_id: string; // "session-20260411-200221-e9cdf438"
  project_id: number;
  working_directory: string;
  git_branch: string;
  git_remote_url?: string;
  git_worktree_path?: string;
  agent_type: string;
  agent_model: string;
  persona_key: string;
  persona_name?: string;
  persona_desc?: string;
  character_name?: string;
  avatar_path?: string;
  last_message?: string;
  last_message_at?: string;
  created_at: string;
  active: boolean;
  stale?: boolean;
  // Liveness + attention signals from /sessions/active (handlers/vibeflow_sessions.go).
  last_heartbeat?: string;
  pending_prompt_count?: number;
  pending_agent_prompt_count?: number;
}

/**
 * Compliance tag — appears on a work item header next to severity (PCIDSS,
 * SOC2, etc.). Mirrors `database.VibeflowComplianceTag` in axiomcloud.
 */
export interface VibeFlowComplianceTag {
  framework: string;
  section_reference?: string;
  description?: string;
}

/**
 * Wire shape mirrors `database.VibeflowFeature` in axiomcloud — snake_case
 * fields are intentional. Earlier camelCase versions of these types were a
 * bug: backend handlers serialize the struct directly with `json.NewEncoder`
 * which respects the `json:"snake_case"` tags, so consumers reading
 * `feature.featureId` always saw `undefined` at runtime.
 */
export interface VibeFlowFeature {
  id: number;
  name: string;
  status: string;
  priority: string;
  project_id: number;
  description?: string;
}

/**
 * Structured progress snapshot embedded on todo/issue rows. Wire shape:
 *   axiomcloud/database/vibeflow_models.go ProgressSnapshot (line 759).
 *
 * Pointer-typed fields on the backend mean unsupplied values arrive as
 * undefined here; only `last_progress_at` is always present when the
 * snapshot itself is emitted. Written by `publish_todo_log` /
 * `publish_issue_log` when the agent passes any of: progress_pct,
 * milestone_name, milestone_index, milestone_total, eta_seconds,
 * current_action — or sets message_type='progress'.
 */
export interface VibeFlowProgressSnapshot {
  progress_pct?: number;
  milestone_name?: string;
  milestone_index?: number;
  milestone_total?: number;
  eta_seconds?: number;
  current_action?: string;
  last_progress_at: string;
}

export interface VibeFlowTodo {
  id: number;
  title: string;
  status: string;
  priority: string;
  description?: string;
  feature_id?: number;
  feature_name?: string;
  user_email?: string;
  created_at?: string;
  updated_at?: string;
  target_branch?: string;
  claimed_by?: string;
  qa_verified?: boolean;
  security_reviewed?: boolean;
  compliance_tags?: VibeFlowComplianceTag[];
  progress?: VibeFlowProgressSnapshot;
}

export interface VibeFlowIssue {
  id: number;
  title: string;
  status: string;
  priority: string;
  description?: string;
  project_id: number;
  feature_id?: number;
  feature_name?: string;
  user_email?: string;
  created_at?: string;
  updated_at?: string;
  target_branch?: string;
  claimed_by?: string;
  qa_verified?: boolean;
  security_reviewed?: boolean;
  compliance_tags?: VibeFlowComplianceTag[];
  progress?: VibeFlowProgressSnapshot;
}

export interface VibeFlowDocument {
  id: number;
  title: string;
  type: 'prd' | 'architecture' | 'style_guide' | 'design_system' | 'general';
  projectId: number;
}

/**
 * VibeFlow context (a.k.a. "Memory" in the axiomcloud UI). Flat list of
 * markdown notes attached to a project (or feature). The `parent_context_id`
 * field links rotation archives back to their live root — the tree filters
 * those out so only top-level (live) contexts are surfaced.
 *
 * Wire shape mirrors `axiomcloud/database/vibeflow_models.go:370`
 * (VibeflowContext) and the REST list endpoint
 * `GET /rest/v1/vibeflow/contexts?project_id=X`.
 */
export interface VibeFlowContext {
  id: number;
  title: string;
  content?: string;
  project_id?: number;
  feature_id?: number;
  parent_context_id?: number | null;
  storage_key?: string;
  organization_id: string;
  user_id: number;
  created_at: string;
  updated_at: string;
}

/**
 * Confluence reference — a read-only pointer to an external Atlassian page,
 * scoped to a project (and optionally a feature). Wire shape mirrors
 * `axiomcloud/database/vibeflow_models.go:1005` (ConfluenceReference).
 *
 * Listed via `GET /rest/v1/vibeflow/projects/{id}/references` which wraps
 * the array as `{ references: [...] }`. Content is fetched on-demand from
 * `/rest/v1/vibeflow/projects/{id}/references/{ref_id}/content` because
 * the page body is fetched from Confluence and cached on the server.
 */
export interface VibeFlowReference {
  id: number;
  project_id: number;
  feature_id?: number;
  confluence_space_key: string;
  confluence_space_name: string;
  confluence_page_id: string;
  confluence_page_title: string;
  confluence_page_url: string;
  reference_type: 'context' | 'document';
  label?: string;
  last_fetched_at?: string;
  last_page_version?: number;
  fetch_error?: string;
  created_at: string;
  updated_at: string;
}

export interface VibeFlowComment {
  id: number;
  entity_type: 'document' | 'context';
  entity_id: number;
  project_id: number;
  section_heading: string;
  content: string;
  user_id: number;
  user_email?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateCommentInput {
  entityType: 'document' | 'context';
  entityId: number;
  projectId: number;
  sectionHeading: string;
  content: string;
}

/**
 * Phase breakdown returned by get_work_summary, e.g. how much time was spent
 * in `planning` vs `implementing` across all sessions in scope.
 */
export interface VibeFlowWorkPhaseSummary {
  phase: string;
  session_count: number;
  total_seconds: number;
}

/**
 * Aggregate work metrics across todos/issues/features/projects. Wire shape
 * defined inline at axiomcloud/mcp/vibeflow_tools.go (vibeflowGetWorkSummaryHandler).
 *
 * `total_seconds` is per-session-duration sum, capped at 900s per session
 * server-side. Use this for relative comparisons, not wall-clock totals.
 */
export interface VibeFlowWorkSummary {
  total_sessions: number;
  total_seconds: number;
  total_commits: number;
  lines_added: number;
  lines_deleted: number;
  phases: VibeFlowWorkPhaseSummary[];
}

/**
 * Compliance finding row. Wire shape:
 *   axiomcloud/database/vibeflow_models.go:513-538.
 *
 * snake_case mirrors the wire format. `effective_status` is a server-derived
 * field that accounts for SLA grace windows and may differ from `status`.
 */
export interface VibeFlowComplianceFinding {
  id: number;
  created_at: string;
  updated_at: string;
  project_id: number;
  feature_id?: number;
  /**
   * The work item carrying this finding — where it shows up as a tag
   * in the studio UI. Renders as "Source Item" in axiomcloud's
   * compliance table (per the studio mirror).
   */
  work_item_type: string;
  work_item_id: number;
  /**
   * Optional originating context — the implementation todo / issue
   * that introduced the bug, when this finding was filed as a follow-up.
   * Renders as "Addressed By" in axiomcloud's compliance table for the
   * "fixed in #N" cross-reference chain (e.g. #1745 → fixed by #1947).
   */
  source_item_type?: string;
  source_item_id?: number;
  finding_type: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'informational';
  status: 'open' | 'in_progress' | 'resolved' | 'accepted_risk';
  effective_status?: string;
  description?: string;
  resolved_at?: string;
  resolved_by?: string;
  resolution_commit?: string;
  remediation_notes?: string;
  backward_compatible?: boolean;
  compliance_tags?: VibeFlowComplianceTag[];
}

/**
 * Asset metadata attached to a VibeFlowAttachment when
 * `attachment_type === 'asset'`. Wire shape:
 * axiomcloud/database/vibeflow_models.go:356-368.
 */
export interface VibeFlowAsset {
  id: number;
  created_at: string;
  filename: string;
  original_name: string;
  content_type: string;
  size: number;
  uploaded_by: number;
}

/**
 * Attachment row. Wire shape:
 * axiomcloud/database/vibeflow_models.go:438-453. The embedded `asset`
 * is populated server-side for asset attachments — non-asset rows
 * (e.g. linked documents) leave it undefined.
 */
export interface VibeFlowAttachment {
  id: number;
  created_at: string;
  updated_at: string;
  attachment_type: 'asset' | 'document';
  attachment_id: number;
  entity_type: 'todo' | 'issue' | 'feature' | 'project';
  entity_id: number;
  category?: string;
  asset?: VibeFlowAsset;
}

/**
 * Security-review verification marker for a work item. Created when a
 * security_lead persona records a review; absent until then. Wire shape:
 * axiomcloud/handlers/vibeflow_security_review.go:43-72.
 */
export interface VibeFlowSecurityReview {
  id: number;
  created_at: string;
  user_id: number;
  review_notes?: string;
  source_type: 'todo' | 'issue';
  source_id: number;
}

/**
 * QA verification marker for a work item. Wire shape mirrors
 * `database.VibeflowQATodoVerification` (and the issue mirror) at
 * vibeflow_models.go:455-471. Both shapes share id/created_at/user_id;
 * the foreign key field name differs (`todo_id` vs `issue_id`) so we
 * keep both optional and let the renderer pick whichever is set.
 *
 * Endpoint: GET /rest/v1/vibeflow/{type}s/{id}/qa/review — returns the
 * literal `null` body when no verification exists (200 either way).
 */
export interface VibeFlowQAReview {
  id: number;
  created_at: string;
  updated_at?: string;
  user_id: number;
  todo_id?: number;
  issue_id?: number;
}

/**
 * One card in the kanban/swimlane view.
 *
 * Wire shape: axiomcloud/database/vibeflow_models.go:830-845. snake_case is
 * intentional — this mirrors the wire format. The org-scoped swimlane
 * endpoint returns items from ALL projects; clients filter by project_id.
 */
export interface VibeFlowSwimlaneItem {
  type: 'project' | 'feature' | 'todo' | 'issue';
  id: number;
  name: string;
  status: string;
  priority?: string;
  project_id?: number;
  project_name?: string;
  feature_id?: number;
  feature_name?: string;
  updated_at: string;
  completed_at?: string;
  current_persona?: string;
  security_reviewed?: boolean;
}

/**
 * Eight-column swimlane response. Wire shape:
 *   GET /rest/v1/vibeflow/dashboard/swimlane → VibeflowSwimlaneResult.
 * Defined at axiomcloud/database/vibeflow_models.go:847-857.
 */
export interface VibeFlowSwimlaneResult {
  in_review: VibeFlowSwimlaneItem[];
  needs_pm_input: VibeFlowSwimlaneItem[];
  needs_ux_input: VibeFlowSwimlaneItem[];
  planning: VibeFlowSwimlaneItem[];
  ready_to_implement: VibeFlowSwimlaneItem[];
  architecture_review_complete: VibeFlowSwimlaneItem[];
  implementing: VibeFlowSwimlaneItem[];
  done: VibeFlowSwimlaneItem[];
}

/**
 * Response shape from the `check_branch_review_status` MCP tool.
 *
 * Wire format defined by axiomcloud/mcp/vibeflow_tools.go:7415-7424. Both
 * `overall_security` and `overall_qa` are PASS|PENDING strings; `total_lines`
 * is a pre-formatted display string like "+342 -89".
 *
 * `total_items === 0` is a special "no work items on this branch" case that
 * the server returns with just `{ branch, total_items, message }` — counts
 * fields will be undefined.
 */
export type BranchReviewVerdict = 'PASS' | 'PENDING';

export interface BranchReviewItemStatus {
  type: 'todo' | 'issue';
  id: number;
  title: string;
  security: BranchReviewVerdict;
  security_notes?: string;
  qa: BranchReviewVerdict;
  open_findings: number;
}

export interface BranchReviewStatus {
  branch: string;
  total_items: number;
  message?: string;
  overall_security?: BranchReviewVerdict;
  overall_qa?: BranchReviewVerdict;
  security_passed?: number;
  qa_passed?: number;
  open_findings?: number;
  total_commits?: number;
  total_lines?: string;
  items?: BranchReviewItemStatus[];
}

/**
 * Wire shape for `GET /rest/v1/vibeflow/projects/{id}/prompts`.
 * Mirrors `database.VibeflowPrompt` in axiomcloud.
 *
 * The extension cares about prompts where `source === 'agent'` and
 * `status === 'pending'` — those are agents asking the human a question and
 * waiting on a reply. Other source/status combos belong to the inverse
 * direction (user → agent) and are surfaced inside the agent's
 * `wait_for_work` poll, not in the extension UI.
 */
export type VibeFlowPromptStatus = 'pending' | 'responded' | 'acknowledged' | 'expired';
export type VibeFlowPromptSource = 'agent' | 'user';

/**
 * Cursor-paginated response from
 * `GET /rest/v1/vibeflow/projects/{id}/prompts?session_id=...`.
 *
 * The same endpoint returns a bare array when called WITHOUT `session_id`
 * (project-wide legacy shape — see `listPendingPrompts`). When `session_id`
 * is provided, the server wraps the page in this envelope. Prompts are
 * returned oldest-first within the page; cursor params (`limit`,
 * `before_id`, `after_id`) drive the window.
 *
 * Endpoint contract reference: `axiomcloud/axiomcloud/frontend/src/services/vibeflow.js:786-806`.
 */
export interface ListSessionPromptsResponse {
  prompts: VibeFlowPrompt[];
  page: {
    has_more: boolean;
    oldest_id: number | null;
    newest_id: number | null;
    next_before_id: number | null;
  };
}

export interface VibeFlowPrompt {
  id: number;
  created_at: string;
  updated_at: string;
  organization_id: string;
  project_id: number;
  session_id: string;
  prompt_id: string;
  prompt_text: string;
  response_text: string;
  status: VibeFlowPromptStatus;
  responded_at: string | null;
  source: VibeFlowPromptSource;
  work_item_type?: string;
  work_item_id?: number;
  message_type?: string;
}

// ============================================================
// Brainstorm (feature 473) — mirror axiomcloud database/vibeflow_models.go
// brainstorm structs + handlers/vibeflow_brainstorm_rest.go response shapes.
// All over REST (Bearer); see design doc #361.
// ============================================================

export interface BrainstormTopic {
  order: number;
  name: string;
  status: string;
}

export interface BrainstormSessionConfig {
  max_rounds: number;
  timeout_per_persona: number;
  scope_guard_enabled: boolean;
  token_budget: number;
  tokens_used: number;
  paused: boolean;
  participating_personas?: string[];
  topics?: BrainstormTopic[];
  current_topic_index: number;
}

export interface BrainstormOpenItem {
  id: number;
  type: string;
  text: string;
  raised_by: string;
  round: number;
  status: string;
  section?: string;
}

/** One row from GET /projects/{id}/prs (ListProjectPRs, vibeflow_features.go). */
export interface VibeFlowPullRequest {
  provider: string;
  vibeflow_type: string;
  vibeflow_id: number;
  feature_id?: number;
  issue_id?: number;
  pr_number: number | null;
  state: string;
  title?: string;
  repo: string;
  pr_url?: string;
  head_ref?: string;
  base_ref?: string;
  author?: string;
  author_avatar?: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  commits?: number;
}

/** A brainstorm session. `status`: setup | seeding | active | converging | done | cancelled. */
export interface VibeFlowBrainstormSession {
  id: number;
  organization_id: string;
  project_id: number;
  document_id: number | null;
  final_document_id: number | null;
  lead_persona_key: string;
  feature_id: number | null;
  status: string;
  initiator_session_id: string;
  config: BrainstormSessionConfig;
  round_number: number;
  open_items: BrainstormOpenItem[];
  created_at: string;
  updated_at: string;
}

export interface VibeFlowBrainstormRound {
  id: number;
  organization_id: string;
  brainstorm_id: number;
  round_number: number;
  document_snapshot_before?: string;
  document_snapshot_after?: string;
  scope_warnings: string;
  convergence_score: number;
  created_at: string;
}

export interface VibeFlowBrainstormResponse {
  id: number;
  organization_id: string;
  brainstorm_id: number;
  round_number: number;
  persona_key: string;
  session_id: string;
  response_type: string;
  content: string;
  target_section: string | null;
  resolution_status: string;
  resolved_in_round: number | null;
  target_persona_key: string | null;
  parent_response_id: number | null;
  created_at: string;
}

/** `progress` block from GET /brainstorms/{id} (vibeflow_brainstorm_rest.go:299-325). */
export interface BrainstormProgress {
  responded: Record<string, string>;
  pending: string[];
  next_up: string;
  elapsed_seconds: number;
  response_count: number;
  participant_count: number;
  topics?: BrainstormTopic[];
  current_topic_index?: number;
  current_topic?: string;
  topics_total?: number;
  topics_done?: number;
}

/** GET /brainstorms/{id} → { session, rounds?, progress? }. */
export interface BrainstormDetailResponse {
  session: VibeFlowBrainstormSession;
  rounds?: VibeFlowBrainstormRound[];
  progress?: BrainstormProgress;
}

/** GET /brainstorms/{id}/rounds/{n} → { round, responses }. */
export interface BrainstormRoundResponse {
  round: VibeFlowBrainstormRound;
  responses: VibeFlowBrainstormResponse[];
}

/** POST /brainstorms body (vibeflow_brainstorm_rest.go:23-37). */
export interface StartBrainstormBody {
  project_id: number;
  topic: string;
  lead_persona_key: string;
  session_id: string;
  participating_personas: string[];
  existing_document_id?: number | null;
  feature_id?: number | null;
  max_rounds: number;
  scope_guard_enabled?: boolean;
  token_budget: number;
  topics?: { name: string }[];
}

// --- Cloud Runners Integration (feature #603) ---
//
// Wire shape mirrors the "Cloud Runners External Integration — API
// Specification" (axiomcloud doc #433). NOTE: unlike the older vibeflow
// types above (which are snake_case because those handlers serialize with
// `json:"snake_case"` tags), the Cloud Runners handlers
// (handlers/cloud_runners.go, cloud_runner_git_providers.go) use camelCase
// field names — the spec documents `podName`, `studioRunnerId`, `gitUrl`,
// `agentType`, etc. with concrete camelCase JSON examples. These interfaces
// follow that contract verbatim so bodies can be JSON.stringify'd as-is.

/**
 * Org-resolved feature flags — `GET /rest/v1/feature-flags`. Not itself
 * feature-gated; any authenticated user reads their own org's flags. Each
 * value is the global default merged with any per-org override.
 */
export interface FeatureFlags {
  flags: Record<string, boolean>;
}

/**
 * A git provider record (account-level, per-user). Returned by
 * `GET /rest/v1/vibeflow/git-providers`. Secrets (accessToken / sshPrivateKey)
 * are NEVER echoed back — only these four fields are exposed.
 */
export interface GitProviderView {
  id: number;
  name: string;
  gitUrl: string;
  authMode: string; // 'pat' | 'ssh' | 'oauth'
}

/**
 * Body for `POST /rest/v1/vibeflow/git-providers`. The extension supports
 * PAT and SSH only (OAuth is out of scope for the Settings UI). Provide
 * userName+accessToken for `pat`, or sshPrivateKey for `ssh`.
 */
export interface CreateGitProviderRequest {
  name: string;
  gitUrl: string;
  authType: 'pat' | 'ssh';
  userName?: string;
  accessToken?: string;
  sshPrivateKey?: string;
}

/**
 * A cloud runner scoped to a project (`cloudRunnerView`). `id` is the LOCAL
 * runner id used in all AxiomCloud paths; `studioRunnerId` is upstream and
 * informational only — never send it back to the server.
 */
export interface CloudRunnerView {
  id: number;
  name: string;
  status: string;
  podName: string;
  podStatus: string;
  lastStatusAt: string;
  studioRunnerId: number;
  userId: number;
  projectId: number;
  createdAt: string;
  // The detail endpoint (`GET .../{id}`) additionally returns the agent
  // identity used by the Manage wizard (routing + manifest). Optional — list
  // rows and PENDING detail responses (axiomcloud's bare local view) don't
  // populate them; provisioned detail responses arrive inside cortex's
  // {code,status,result} envelope, which `getCloudRunner` unwraps (#3630).
  agentType?: string;
  authMode?: string;
  loginMethod?: string;
}

/**
 * A cloud runner from the global cross-project list
 * (`GET /rest/v1/vibeflow/cloud-runners`) — additionally carries projectName.
 */
export interface GlobalCloudRunnerView extends CloudRunnerView {
  projectName: string;
}

/**
 * A repository to clone onto a runner at create time. `branch` matters: the
 * runner chart clones with `--branch <branch|main>` and SWALLOWS clone
 * failures, so omitting it on a repo whose default branch is not `main`
 * fails silently server-side (#2883; web parity: `{url, branch}`).
 */
export interface CloudRunnerRepo {
  url: string;
  branch?: string;
}

/**
 * Body for `POST /rest/v1/vibeflow/projects/{projectId}/cloud-runners`.
 * `gitRepos` requires a `gitProviderId` (server rejects otherwise — no clone
 * without push credentials). Cluster/namespace are server-chosen, never sent.
 */
export interface CreateRunnerRequest {
  name: string;
  agentType: 'claude' | 'codex' | 'cursor';
  authMode: 'api_key' | 'oauth';
  cloudAgentType?: string;
  loginMethod?: string;
  apiKey?: string;
  podName?: string;
  gitProviderId?: number;
  gitRepos?: CloudRunnerRepo[];
}

/**
 * Live runner status relayed from Studio — `GET .../cloud-runners/{id}/status`
 * (feature #603 management, spec #435/#436). Used to gate the Manage wizard
 * (authenticated/configured/podStatus) and to reconcile Start/Stop.
 */
export interface RunnerStatus {
  status?: string;
  podStatus?: string;
  authenticated?: boolean;
  configured?: boolean;
}

/**
 * Device-code OAuth start payload (`GET .../{id}/oauth/start`). The server
 * spells the URL/code fields several ways depending on the agent — callers
 * read the first present value.
 */
export interface RunnerOAuthStart {
  url?: string;
  verificationUrl?: string;
  verification_url?: string;
  code?: string;
  userCode?: string;
  user_code?: string;
}

/** A repo cloned onto the runner pod (`GET .../{id}/repos`). */
export interface RunnerRepo {
  name?: string;
  path?: string;
  isGitRepo?: boolean;
  branch?: string;
}

/** Runner launch health (`GET .../{id}/health`) — `phase` ∈ running|error|…. */
export interface RunnerHealth {
  phase?: string;
  errors?: string[];
}
