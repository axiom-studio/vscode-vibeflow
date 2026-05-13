import type { ProviderAdapter, ProviderKey } from './types.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { geminiAdapter } from './gemini.js';
import { qwenAdapter } from './qwen.js';
import { cursorAdapter } from './cursor.js';

/**
 * Provider-key → adapter registry.
 *
 * Returns `undefined` for unknown or not-yet-implemented providers;
 * callers must downgrade to REST polling and surface a one-time
 * warning. See `SessionStreamRegistry` for that policy.
 *
 * All five providers in the launch wizard's PROVIDERS list have a
 * stream-json adapter registered here. See VibeFlow document #285
 * §3.2 for the provider matrix.
 */
const ADAPTERS: Partial<Record<ProviderKey, ProviderAdapter>> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter,
  qwen: qwenAdapter,
  cursor: cursorAdapter,
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
