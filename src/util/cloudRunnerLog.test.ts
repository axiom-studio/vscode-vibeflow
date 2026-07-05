import { describe, it, expect } from 'vitest';
import { initCloudRunnerDebug, setCloudRunnerDebug, isCloudRunnerDebugEnabled } from './cloudRunnerLog.js';

/**
 * #3398 — the Cloud Runners debug toggle persists via globalState, NOT
 * config.update() (VS Code rejects programmatic writes of unregistered
 * configuration keys). These tests drive the state module with a fake
 * Memento; the vscode stub's getConfiguration().get() returns the default
 * (false), which doubles as coverage for the config-fallback path.
 */

type Host = Parameters<typeof initCloudRunnerDebug>[0];

function fakeHost(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  const globalState = {
    keys: () => [...store.keys()],
    get: (key: string, defaultValue?: unknown) => (store.has(key) ? store.get(key) : defaultValue),
    update: async (key: string, value: unknown) => { store.set(key, value); },
  } as unknown as Host['globalState'];
  return { host: globalState, store };
}

describe('cloudRunnerLog debug state (#3398)', () => {
  it('is off by default (empty globalState + config fallback false)', () => {
    const { host } = fakeHost();
    initCloudRunnerDebug({ globalState: host });
    expect(isCloudRunnerDebugEnabled()).toBe(false);
  });

  it('restores a persisted true at init', () => {
    const { host } = fakeHost({ 'vibeflow.cloudRunners.debug': true });
    initCloudRunnerDebug({ globalState: host });
    expect(isCloudRunnerDebugEnabled()).toBe(true);
  });

  it('setCloudRunnerDebug flips the flag and persists it to globalState', async () => {
    const { host, store } = fakeHost();
    initCloudRunnerDebug({ globalState: host });

    await setCloudRunnerDebug(true);
    expect(isCloudRunnerDebugEnabled()).toBe(true);
    expect(store.get('vibeflow.cloudRunners.debug')).toBe(true);

    await setCloudRunnerDebug(false);
    expect(isCloudRunnerDebugEnabled()).toBe(false);
    expect(store.get('vibeflow.cloudRunners.debug')).toBe(false);
  });
});
