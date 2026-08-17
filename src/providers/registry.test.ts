import { describe, it, expect } from 'vitest';
import {
  PROVIDER_REGISTRY,
  getProvider,
  launchableProviders,
  detectNames,
  providerBinaryDisplayName,
  type ProviderDef,
} from './registry.js';
import { AGENT_BINARIES } from '../commands/sessionCommands.js';
import { getAdapter } from '../sessions/providerAdapters/index.js';

/**
 * Guards for the provider registry (issue #4633).
 *
 * These lock the properties a careless refactor would actually break — not
 * the registry's literal contents, which are meant to change every time a
 * provider is added. Adding Copilot (todo #3291) should require NO edits to
 * this file; if it does, the derivation has stopped deriving.
 */

describe('PROVIDER_REGISTRY', () => {
  it('has unique keys', () => {
    const keys = PROVIDER_REGISTRY.map(p => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every provider a non-empty name, label and binary', () => {
    for (const p of PROVIDER_REGISTRY) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.binary.length).toBeGreaterThan(0);
    }
  });

  it('exposes launchable providers as a subset, preserving registry order', () => {
    const launchable = launchableProviders().map(p => p.key);
    const registryOrder = PROVIDER_REGISTRY.filter(p => p.launchable).map(p => p.key);
    expect(launchable).toEqual(registryOrder);
  });
});

describe('binary names', () => {
  // The invariant that a naive "just merge the two binary lists" refactor
  // breaks: Cursor is SPAWNED as `agent` but DISPLAYED as `cursor-agent`.
  // Collapsing them either spawns a binary that may not exist or prints a
  // name the user cannot install.
  it('keeps the spawn binary and the display name distinct for cursor', () => {
    expect(getProvider('cursor')?.binary).toBe('agent');
    expect(providerBinaryDisplayName('cursor')).toBe('cursor-agent');
    expect(detectNames('cursor')).toEqual(['cursor-agent', 'agent']);
  });

  it('defaults detect names to the spawn binary when no aliases are declared', () => {
    // Widened to the interface: `as const` narrows each entry to its own
    // literal shape, so members that omit `detectBinaries` have no such
    // property to read off the union.
    const all: readonly ProviderDef[] = PROVIDER_REGISTRY;
    for (const p of all) {
      if (p.detectBinaries) { continue; }
      expect(detectNames(p.key)).toEqual([p.binary]);
    }
  });

  it('falls back to the key itself for an unregistered provider', () => {
    // `vibeflow.defaultProvider` is a free-form string with no enum, so a
    // stale value must probe something rather than throw.
    expect(detectNames('not-a-provider')).toEqual(['not-a-provider']);
    expect(providerBinaryDisplayName('not-a-provider')).toBe('not-a-provider');
    expect(getProvider('not-a-provider')).toBeUndefined();
  });
});

describe('derived surfaces agree with the registry', () => {
  it('AGENT_BINARIES covers every provider, launchable or not', () => {
    for (const p of PROVIDER_REGISTRY) {
      expect(AGENT_BINARIES[p.key]).toBe(p.binary);
    }
    expect(Object.keys(AGENT_BINARIES).sort()).toEqual(PROVIDER_REGISTRY.map(p => p.key).sort());
  });

  it('registers a stream-json adapter only for known providers', () => {
    // `ProviderKey` is generated from the registry, so this is already a
    // compile-time guarantee. Asserted at runtime too because `ADAPTERS` is a
    // `Partial<Record<...>>` and a cast at the lookup boundary could reopen it.
    for (const p of PROVIDER_REGISTRY) {
      const adapter = getAdapter(p.key);
      if (adapter) { expect(adapter.providerKey).toBe(p.key); }
    }
    expect(getAdapter('not-a-provider')).toBeUndefined();
  });

  it('lets a provider carry an adapter without being launchable', () => {
    // qwen is exactly this case today: a complete adapter, deliberately not
    // offered because `TerminalRegistry` cannot yet build its `-i` prompt
    // shape (todo #3293). The registry must be able to express it — that is
    // what stops the state from being silently half-wired again.
    //
    // This is a TRIPWIRE, not a permanent ban: promoting qwen is expected and
    // should update this assertion. It fails on the flip so that whoever makes
    // it has to confirm #3293 landed first, rather than shipping a provider
    // the wizard offers but the terminal cannot start.
    const qwen = getProvider('qwen');
    expect(qwen?.launchable).toBe(false);
    expect(getAdapter('qwen')).toBeDefined();
    expect(launchableProviders().map(p => p.key)).not.toContain('qwen');
  });
});

describe('agent docs', () => {
  it('has more than one launchable provider sharing a doc file', () => {
    // `ensureAllAgentDocs` dedups by filename via `seenFile`. If every doc
    // file became unique, that dedup would silently stop being exercised and
    // a future duplicate would write the same file twice.
    const docFiles = launchableProviders().map(p => p.docFile).filter(Boolean);
    expect(new Set(docFiles).size).toBeLessThan(docFiles.length);
  });

  it('declares a doc file for every launchable provider', () => {
    // A launchable provider with no doc file starts a session in a workspace
    // with no vibeflow session rules, so it never calls session_init.
    for (const p of launchableProviders()) {
      expect(p.docFile, `${p.key} has no docFile`).toBeTruthy();
    }
  });
});
