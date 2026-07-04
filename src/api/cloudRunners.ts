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
import type { FeatureFlags, CreateRunnerRequest, CloudRunnerRepo } from './types.js';

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

/** Convenience: is the Cloud Runners capability enabled for the caller's org? */
export function cloudRunnersEnabled(flags: FeatureFlags | undefined | null): boolean {
  return isFeatureEnabled(flags, FEATURE_CLOUD_RUNNERS);
}

/**
 * Unwrap a `{ [key]: T[] }` list envelope defensively. AxiomCloud list
 * endpoints wrap their arrays (e.g. `{providers: [...]}`, `{runners: [...]}`);
 * a missing/null field or a non-array value means "zero rows", not an error.
 */
export function unwrapList<T>(envelope: unknown, key: string): T[] {
  if (envelope && typeof envelope === 'object') {
    const value = (envelope as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      return value as T[];
    }
  }
  return [];
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
 * A runner is "running" (the page shows a Stop action) when its lifecycle
 * status is `active` or `running` (#603 management, spec #436 §2).
 */
export function isRunnerRunning(status: string): boolean {
  return status === 'active' || status === 'running';
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

/** The 9 vibeflow personas selectable when configuring a runner session. */
export const VIBEFLOW_PERSONAS = [
  'developer', 'principal_engineer', 'architect', 'ux_designer', 'qa_lead',
  'security_lead', 'product_manager', 'project_manager', 'customer',
] as const;

/** The Manage wizard's steps (Authenticate is oauth-only). */
export type ManageStep = 'authenticate' | 'configure' | 'launch';

/**
 * Route the wizard's initial step on open (#436 §4.0): an already
 * authenticated/configured runner lands on Configure; an unauthenticated
 * oauth runner starts at Authenticate; everything else at Configure.
 */
export function routeInitialStep(opts: { authenticated?: boolean; configured?: boolean; authMode?: string }): ManageStep {
  if (opts.authenticated || opts.configured) { return 'configure'; }
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
