/**
 * Pure helpers for the Cloud Runners Integration (feature #603).
 *
 * This module is deliberately free of `vscode` and `fetch` so it can be
 * unit-tested directly (see cloudRunners.test.ts). The `VibeFlowClient`
 * REST wrappers that hit AxiomCloud live in client.ts and stay thin;
 * the decision logic worth proving lives here.
 *
 * Wire contract: the "Cloud Runners External Integration — API Specification"
 * (axiomcloud doc #433) + Workflow (#434).
 */
import type { FeatureFlags, CreateRunnerRequest, CloudRunnerRepo, RunnerRepo } from './types.js';

/**
 * Org feature-flag key that gates every Cloud Runners + git-provider route.
 * `GET /rest/v1/feature-flags` returns the org-resolved value (global default
 * merged with any per-org override), so a single read answers "enabled for
 * this org or globally".
 */
export const FEATURE_CLOUD_RUNNERS = 'feature_cloud_runners';

/**
 * Read a resolved feature flag defensively. A missing key or a non-`true`
 * value means the capability is OFF — never throw on a partial/empty map.
 */
export function isFeatureEnabled(flags: FeatureFlags | undefined | null, name: string): boolean {
  return flags?.flags?.[name] === true;
}

/**
 * Build-time master switch for the entire Cloud Runners surface (#2833).
 * While `false`, the feature is hidden regardless of the org's runtime flag:
 * no Git Configuration tab in VibeFlow Settings, no Cloud Runners / Git
 * Providers rows in the Browse nav, no "Cloud Runner" option on the Work
 * Items "+" picker, and the open-page commands decline. Enabled in #2868
 * after the E2E blockers landed (#3588 terminal protocol, #2881 loginMethod,
 * #2882 credential re-injection); org rollout stays gated by the runtime
 * `feature_cloud_runners` flag below.
 */
export const CLOUD_RUNNERS_BUILD_ENABLED = true;

/**
 * Convenience: is the Cloud Runners capability available? Requires BOTH the
 * build-time switch and the org's runtime feature flag. `buildFlag` is
 * parameterized only so tests can exercise the runtime-flag semantics.
 */
export function cloudRunnersEnabled(
  flags: FeatureFlags | undefined | null,
  buildFlag: boolean = CLOUD_RUNNERS_BUILD_ENABLED,
): boolean {
  return buildFlag && isFeatureEnabled(flags, FEATURE_CLOUD_RUNNERS);
}

/**
 * Extract a list from an AxiomCloud list response, tolerant of response-shape
 * drift (#3393 — existing git providers weren't rendering because the live
 * shape differed from the spec's `{providers: [...]}`). In order:
 *   1. a bare top-level array (some endpoints don't wrap),
 *   2. the documented wrapper `key` (e.g. `providers`, `runners`),
 *   3. the sole array-valued property, if there's exactly one (covers a
 *      wrapper-key mismatch such as `git_providers` vs `providers`).
 * Anything else (missing/null/non-array, or ambiguous multiple arrays) means
 * "zero rows", not an error.
 */
export function unwrapList<T>(envelope: unknown, key: string): T[] {
  if (Array.isArray(envelope)) {
    return envelope as T[];
  }
  if (envelope && typeof envelope === 'object') {
    const obj = envelope as Record<string, unknown>;
    if (Array.isArray(obj[key])) {
      return obj[key] as T[];
    }
    const arrays = Object.values(obj).filter((v): v is unknown[] => Array.isArray(v));
    if (arrays.length === 1) {
      return arrays[0] as T[];
    }
  }
  return [];
}

/**
 * Runner-name constraints (#2827). The server derives the pod's DNS name from
 * the runner name (spec §7.3: podName auto-derived, valid DNS label ending
 * `-0`), so the name must be DNS-1035-safe with headroom for the pod ordinal
 * and the `-xxxx` de-dup salt (#3395): lowercase alphanumerics + hyphens,
 * letter first, alphanumeric last, at most RUNNER_NAME_MAX chars. The rules
 * message is user-facing and deliberately infrastructure-free.
 */
export const RUNNER_NAME_MAX = 40;
export const RUNNER_NAME_RULES =
  `Use 1–${RUNNER_NAME_MAX} characters: lowercase letters, numbers, and hyphens. ` +
  'Start with a letter and end with a letter or number.';
const RUNNER_NAME_RE = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;

/** Validate a runner name; returns the user-facing rules message or null. */
export function validateRunnerName(name: string): string | null {
  const n = name.trim();
  if (!n) { return `Name is required. ${RUNNER_NAME_RULES}`; }
  if (n.length > RUNNER_NAME_MAX || !RUNNER_NAME_RE.test(n)) { return RUNNER_NAME_RULES; }
  return null;
}

/**
 * Human-readable review lines for a create-runner body (#2894) — the
 * before-deploy summary the web wizard shows on its Review step. Secret-free:
 * apiKey is reported as present/absent only, never its value.
 */
export function createRunnerReviewLines(body: CreateRunnerRequest): string[] {
  const lines = [
    `Name: ${body.name}`,
    `Agent: ${body.agentType}`,
    `Auth: ${body.authMode === 'api_key' ? 'API key' : 'OAuth'}`,
  ];
  if (body.authMode === 'api_key') { lines.push(`API key: ${body.apiKey ? 'provided' : 'missing'}`); }
  if (body.loginMethod) { lines.push(`Login method: ${body.loginMethod}`); }
  if (body.gitProviderId) { lines.push(`Git provider: #${body.gitProviderId}`); }
  if (body.gitRepos && body.gitRepos.length > 0) {
    const branch = body.gitRepos[0].branch;
    lines.push(`Repos: ${body.gitRepos.map(r => r.url).join(', ')}${branch ? ` (branch ${branch})` : ''}`);
  }
  return lines;
}

/**
 * Client-side guard mirroring the server rule (`createRunnerRequest`
 * validation in handlers/cloud_runners.go): a runner may not request
 * `gitRepos` without a `gitProviderId` — there is no clone without push
 * credentials. Returns a human-readable error message when the body is
 * invalid, or `null` when it is acceptable to send.
 */
export function validateCreateRunner(body: CreateRunnerRequest): string | null {
  if (!body.name || !body.name.trim()) {
    return 'name is required';
  }
  const nameErr = validateRunnerName(body.name);
  if (nameErr) {
    return nameErr;
  }
  if (body.gitRepos && body.gitRepos.length > 0 && !body.gitProviderId) {
    return 'repositories require a git provider';
  }
  return null;
}

/** Is `repoUrl` an https(-scheme) git URL? (web isHttpsGitUrl parity) */
export function isHttpsGitUrl(repoUrl: string): boolean {
  return repoUrl.trim().toLowerCase().startsWith('https://');
}

/** Is `repoUrl` SSH-style (`ssh://` or `git@host:path`)? (web isSshGitUrl parity) */
export function isSshGitUrl(repoUrl: string): boolean {
  const value = repoUrl.trim();
  if (value.toLowerCase().startsWith('ssh://')) { return true; }
  if (value.includes('://')) { return false; }
  const at = value.indexOf('@');
  const colon = value.indexOf(':');
  return at > 0 && colon > at + 1 && colon < value.length - 1;
}

/**
 * Validate a repo URL against the picked provider's auth mode (#2888, web
 * gitRepoUrlAuthError parity): SSH-key providers need an SSH-style URL;
 * PAT/OAuth providers need https. The list endpoint delivers cortex-style
 * authMode names (SSH/ACCESS_TOKEN/OAUTH) — lowercase spellings tolerated.
 * Returns a user-facing message, or '' when acceptable / no provider.
 */
export function gitRepoUrlAuthError(repoUrl: string, authMode: string | undefined): string {
  const value = repoUrl.trim();
  if (!value || !authMode) { return ''; }
  const mode = authMode.toUpperCase();
  if (mode === 'SSH' && !isSshGitUrl(value)) {
    return 'The repository URL must be an SSH URL (for example git@github.com:org/repo.git) because the selected git provider authenticates with an SSH key.';
  }
  if ((mode === 'ACCESS_TOKEN' || mode === 'PAT' || mode === 'OAUTH') && !isHttpsGitUrl(value)) {
    return 'The repository URL must be an HTTPS URL (for example https://github.com/org/repo.git) because the selected git provider authenticates with a token (PAT/OAuth).';
  }
  return '';
}

/**
 * Per-agent OAuth login methods (spec #433 §7.3 `loginMethod`), mirroring the
 * web CreateCloudRunnerModal LOGIN_METHODS verbatim — the values are cortex's
 * auth-strategy set. Sent in the create body only when `authMode === 'oauth'`;
 * cortex ignores the cursor value (browser login via `cursor-agent login`).
 */
export const LOGIN_METHODS: Record<CreateRunnerRequest['agentType'], ReadonlyArray<{ value: string; label: string }>> = {
  claude: [
    { value: 'claude', label: 'Claude subscription (Pro, Max, Team, Enterprise)' },
    { value: 'console', label: 'Anthropic Console (API usage billing)' },
    { value: 'third_party', label: '3rd-party platform (Bedrock, Vertex, Foundry)' },
  ],
  codex: [{ value: 'device_auth', label: 'Device Authentication (ChatGPT login)' }],
  cursor: [{ value: 'cursor', label: 'Cursor account (browser login)' }],
};

/**
 * Parse a free-text list of repo URLs (comma- or newline-separated) into the
 * `gitRepos` shape. Blank entries are dropped; an empty/whitespace input
 * yields an empty list (no repos requested). When `branch` is given it is
 * applied to every entry (#2883) — the chart clones `--branch <branch|main>`
 * and swallows failures, so non-main default branches need it explicit.
 */
export function parseRepoUrls(input: string, branch?: string): CloudRunnerRepo[] {
  return input
    .split(/[\n,]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(url => (branch ? { url, branch } : { url }));
}

/**
 * Summarize a runner's cloned repos for the list table (#2825): first git
 * repo's name (falling back to the last path segment) + its branch, with a
 * `+N` suffix when more repos are cloned. Missing/empty/non-git-only lists
 * render as em dashes so unprovisioned pods still get a tidy row.
 */
export function summarizeRepos(repos: RunnerRepo[] | undefined): { repo: string; branch: string } {
  const git = (repos ?? []).filter(r => r.isGitRepo !== false);
  if (git.length === 0) { return { repo: '—', branch: '—' }; }
  const first = git[0];
  const name = first.name?.trim() || first.path?.split('/').filter(Boolean).pop() || '—';
  const extra = git.length > 1 ? ` +${git.length - 1}` : '';
  return { repo: `${name}${extra}`, branch: first.branch?.trim() || '—' };
}

/** Terminal/transient classification of a runner status while polling create. */
export type RunnerPollState = 'active' | 'failed' | 'pending';

/**
 * Classify a runner's lifecycle status for the create-and-wait poll loop.
 * Success = `active` (axiomcloud local rows) or `running` (cortex live view —
 * the detail GET relays cortex's vocabulary for provisioned runners, which
 * never emits `active`; #3630). Terminal failure = `failed` (local) or
 * `error` (cortex). Everything else (pending/starting/…) = keep polling.
 */
export function runnerPollState(status: string): RunnerPollState {
  if (status === 'active' || status === 'running') { return 'active'; }
  if (status === 'failed' || status === 'error') { return 'failed'; }
  return 'pending';
}

/**
 * Map a create-cloud-runner failure to a user-facing message (#3388). 403 →
 * insufficient permissions; 502/503 → transient Studio outage. 409 (duplicate
 * name) is handled by the caller's name-retry loop, not here. Any other status
 * falls back to the server's error text (already ≤300 chars, response-body
 * only — never the request body/secret).
 */
export function createRunnerErrorMessage(status: number | undefined, serverText: string): string {
  switch (status) {
    case 403:
      return 'You do not have permission to create this cloud runner (owner or org admin only).';
    case 502:
    case 503:
      return 'Cloud Runner service is temporarily unavailable — please try again shortly.';
    default:
      return `could not create cloud runner — ${serverText}`;
  }
}

/**
 * Unwrap the Studio status envelope (doc #437 §2): `GET .../{id}/status`
 * relays `{code, status, result, errors}` where the live runner status lives
 * in `result`. Tolerant to both shapes — a body without a `result` object is
 * returned as-is, so nothing breaks if the server pre-unwraps.
 */
export function unwrapStatusEnvelope<T extends object>(data: unknown): T {
  if (data && typeof data === 'object' && 'result' in data) {
    const result = (data as { result?: unknown }).result;
    if (result && typeof result === 'object') { return result as T; }
    return {} as T; // envelope with a missing/invalid result — nothing usable
  }
  return (data ?? {}) as T;
}

/**
 * A runner is "running" (the page shows a Stop action) when its lifecycle
 * status is `active` or `running` (#603 management, spec #436 §2), or when
 * the agent is mid-login (`authenticating`, doc #437 §1) — the pod is up,
 * so Stop applies and Start does not.
 */
export function isRunnerRunning(status: string): boolean {
  return status === 'active' || status === 'running' || status === 'authenticating';
}

/**
 * A runner is transitioning while `starting`/`stopping` — the page disables
 * its row actions and shows a spinner until the reconciler settles (#436 §2).
 */
export function isRunnerTransitioning(status: string): boolean {
  return status === 'starting' || status === 'stopping';
}

// Transient pod/DNS signals the page softens so users retry instead of seeing
// raw pod errors (#436 §6 / §0).
const TRANSIENT_RUNNER_RE = /no such host|connection refused|dial tcp|pod not found|i\/o timeout|context deadline exceeded|no endpoints available/i;

/**
 * Map a start/stop/delete failure to a user-facing message (#2816). 403 →
 * permissions, 409 → invalid-state, 502/503 → transient outage, and transient
 * pod/DNS errors → "still starting"; otherwise the server error text.
 */
export function runnerActionErrorMessage(status: number | undefined, serverText: string): string {
  if (status === 403) {
    return "You don't have permission to manage this runner (owner or org admin only).";
  }
  if (status === 409) {
    return "That action isn't valid for the runner's current state — refresh and try again.";
  }
  if (status === 502 || status === 503) {
    return 'Cloud Runner service is temporarily unavailable — please try again shortly.';
  }
  if (TRANSIENT_RUNNER_RE.test(serverText)) {
    return 'Runner is still starting. Try again in a moment.';
  }
  return serverText;
}

// --- Manage-wizard gating helpers (#603 spec #436 §5) ---

/**
 * A runner is manageable (the Manage action is enabled) unless it is
 * `stopped`/`stopping`/`starting` — a stopped runner has no pod, so the
 * auth/configure/launch steps would DNS-fail or hang. `pending`/`failed`
 * stay manageable (their pods may be coming up).
 */
export function canManageRunner(status: string): boolean {
  return status !== 'stopped' && status !== 'stopping' && status !== 'starting';
}

const POD_READY_RE = /healthy|running|ready|available|succeeded/i;

/** The pod is up enough to begin the OAuth device-code handshake (#436 §4.1). */
export function isPodReady(podStatus: string | undefined): boolean {
  return !!podStatus && POD_READY_RE.test(podStatus);
}

/**
 * Whether OAuth completes server-side (no paste-back code): `codex`/`cursor`
 * finish via the supervisor's auth poll; `claude` is interactive (#436 §4.1).
 */
export function authCompletesAutomatically(agentType: string | undefined): boolean {
  return agentType === 'codex' || agentType === 'cursor';
}

/**
 * Pod-health values that mean "something is wrong" (web RUNNER_ERROR_HEALTH):
 * helm Health.Status degraded/missing/unknown.
 */
export const RUNNER_ERROR_HEALTH = ['degraded', 'missing', 'unknown'] as const;

function isErrorTuple(status: string, health: string): boolean {
  return status === 'failed' || (RUNNER_ERROR_HEALTH as readonly string[]).includes(health);
}

/**
 * Bulk-action eligibility for a selection (#2893): a runner can be started
 * when it is not already running/transitioning, stopped when it IS running,
 * and deleted always. Returns the counts driving the toolbar's Start N/Stop N.
 */
export function bulkEligibility(statuses: readonly string[]): { startable: number; stoppable: number } {
  let startable = 0;
  let stoppable = 0;
  for (const s of statuses) {
    if (isRunnerTransitioning(s)) { continue; }
    if (isRunnerRunning(s)) { stoppable += 1; } else { startable += 1; }
  }
  return { startable, stoppable };
}

/**
 * Past-tense verb for the bulk summary toast (#2893, web BULK_DONE_VERBS
 * parity). An `${verb}d` template mis-renders 'start' as 'startd' — the map is
 * explicit so every verb reads correctly.
 */
export const BULK_DONE_VERBS: Record<string, string> = {
  start: 'started',
  stop: 'stopped',
  delete: 'deleted',
};

/** The past tense for a bulk verb, falling back to the verb itself if unknown. */
export function bulkPastTense(verb: string): string {
  return BULK_DONE_VERBS[verb] ?? verb;
}

/**
 * Status-cell primary action from the (status, podStatus) tuple (#2891, web
 * runnerPrimaryAction parity): one-click 'Authenticate' for a healthy pod
 * awaiting login, 'Manage Agents' for running/error rows, disabled 'Stopped'
 * / 'Initializing' otherwise. Enabled actions open the Manage wizard — its
 * routeInitialStep lands on the right step.
 */
export function runnerPrimaryAction(status: string | undefined, podStatus: string | undefined): { label: string; disabled: boolean } {
  const s = (status || '').toLowerCase();
  const h = (podStatus || '').toLowerCase();
  if (s === 'stopped' || s === 'stopping') { return { label: 'Stopped', disabled: true }; }
  if (isErrorTuple(s, h)) { return { label: 'Manage Agents', disabled: false }; }
  if (h === 'healthy') {
    if (s === 'authenticating') { return { label: 'Authenticate', disabled: false }; }
    if (s === 'running' || s === 'active') { return { label: 'Manage Agents', disabled: false }; }
  }
  return { label: 'Initializing', disabled: true };
}

/**
 * Health-cell classification from the (status, podStatus) tuple (#2890, web
 * runnerHealthIcon parity): 'none' for stopped rows (a spinner would misread
 * as activity), 'error' with a tooltip carrying the stored strings, 'healthy',
 * or 'busy' while provisioning/progressing.
 */
export function runnerHealthIcon(status: string | undefined, podStatus: string | undefined): { kind: 'none' | 'error' | 'healthy' | 'busy'; title: string } {
  const s = (status || '').toLowerCase();
  const h = (podStatus || '').toLowerCase();
  if (s === 'stopped' || s === 'stopping') { return { kind: 'none', title: '' }; }
  if (isErrorTuple(s, h)) {
    return { kind: 'error', title: `Status: ${status || '—'} · Health: ${podStatus || '—'}` };
  }
  if (h === 'healthy') { return { kind: 'healthy', title: 'Healthy' }; }
  return { kind: 'busy', title: `Provisioning — Status: ${status || 'pending'} · Health: ${podStatus || 'starting'}` };
}

/**
 * The "Route LLM through Axiom Cloud Gateway" option applies only to agents
 * whose model calls the platform proxies — Cursor routes LLM requests through
 * the user's own Cursor account, so the option is not applicable (#2888, web
 * llmGatewaySupportedForAgent parity).
 */
export function llmGatewaySupportedForAgent(agentType: string | undefined): boolean {
  return agentType !== 'cursor';
}

/**
 * Launch is enabled only with a working directory, a project, and a valid
 * persona set: exactly ONE workspace persona (#2887) plus any advisors.
 */
export function canLaunch(workingDir: string, project: string, personas: readonly string[]): boolean {
  const workspaceCount = personas.filter(p => (WORKSPACE_PERSONAS as readonly string[]).includes(p)).length;
  return workingDir.trim().length > 0 && project.trim().length > 0 && workspaceCount === 1;
}

/**
 * Suggest a de-duplicated runner name for the 409 retry prompt (#3395). Appends
 * the caller-supplied `salt` (a short random token) to the ORIGINAL base name —
 * NOT a monotonic `-N`, which just walks through previously-deleted names that
 * the server still keeps reserved (#3394 tombstone). A random suffix is very
 * unlikely to collide, so the first suggestion is fresh. Pure/deterministic
 * given `salt`; the command supplies the entropy so this stays unit-testable.
 */
export function suggestRunnerName(name: string, salt: string): string {
  // Clip the base so the suggestion stays inside the name budget (#2827) and
  // strip any hyphen run left at the cut so the result stays a valid name.
  const maxBase = RUNNER_NAME_MAX - salt.length - 1;
  const base = name.trim().slice(0, Math.max(1, maxBase)).replace(/-+$/, '');
  return `${base}-${salt}`;
}

// Key names whose values are credentials and must never reach the trace log
// (#3400): provider keys, PATs, SSH private keys, bearer/authorization values.
const SECRET_KEY_RE = /token|secret|password|api[_-]?key|authorization|ssh[_-]?private[_-]?key/i;

/**
 * Deep-copy a JSON value with the VALUES of credential-named fields replaced
 * by '***' (#3400 trace logging). Field names, structure, and non-secret
 * values are preserved verbatim so full payloads can be traced safely.
 */
export function redactSecretsDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSecretsDeep);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? '***' : redactSecretsDeep(v);
    }
    return out;
  }
  return value;
}

/**
 * #3401 — endpoints whose bodies are free-text CONTENT rather than structured
 * fields: shell commands (`/exec`), terminal keystrokes (`/tmux/input`), and
 * oauth device codes (`/oauth/submit`). Key-name redaction cannot help here —
 * a secret typed INTO the content (e.g. `export API_KEY=…`, a password at a
 * prompt) is indistinguishable from the content itself. The trace must omit
 * these bodies entirely, request AND response (exec output can echo what was
 * typed), logging a byte-count line instead.
 */
export function isSensitiveBodyPath(path: string): boolean {
  const clean = path.split('?')[0];
  return /\/(oauth\/submit|exec|tmux\/input)$/.test(clean);
}

/**
 * Summarize a response's SHAPE for the debug trace (#3396) — top-level keys with
 * array lengths and value TYPES, never values. Reveals response-shape drift
 * (e.g. `{git_providers[3]}` vs `{providers[3]}`, or `array[3]`) without logging
 * any data, so it is safe even if a payload were to carry sensitive fields.
 */
export function summarizeResponseShape(data: unknown): string {
  if (Array.isArray(data)) {
    return `array[${data.length}]`;
  }
  if (data && typeof data === 'object') {
    const parts = Object.entries(data as Record<string, unknown>).map(([k, v]) =>
      Array.isArray(v) ? `${k}[${v.length}]` : `${k}:${typeof v}`,
    );
    return `{${parts.join(', ')}}`;
  }
  return typeof data;
}

/** The 9 vibeflow personas selectable when configuring a runner session. */
export const VIBEFLOW_PERSONAS = [
  'developer', 'principal_engineer', 'architect', 'ux_designer', 'qa_lead',
  'security_lead', 'product_manager', 'project_manager', 'customer',
] as const;

/**
 * Workspace (code-writing) personas — a session needs exactly ONE (two would
 * fight over the branch lock; zero writes no code). Mirrors the web's
 * WORKSPACE_PERSONA_VALUES and src/sessions/personas.ts CODE_AGENT_PERSONAS.
 */
export const WORKSPACE_PERSONAS = ['developer', 'principal_engineer', 'architect'] as const;

/** Advisory/review personas — any number may join a session. */
export const ADVISORY_PERSONAS: readonly string[] =
  VIBEFLOW_PERSONAS.filter(p => !(WORKSPACE_PERSONAS as readonly string[]).includes(p));

/**
 * Grouped persona-picker toggle (#2887, web togglePersonaSelection parity):
 * picking a workspace persona REPLACES any other workspace persona (radio
 * semantics, workspace-first ordering); advisory personas toggle normally.
 */
export function togglePersonaSelection(selected: readonly string[], value: string): string[] {
  const workspace = WORKSPACE_PERSONAS as readonly string[];
  if (workspace.includes(value)) {
    if (selected.includes(value)) { return [...selected]; }
    return [value, ...selected.filter(p => !workspace.includes(p))];
  }
  return selected.includes(value) ? selected.filter(p => p !== value) : [...selected, value];
}

/** The Manage wizard's steps (Authenticate is oauth-only). */
export type ManageStep = 'authenticate' | 'configure' | 'launch';

/**
 * Route the wizard's initial step on open (#436 §4.0, refined by #437):
 * `authenticated`/`configured` always win and land on Configure — the doc's
 * §2 normalization rule (auth done regardless of the raw status string).
 * Otherwise a runner whose LIVE status says it is mid-login
 * (`authenticating`/`authenticate`) starts at Authenticate even when the
 * relayed detail dropped `authMode` (#433 §7.4 relays the Studio view, which
 * may omit it) — this is the state the row's Manage button most needs to
 * serve. An unauthenticated oauth runner also starts at Authenticate;
 * everything else at Configure.
 */
export function routeInitialStep(opts: { authenticated?: boolean; configured?: boolean; authMode?: string; status?: string }): ManageStep {
  if (opts.authenticated || opts.configured) { return 'configure'; }
  const live = (opts.status ?? '').toLowerCase();
  if (live === 'authenticating' || live === 'authenticate') { return 'authenticate'; }
  if (opts.authMode === 'oauth') { return 'authenticate'; }
  return 'configure';
}

/**
 * The OAuth start payload spells its URL/code fields several ways depending on
 * the agent — return the first present value (#436 §4.1).
 */
export function firstPresent(...vals: Array<string | undefined>): string {
  for (const v of vals) {
    if (v) { return v; }
  }
  return '';
}

/**
 * Per-agent model presets (#2886) — mirrors the web CloudRunnerDetail
 * MODEL_OPTIONS_BY_AGENT verbatim. The manifest's `agent.model` is what the
 * pod agent actually runs; absent → the server/agent default.
 */
export const MODEL_OPTIONS_BY_AGENT: Record<string, ReadonlyArray<{ value: string; label: string }>> = {
  claude: [
    { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { value: 'claude-fable-5', label: 'Claude Fable 5' },
    { value: 'claude-opus-4.8-fast', label: 'Claude Opus 4.8 Fast' },
    { value: 'claude-opus-4.8', label: 'Claude Opus 4.8' },
    { value: 'claude-sonnet-4.6', label: 'Claude Sonnet 4.6' },
    { value: 'claude-opus-4.6', label: 'Claude Opus 4.6' },
  ],
  codex: [
    { value: 'gpt-5.5', label: 'GPT-5.5' },
    { value: 'gpt-5.5-pro', label: 'GPT-5.5 Pro' },
    { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
    { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
    { value: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max' },
    { value: 'gpt-5-codex', label: 'GPT-5 Codex' },
    { value: 'gpt-5', label: 'GPT-5' },
    { value: 'o4-mini', label: 'o4 Mini' },
  ],
  cursor: [
    { value: 'composer-2.5-fast', label: 'Composer 2.5 Fast' },
    { value: 'gpt-5', label: 'GPT-5' },
    { value: 'sonnet-4-thinking', label: 'Sonnet 4 Thinking' },
    { value: 'auto', label: 'Auto' },
  ],
};

/** Sentinel select value for the free-text custom model id (#2886). */
export const CUSTOM_MODEL_VALUE = '__custom_model__';

/** The web's per-agent default model (CloudRunnerDetail defaultModelForAgent). */
export function defaultModelForAgent(agentType: string | undefined): string {
  if (agentType === 'codex') { return 'gpt-5.5'; }
  if (agentType === 'cursor') { return 'composer-2.5-fast'; }
  return 'claude-sonnet-5';
}

/**
 * Preset options for an agent, with the current (e.g. manifest-saved) model
 * injected as the first option when it isn't a preset — so a custom model
 * saved earlier still renders as the selected value (web parity).
 */
export function modelOptionsForAgent(agentType: string | undefined, currentModel?: string): ReadonlyArray<{ value: string; label: string }> {
  const options = MODEL_OPTIONS_BY_AGENT[agentType || 'claude'] || MODEL_OPTIONS_BY_AGENT.claude;
  if (!currentModel || options.some(o => o.value === currentModel)) { return options; }
  return [{ value: currentModel, label: currentModel }, ...options];
}

/** Is `model` one of the agent's presets? Drives the preset-vs-custom mode. */
export function isPresetModel(agentType: string | undefined, model: string): boolean {
  const options = MODEL_OPTIONS_BY_AGENT[agentType || 'claude'] || MODEL_OPTIONS_BY_AGENT.claude;
  return options.some(o => o.value === model);
}

/**
 * The Configure-form defaults recovered from a runner's saved launch manifest
 * (#2885) — what the web's applyManifest pre-fills. All values non-secret.
 */
export interface SavedRunnerConfig {
  personas: string[];
  sessionType?: 'vibeflow' | 'vanilla';
  branch?: string;
  worktree?: boolean;
  worktreeName?: string;
  newBranch?: boolean;
  llmGateway?: boolean;
  skipPermissions?: boolean;
  workingDir?: string;
  model?: string;
}

/**
 * Map a saved RunnerSession manifest to Configure-form defaults (#2885),
 * mirroring the web's applyManifest field-for-field. Tolerant: a non-object
 * manifest yields undefined; unknown personas are dropped; absent fields stay
 * undefined so the form keeps its own defaults.
 */
export function manifestToSavedConfig(manifest: unknown): SavedRunnerConfig | undefined {
  if (!manifest || typeof manifest !== 'object') { return undefined; }
  const m = manifest as { vibeflow?: Record<string, unknown>; agent?: Record<string, unknown>; repos?: unknown };
  const vf = (m.vibeflow && typeof m.vibeflow === 'object' ? m.vibeflow : {}) as Record<string, unknown>;
  const agent = (m.agent && typeof m.agent === 'object' ? m.agent : {}) as Record<string, unknown>;
  const repo = Array.isArray(m.repos) ? (m.repos[0] as { path?: unknown } | undefined) : undefined;

  const known = new Set<string>(VIBEFLOW_PERSONAS);
  const workspace = WORKSPACE_PERSONAS as readonly string[];
  let workspaceSeen = false;
  const personas = (Array.isArray(vf.personas) ? (vf.personas as unknown[]) : [])
    .filter((p): p is string => typeof p === 'string' && known.has(p))
    // Keep only the FIRST workspace persona (#2887) — a stale multi-workspace
    // manifest must not re-seed an invalid selection (web parity).
    .filter(p => {
      if (!workspace.includes(p)) { return true; }
      if (workspaceSeen) { return false; }
      workspaceSeen = true;
      return true;
    });

  return {
    personas,
    sessionType: vf.sessionType === 'vanilla' ? 'vanilla' : vf.sessionType === 'vibeflow' ? 'vibeflow' : undefined,
    branch: typeof vf.branch === 'string' && vf.branch ? vf.branch : undefined,
    worktree: typeof vf.worktree === 'boolean' ? vf.worktree : undefined,
    worktreeName: typeof vf.worktreeName === 'string' && vf.worktreeName ? vf.worktreeName : undefined,
    newBranch: typeof vf.newBranch === 'boolean' ? vf.newBranch : undefined,
    llmGateway: typeof vf.llmGateway === 'boolean' ? vf.llmGateway : undefined,
    skipPermissions: typeof agent.skipPermissions === 'boolean' ? agent.skipPermissions : undefined,
    workingDir: repo && typeof repo.path === 'string' && repo.path ? repo.path : undefined,
    model: typeof agent.model === 'string' && agent.model ? agent.model : undefined,
  };
}

/** Inputs for {@link buildRunnerManifest}. All values are non-secret config. */
export interface LaunchConfig {
  agentType: string;
  authMode: string;
  loginMethod?: string;
  /** Model id the pod agent runs (#2886); absent → server/agent default. */
  model?: string;
  project: string;
  personas: readonly string[];
  sessionType: 'vibeflow' | 'vanilla';
  workingDir: string;
  branch: string;
  worktree: boolean;
  /** Optional worktree name (#2888); absent → server auto-generates one. */
  worktreeName?: string;
  newBranch: boolean;
  llmGateway: boolean;
  skipPermissions: boolean;
}

/**
 * Build the `RunnerSession` launch manifest (#436 §4.3). The vibeflow
 * credentials use `${VAULT:...}` placeholders the server resolves from the
 * runner's per-user vault credential — this function NEVER embeds a real
 * token/secret (a hard security invariant, enforced by review + tests).
 */
export function buildRunnerManifest(cfg: LaunchConfig): Record<string, unknown> {
  return {
    apiVersion: 'nimbus.axiom/v1',
    kind: 'RunnerSession',
    agent: {
      type: cfg.agentType,
      authMode: cfg.authMode,
      loginMethod: cfg.loginMethod ?? 'claude',
      ...(cfg.model ? { model: cfg.model } : {}),
      skipPermissions: cfg.skipPermissions,
    },
    vibeflow: {
      serverUrl: '${VAULT:base_url}',
      apiToken: '${VAULT:api_key}',
      provider: cfg.agentType,
      project: cfg.project,
      personas: [...cfg.personas],
      sessionType: cfg.sessionType,
      branch: cfg.branch,
      worktree: cfg.worktree,
      ...(cfg.worktreeName ? { worktreeName: cfg.worktreeName } : {}),
      newBranch: cfg.newBranch,
      // Force-off for agents the gateway can't proxy (#2888 — cursor).
      llmGateway: cfg.llmGateway && llmGatewaySupportedForAgent(cfg.agentType),
      // The web always launches with runMode 'direct' — keep the manifests
      // byte-compatible for the cortex reconcilers (#2886).
      runMode: 'direct',
    },
    mcpServers: [{
      name: 'vibeflow',
      transport: 'http',
      url: '${VAULT:base_url}/mcp',
      headers: { Authorization: 'Bearer ${VAULT:api_key}' },
    }],
    repos: [{ path: cfg.workingDir, branch: cfg.branch, trusted: true }],
  };
}

// --- Pod terminal transport + framing (#2818, reworked in #3588) ---
//
// The axiomcloud backend replaced the tmux bridge documented in spec #433 §8/§9
// with a raw-PTY SockJS bridge (axiomcloud handlers/cloud_runners_passthrough.go):
// POST `terminal/session` returns a session id, then GET `terminal/ws` bridges
// the client to Studio's pod-exec PTY socket. The inner messages are cortex's
// TerminalMessage protocol with capitalized fields (Op/SessionID/Data/Cols/Rows),
// matching the working web client (CloudRunnerTerminal.jsx).

/**
 * Derive the terminal WebSocket URL for a runner from the REST base URL:
 * `https:`→`wss:` / `http:`→`ws:` (mirrors `buildUIWebSocketUrl`). Any other
 * protocol is rejected so a Bearer token is never sent over an insecure
 * transport, and query/hash are stripped so the token never rides the URL.
 */
export function deriveTerminalWsUrl(baseUrl: string, projectId: number, id: number): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) { throw new Error('serverUrl is empty'); }
  const base = new URL(trimmed.endsWith('/') ? trimmed : `${trimmed}/`);
  if (base.protocol === 'https:') { base.protocol = 'wss:'; }
  else if (base.protocol === 'http:') { base.protocol = 'ws:'; }
  else { throw new Error(`serverUrl protocol ${base.protocol} does not support WebSocket`); }
  const prefix = base.pathname.replace(/\/+$/, '');
  base.pathname = `${prefix}/rest/v1/vibeflow/projects/${projectId}/cloud-runners/${id}/terminal/ws`.replace(/\/{2,}/g, '/');
  base.search = '';
  base.hash = '';
  return base.toString();
}

/**
 * Extract the session id from the `POST .../terminal/session` response. The
 * relay may deliver the Studio `{code,status,result}` envelope or a bare body,
 * and the field is spelled `sessionId` or `SessionID` depending on the layer
 * (web parity: extractTerminalSessionID). Empty string when absent.
 */
export function extractTerminalSessionId(response: unknown): string {
  const r = response as {
    result?: { sessionId?: string; SessionID?: string };
    sessionId?: string;
    SessionID?: string;
  } | null | undefined;
  return r?.result?.sessionId || r?.result?.SessionID || r?.sessionId || r?.SessionID || '';
}

/** Client→server session-bind frame — MUST be the first frame after connect. */
export function encodeTerminalBind(sessionId: string): string {
  return JSON.stringify({ Op: 'bind', SessionID: sessionId });
}

/** Client→server keystroke frame. */
export function encodeTerminalStdin(data: string): string {
  return JSON.stringify({ Op: 'stdin', SessionID: '', Data: data });
}

/** Client→server PTY-resize frame. */
export function encodeTerminalResize(cols: number, rows: number): string {
  return JSON.stringify({ Op: 'resize', Cols: cols, Rows: rows });
}

/**
 * Classify a server→client terminal message: `{Op:"stdout",Data}` is terminal
 * output; `{Op:"error",Data}` is a status message (the bridge sends one when
 * the Studio dial fails, then closes). Anything else — other Ops, non-JSON —
 * is ignored, exactly like the web client.
 */
export function parseTerminalServerMessage(text: string): { kind: 'stdout'; data: string } | { kind: 'error'; message: string } | { kind: 'ignore' } {
  try {
    const obj = JSON.parse(text) as { Op?: unknown; Data?: unknown } | null;
    if (obj && typeof obj === 'object') {
      if (obj.Op === 'stdout' && typeof obj.Data === 'string') { return { kind: 'stdout', data: obj.Data }; }
      if (obj.Op === 'error') {
        return { kind: 'error', message: typeof obj.Data === 'string' ? obj.Data : 'terminal error' };
      }
    }
  } catch {
    // Not JSON — ignore (web parity).
  }
  return { kind: 'ignore' };
}
