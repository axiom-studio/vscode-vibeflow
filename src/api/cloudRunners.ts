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
