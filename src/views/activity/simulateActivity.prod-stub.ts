import type { ActivityEntry } from '../../api/types.js';

/**
 * Production stub for the dev-only Activity Feed simulator.
 *
 * The real `simulateActivity.ts` ships ~100 lines of fake persona
 * names and sample log content used to populate the Activity Feed
 * during local development. It is gated behind the
 * `vibeflow.debug.simulateActivity` setting (default false) and is
 * never imported in production code paths.
 *
 * esbuild swaps `simulateActivity.ts` for this file during
 * `--production` builds (see esbuild.mjs alias plugin). If somehow
 * the runtime flag still flips on inside a shipped extension — e.g.
 * a user hand-edited their settings.json — these stubs throw a clear
 * error rather than silently no-op, so the misconfiguration is
 * obvious instead of confusingly quiet.
 */

const NOT_AVAILABLE = 'VibeFlow: simulateActivity is not available in production builds.';

export function generateBatch(_count: number): ActivityEntry[] {
  throw new Error(NOT_AVAILABLE);
}

export function generateOne(): ActivityEntry {
  throw new Error(NOT_AVAILABLE);
}
