import { describe, it, expect, beforeEach } from 'vitest';
import { FeedStateController } from './feedStateController.js';
import type { ActivityFeedProvider } from './ActivityFeedProvider.js';
import type { FeedState } from '../../core/webviewMessages.js';

/**
 * Capture-only stub for ActivityFeedProvider. Implements ONLY the one
 * method FeedStateController calls — `pushFeedState`. The wider
 * ActivityFeedProvider class has many other methods that depend on
 * vscode/webview surfaces; we'd be fighting the framework to construct
 * a real one here, and we're testing the controller, not the provider.
 *
 * Per project rule: this is a stub of the EXTERNAL BOUNDARY (the
 * webview push), not a stub of the module under test.
 */
class CapturingProvider {
  pushed: FeedState[] = [];
  pushFeedState(state: FeedState): void {
    this.pushed.push(state);
  }
}

describe('FeedStateController', () => {
  let provider: CapturingProvider;
  let c: FeedStateController;

  beforeEach(() => {
    provider = new CapturingProvider();
    c = new FeedStateController(provider as unknown as ActivityFeedProvider);
  });

  it('does not emit until something changes', () => {
    expect(provider.pushed).toEqual([]);
  });

  it('emits `unauthenticated` when only auth flips on', () => {
    c.setAuth(true);
    expect(provider.pushed.at(-1)?.kind).toBe('unauthenticated');
  });

  it('emits `noSessions` when auth + project are both on with zero sessions', () => {
    c.setAuth(true);
    c.setProjectActive(true);
    expect(provider.pushed.at(-1)?.kind).toBe('noSessions');
  });

  it('emits `sessionsActive` when at least one session is live', () => {
    c.setAuth(true);
    c.setProjectActive(true);
    c.setActiveSessionCount(1);
    expect(provider.pushed.at(-1)?.kind).toBe('sessionsActive');
  });

  it('dedupes — setting the same value twice does not re-emit', () => {
    c.setAuth(true);
    const countAfterFirstAuth = provider.pushed.length;
    c.setAuth(true);
    expect(provider.pushed.length).toBe(countAfterFirstAuth);
  });

  it('dedupes resolved-state-equality (no emit when transition leaves kind unchanged)', () => {
    c.setAuth(true);
    c.setProjectActive(true);
    c.setActiveSessionCount(0);
    // setActiveSessionCount(0) → resolves to noSessions, same as prior; no extra emit.
    const beforeLen = provider.pushed.length;
    c.setActiveSessionCount(0); // no-op, value unchanged
    expect(provider.pushed.length).toBe(beforeLen);
  });

  it('transitions to disconnected after threshold consecutive poll failures', () => {
    c.setAuth(true);
    c.setProjectActive(true);
    c.setActiveSessionCount(1);
    c.pollFailed();
    c.pollFailed();
    expect(provider.pushed.at(-1)?.kind).toBe('sessionsActive'); // not yet at threshold
    c.pollFailed(); // 3rd
    expect(provider.pushed.at(-1)?.kind).toBe('disconnected');
  });

  it('clears disconnected on poll success', () => {
    c.setAuth(true);
    c.setProjectActive(true);
    c.setActiveSessionCount(1);
    c.pollFailed(); c.pollFailed(); c.pollFailed();
    expect(provider.pushed.at(-1)?.kind).toBe('disconnected');
    c.pollSucceeded();
    expect(provider.pushed.at(-1)?.kind).toBe('sessionsActive');
  });

  it('pollSucceeded is a no-op when failures were already at zero', () => {
    c.setAuth(true);
    c.setProjectActive(true);
    c.setActiveSessionCount(1);
    const before = provider.pushed.length;
    c.pollSucceeded();
    expect(provider.pushed.length).toBe(before);
  });

  it('resets failures on project disconnect (no spurious disconnected on next connect)', () => {
    c.setAuth(true);
    c.setProjectActive(true);
    c.pollFailed(); c.pollFailed(); c.pollFailed();
    expect(provider.pushed.at(-1)?.kind).toBe('disconnected');
    c.setProjectActive(false);
    // Now auth is true, project is false → unauthenticated.
    expect(provider.pushed.at(-1)?.kind).toBe('unauthenticated');
    c.setProjectActive(true);
    c.setActiveSessionCount(1);
    // Fresh state should be sessionsActive, not disconnected.
    expect(provider.pushed.at(-1)?.kind).toBe('sessionsActive');
  });

  it('flush re-emits the last computed state (handles late-mount webview)', () => {
    c.setAuth(true);
    c.setProjectActive(true);
    c.setActiveSessionCount(1);
    const lastKind = provider.pushed.at(-1)?.kind;
    const before = provider.pushed.length;
    c.flush();
    expect(provider.pushed.length).toBe(before + 1);
    expect(provider.pushed.at(-1)?.kind).toBe(lastKind);
  });

  it('flush triggers a compute when nothing has been resolved yet', () => {
    c.flush(); // nothing set → default unauthenticated
    expect(provider.pushed.at(-1)?.kind).toBe('unauthenticated');
  });

  it('logging out flips back to unauthenticated', () => {
    c.setAuth(true);
    c.setProjectActive(true);
    c.setActiveSessionCount(1);
    c.setAuth(false);
    expect(provider.pushed.at(-1)?.kind).toBe('unauthenticated');
  });

  it('counting up beyond threshold does not re-emit (only the boundary emits)', () => {
    c.setAuth(true);
    c.setProjectActive(true);
    c.setActiveSessionCount(1);
    c.pollFailed(); c.pollFailed(); c.pollFailed(); // 3rd → emit disconnected
    const len = provider.pushed.length;
    c.pollFailed(); c.pollFailed(); c.pollFailed(); // further failures
    expect(provider.pushed.length).toBe(len);
  });
});
