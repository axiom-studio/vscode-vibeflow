import type { ContextProxy } from '../core/ContextProxy.js';

/**
 * Per-launch session mode tracker.
 *
 * Backing store: ContextProxy.get('vibeflow.launchModes') — a flat
 * `Record<string, string>` keyed by `{persona}::{branch}::{workDir}`.
 *
 * The .vibeflow-session-{persona} sidecar files only carry the session
 * id (the agent writes them via session_init and we don't want to fight
 * that contract), so we can't recover the launch mode by reading them
 * back. Tracking on the extension side is the simplest way to make
 * reattach (cold start) and restart (hot kill+respawn) honor the user's
 * original choice without re-prompting.
 */

function key(persona: string, branch: string, workDir: string): string {
  return `${persona}::${branch}::${workDir}`;
}

export function recordLaunchMode(
  context: ContextProxy,
  persona: string,
  branch: string,
  workDir: string,
  mode: string,
): Promise<void> {
  const map = (context.get('vibeflow.launchModes') ?? {}) as Record<string, string>;
  map[key(persona, branch, workDir)] = mode;
  return context.set('vibeflow.launchModes', map);
}

export function lookupLaunchMode(
  context: ContextProxy,
  persona: string,
  branch: string,
  workDir: string,
): string | undefined {
  const map = context.get('vibeflow.launchModes') as Record<string, string> | undefined;
  return map?.[key(persona, branch, workDir)];
}
