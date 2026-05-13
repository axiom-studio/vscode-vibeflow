import type { ProviderAdapter, ProviderKey } from './types.js';
import { claudeAdapter } from './claude.js';

/**
 * Provider-key → adapter registry.
 *
 * Returns `undefined` for unknown or not-yet-implemented providers;
 * callers must downgrade to REST polling and surface a one-time
 * warning. See `SessionStreamRegistry` for that policy.
 *
 * Adapters land incrementally per the commit plan in the parent todo:
 *   - Commit A: claude
 *   - Commit B: codex, gemini, qwen, cursor
 */
const ADAPTERS: Partial<Record<ProviderKey, ProviderAdapter>> = {
  claude: claudeAdapter,
  // codex, gemini, qwen, cursor land in commit B
};

/** Look up the adapter for a provider key; undefined if unsupported. */
export function getAdapter(providerKey: string): ProviderAdapter | undefined {
  return ADAPTERS[providerKey as ProviderKey];
}

/** List of provider keys with a registered stream-json adapter. */
export function supportedProviders(): ProviderKey[] {
  return Object.keys(ADAPTERS) as ProviderKey[];
}

export type { ProviderAdapter, ProviderKey, NormalizedAgentEvent } from './types.js';
export { isChatToolUse, redactCredentials } from './types.js';
