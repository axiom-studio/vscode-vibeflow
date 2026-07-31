import * as vscode from 'vscode';
import { detectIde, shouldReportIdeUsage } from './ideIdentity.js';
import type { VibeFlowClient } from '../api/client.js';
import type { AuthService } from '../auth/AuthService.js';
import type { ContextProxy } from '../core/ContextProxy.js';

/**
 * Reports which IDE this user runs, for their org's seat count (axiomcloud
 * #4210 → the operator org usage modal).
 *
 * Scope is deliberately tiny: three fields — the IDE slug, the IDE version and
 * the extension version — for an already-authenticated user. Nothing about
 * editor content, file names, workspaces or project data is sent, and nothing
 * is sent at all when signed out. That is what keeps this seat/licence
 * bookkeeping rather than behavioural telemetry, and it is a boundary to
 * defend: the moment this starts carrying "what the user did", it becomes
 * telemetry and inherits a different consent and disclosure regime.
 *
 * Failure is always silent. There is no user-facing action to take when a
 * bookkeeping POST fails, so a toast would be pure noise.
 */
export async function reportIdeUsage(
  client: VibeFlowClient,
  auth: AuthService,
  store: ContextProxy,
  extensionVersion: string,
  now: number = Date.now(),
): Promise<void> {
  // Signed out → nothing to attribute the report to. The server derives the
  // user and org from the bearer token, so an unauthenticated call is simply
  // a 401.
  if (!auth.getToken()) { return; }

  if (!shouldReportIdeUsage(store.get('vibeflow.ide.lastReportedAt'), now)) { return; }

  // Stamp before the call, not after: a hanging or failing request must not
  // leave the gate open for a retry on every subsequent activation.
  await store.set('vibeflow.ide.lastReportedAt', now);

  await client.reportIdeUsage({
    ide: detectIde(vscode.env.appName),
    ideVersion: vscode.version,
    extensionVersion,
  });
}

/**
 * Fire the report once, off the activation path.
 *
 * `void` + `.catch` rather than `await`: activation must not block on a
 * network call, and an unhandled rejection in the extension host is sloppy
 * even when the error is genuinely ignorable.
 *
 * No timer. The 24h cadence is enforced by the persisted wall-clock stamp
 * inside `reportIdeUsage`, so one call per activation is sufficient — a
 * long-lived window simply reports once. (If this ever needs to fire *within*
 * a session, ride `PollingCoordinator` behind the same stamp; see
 * commands/cliUpdateCheck.ts for why a naive `subscribe(24h, …)` is wrong.)
 */
export function registerIdeUsageReporting(
  client: VibeFlowClient,
  auth: AuthService,
  store: ContextProxy,
  extensionVersion: string,
): void {
  void reportIdeUsage(client, auth, store, extensionVersion)
    .catch(() => { /* bookkeeping only — never surfaced */ });
}
