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
 * Items "+" picker, and the open-page commands decline. Flip to `true` to
 * re-enable everything — all code paths stay in place.
 */
export const CLOUD_RUNNERS_BUILD_ENABLED = false;

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

/**
 * Parse a free-text list of repo URLs (comma- or newline-separated) into the
 * `gitRepos` shape. Blank entries are dropped; an empty/whitespace input
 * yields an empty list (no repos requested).
 */
export function parseRepoUrls(input: string): CloudRunnerRepo[] {
  return input
    .split(/[\n,]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(url => ({ url }));
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
 * `active` = ready (stop, success); `failed` = terminal error (stop, surface);
 * everything else (pending/starting/…) = keep polling.
 */
export function runnerPollState(status: string): RunnerPollState {
  if (status === 'active') { return 'active'; }
  if (status === 'failed') { return 'failed'; }
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

/** Launch is enabled only with a working directory, a project, and ≥1 persona. */
export function canLaunch(workingDir: string, project: string, personas: readonly string[]): boolean {
  return workingDir.trim().length > 0 && project.trim().length > 0 && personas.length > 0;
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

/** Inputs for {@link buildRunnerManifest}. All values are non-secret config. */
export interface LaunchConfig {
  agentType: string;
  authMode: string;
  loginMethod?: string;
  project: string;
  personas: readonly string[];
  sessionType: 'vibeflow' | 'vanilla';
  workingDir: string;
  branch: string;
  worktree: boolean;
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
      newBranch: cfg.newBranch,
      llmGateway: cfg.llmGateway,
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

// --- Pod terminal (tmux) transport + framing (#2818, spec #436 §4.4) ---

/**
 * Derive the tmux WebSocket URL for a runner from the REST base URL: `https:`→
 * `wss:` / `http:`→`ws:` (mirrors `buildUIWebSocketUrl`). Any other protocol is
 * rejected so a Bearer token is never sent over an insecure transport.
 */
export function deriveTmuxWsUrl(baseUrl: string, projectId: number, id: number): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) { throw new Error('serverUrl is empty'); }
  const base = new URL(trimmed.endsWith('/') ? trimmed : `${trimmed}/`);
  if (base.protocol === 'https:') { base.protocol = 'wss:'; }
  else if (base.protocol === 'http:') { base.protocol = 'ws:'; }
  else { throw new Error(`serverUrl protocol ${base.protocol} does not support WebSocket`); }
  const prefix = base.pathname.replace(/\/+$/, '');
  base.pathname = `${prefix}/rest/v1/vibeflow/projects/${projectId}/cloud-runners/${id}/tmux/ws`.replace(/\/{2,}/g, '/');
  base.search = '';
  base.hash = '';
  return base.toString();
}

/** Client→server keystroke frame. */
export function encodeTmuxInput(data: string): string {
  return JSON.stringify({ type: 'input', data });
}

/** Client→server terminal-resize frame. */
export function encodeTmuxResize(cols: number, rows: number): string {
  return JSON.stringify({ type: 'resize', cols, rows });
}

/**
 * Classify a server→client tmux frame: a `{type:"error",message}` control frame
 * (the server sends one then closes) vs raw terminal output. Non-JSON and any
 * non-error JSON is treated as output bytes.
 */
export function parseTmuxServerFrame(text: string): { kind: 'error'; message: string } | { kind: 'output'; data: string } {
  try {
    const obj = JSON.parse(text) as unknown;
    if (obj && typeof obj === 'object' && (obj as { type?: unknown }).type === 'error') {
      const message = (obj as { message?: unknown }).message;
      return { kind: 'error', message: typeof message === 'string' ? message : 'terminal error' };
    }
  } catch {
    // Not JSON — raw terminal output.
  }
  return { kind: 'output', data: text };
}
