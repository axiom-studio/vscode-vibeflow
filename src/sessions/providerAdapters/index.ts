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
 * This map is keyed by `ProviderKey`, which is generated from
 * `providers/registry.ts`, so an adapter for an unregistered provider will
 * not compile. The reverse does NOT hold: a registered provider need not
 * have an adapter, and one currently does not — `qwen` has an adapter but
 * is not launchable (see the registry), while a future launchable provider
 * may ship with no adapter and take the documented REST-polling downgrade.
 * See VibeFlow document #285 §3.2 for the provider matrix.
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

export type { ProviderAdapter, ProviderKey, NormalizedAgentEvent } from './types.js';
export { isChatToolUse, redactCredentials } from './types.js';
