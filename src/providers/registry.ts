import { isBinaryOnPath } from '../utils/whichBinary.js';

/**
 * Single source of truth for launch providers (issue #4633).
 *
 * Before this module the extension carried six independent, hand-maintained
 * provider lists — the launch wizard's `PROVIDERS`, its `PROVIDER_BINARIES`,
 * `sessionCommands.AGENT_BINARIES`, the Settings tab's `providers[]` and its
 * `providerEnvName()`, and the agent-doc map + its loop array. They disagreed:
 * `qwen` was in `ProviderKey` and had a full stream-json adapter but was absent
 * from the wizard, so nothing could reach it. Adding a provider meant six edits
 * and hoping none was missed; `buildLaunchCommand`'s bare `return binary`
 * fallback (todo #3292) shows what a missed list costs — a provider that looks
 * registered and silently does nothing.
 *
 * Every launch-keyed surface now derives from `PROVIDER_REGISTRY`, so those
 * lists cannot disagree. `ProviderKey` is derived from it too, which makes
 * "every stream-json adapter belongs to a real provider" a compile error rather
 * than a test someone has to remember to write.
 *
 * NOT in scope here: `MCP_AGENTS` in `commands/cliBootstrap.ts`. That list is
 * keyed on a different axis — MCP-config write targets, not launchable agents —
 * which is why it holds both `claude-cli` and `claude-desktop` for the single
 * provider "claude", and why `kiro` appears there without being launchable.
 * A launch registry cannot represent two config targets for one provider, so
 * merging the two would lose information. They are correctly separate.
 */

export interface ProviderDef {
  /** Stable key used by config, launch, adapters and agent docs. */
  readonly key: string;

  /** Human-readable name for the Settings tab's provider table. */
  readonly name: string;

  /** Codicon-prefixed label for the launch wizard's quick-pick. */
  readonly label: string;

  /**
   * Binary actually spawned at launch. Note this is NOT always the name we
   * show the user: Cursor spawns `agent` but is displayed as `cursor-agent`.
   */
  readonly binary: string;

  /**
   * Extra binary names that also satisfy the availability check, most
   * canonical first. Defaults to `[binary]`. `detectNames(key)[0]` is what
   * user-facing "not found on PATH" errors print, so order is load-bearing.
   */
  readonly detectBinaries?: readonly string[];

  /** Agent-doc file this provider reads, if it reads one. */
  readonly docFile?: string;

  /** Env var holding this provider's token, when VibeFlow manages one. */
  readonly envTokenName?: string;

  /** Ships VibeFlow MCP integration out of the box (a Settings-tab column). */
  readonly vibeflowIntegrated: boolean;

  /**
   * Selectable in the launch wizard and listed in the Settings table.
   *
   * `false` means the extension knows the provider (it may even have a
   * stream-json adapter) but will not offer it — see `qwen` below.
   */
  readonly launchable: boolean;
}

/**
 * Order is user-visible: `buildProvidersWithAvailability()` renders the
 * launchable entries in this order in the wizard's quick-pick.
 */
export const PROVIDER_REGISTRY = [
  {
    key: 'claude',
    name: 'Claude Code',
    label: '$(hubot) Claude',
    binary: 'claude',
    docFile: 'CLAUDE.md',
    vibeflowIntegrated: true,
    launchable: true,
  },
  {
    key: 'codex',
    name: 'OpenAI Codex CLI',
    label: '$(code) Codex',
    binary: 'codex',
    docFile: 'AGENTS.md',
    envTokenName: 'MCP_TOKEN',
    vibeflowIntegrated: false,
    launchable: true,
  },
  {
    key: 'gemini',
    name: 'Google Gemini CLI',
    label: '$(sparkle) Gemini',
    binary: 'gemini',
    docFile: 'GEMINI.md',
    envTokenName: 'GEMINI_API_KEY',
    vibeflowIntegrated: false,
    launchable: true,
  },
  {
    // Not launchable, deliberately. Qwen has a complete stream-json adapter
    // (`providerAdapters/qwen.ts`) but shares Copilot's init-prompt defect:
    // it has no positional prompt argument and needs `-i '<prompt>'`, while
    // `TerminalRegistry.ts:94-106` passes the prompt positionally for every
    // provider unconditionally. Promoting qwen before todo #3293 lands the
    // per-provider prompt shape would ship a provider that cannot start a
    // session. Flip `launchable` once #3293 is in — that is the whole change.
    key: 'qwen',
    name: 'Qwen Code',
    // Qwen Code is a fork of gemini-cli, so it borrows Gemini's icon.
    label: '$(sparkle) Qwen',
    binary: 'qwen',
    vibeflowIntegrated: false,
    launchable: false,
  },
  {
    // Cursor's IDE-bundled binary is `cursor-agent`; some installs alias it
    // as `agent`, which is what we spawn. Either on PATH counts as available.
    key: 'cursor',
    name: 'Cursor Agent',
    label: '$(terminal) Cursor',
    binary: 'agent',
    detectBinaries: ['cursor-agent', 'agent'],
    docFile: 'AGENTS.md', // Cursor reads the same file as codex.
    vibeflowIntegrated: true,
    launchable: true,
  },
] as const satisfies readonly ProviderDef[];

/**
 * Every provider the extension knows about, launchable or not. Derived from
 * the registry so an adapter for an unregistered provider fails to compile.
 */
export type ProviderKey = typeof PROVIDER_REGISTRY[number]['key'];

/** Look up a provider by key; undefined for keys we don't know. */
export function getProvider(key: string): ProviderDef | undefined {
  return PROVIDER_REGISTRY.find(p => p.key === key);
}

/** Providers offered in the launch wizard and the Settings table, in order. */
export function launchableProviders(): readonly ProviderDef[] {
  return PROVIDER_REGISTRY.filter(p => p.launchable);
}

/**
 * Binary names that satisfy the availability check for `key`, most canonical
 * first. Unknown keys fall back to `[key]` so a stale `vibeflow.defaultProvider`
 * (a free-form string in package.json, no enum) still probes something sensible
 * instead of throwing.
 */
export function detectNames(key: string): readonly string[] {
  const provider = getProvider(key);
  if (!provider) { return [key]; }
  return provider.detectBinaries ?? [provider.binary];
}

/** Whether any binary name for `key` is on PATH. */
export function isProviderInstalled(key: string): boolean {
  return detectNames(key).some(name => isBinaryOnPath(name));
}

/** Canonical binary name to print in user-facing error messages. */
export function providerBinaryDisplayName(key: string): string {
  return detectNames(key)[0];
}
