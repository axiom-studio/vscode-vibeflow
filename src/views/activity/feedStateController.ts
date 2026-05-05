import type { ActivityFeedProvider } from './ActivityFeedProvider.js';
import type { FeedState } from '../../core/webviewMessages.js';

/**
 * Threshold of consecutive failed poll cycles before the feed is declared
 * disconnected. At a 5s poll cadence, 3 cycles ≈ 15s — long enough to
 * absorb single transient failures (request abort, brief 5xx) without
 * strobing the UI, short enough that a real outage surfaces quickly.
 */
const DISCONNECT_FAILURE_THRESHOLD = 3;

/**
 * Centralized state machine for the Activity Feed's empty/connection state.
 *
 * Inputs come from four observers in `extension.ts`:
 *   - AuthService.onDidChangeState  → setAuth(authenticated)
 *   - connectToProject / disconnect → setProjectActive(true|false)
 *   - SessionsTreeProvider          → setActiveSessionCount(n)
 *   - ActivityPoller                → pollSucceeded() / pollFailed()
 *
 * The output is the resolved `FeedState` defined in webviewMessages.ts;
 * the controller pushes it to the webview only when it changes, so the
 * webview's render path stays idempotent.
 *
 * Why one controller instead of inline pushes from each observer:
 * the empty-state UX depends on the AND of four facts (auth + project +
 * sessions + health). Letting each observer decide its own message would
 * race — e.g. `connectToProject` pushing `noSessions` before the auth
 * change handler pushes `unauthenticated`. A single recompute() under one
 * source of truth removes that ordering hazard.
 */
export class FeedStateController {
  private authenticated = false;
  private projectActive = false;
  private activeSessionCount = 0;
  private consecutiveFailures = 0;
  private last: FeedState | undefined;

  constructor(private readonly feedProvider: ActivityFeedProvider) {}

  setAuth(authenticated: boolean): void {
    if (this.authenticated === authenticated) { return; }
    this.authenticated = authenticated;
    this.recompute();
  }

  setProjectActive(active: boolean): void {
    if (this.projectActive === active) { return; }
    this.projectActive = active;
    if (!active) {
      // Reset health on disconnect so a previous outage doesn't carry into
      // the next connect cycle.
      this.consecutiveFailures = 0;
    }
    this.recompute();
  }

  setActiveSessionCount(count: number): void {
    if (this.activeSessionCount === count) { return; }
    this.activeSessionCount = count;
    this.recompute();
  }

  pollSucceeded(): void {
    if (this.consecutiveFailures === 0) { return; }
    this.consecutiveFailures = 0;
    this.recompute();
  }

  pollFailed(): void {
    this.consecutiveFailures++;
    // Only recompute at the threshold boundary — counting up further
    // changes nothing the webview cares about.
    if (this.consecutiveFailures === DISCONNECT_FAILURE_THRESHOLD) {
      this.recompute();
    }
  }

  /**
   * Force re-emission of the current state. Called once on `ready` from
   * the webview to handle late-mount races where the initial state push
   * landed before the webview was listening. Safe to call any time.
   */
  flush(): void {
    if (this.last) {
      this.feedProvider.pushFeedState(this.last);
    } else {
      // Nothing computed yet → emit a default so the webview never sits in
      // its bare fallback when it could show a real state.
      this.recompute();
    }
  }

  private resolve(): FeedState {
    if (!this.authenticated || !this.projectActive) {
      return { kind: 'unauthenticated' };
    }
    if (this.consecutiveFailures >= DISCONNECT_FAILURE_THRESHOLD) {
      return { kind: 'disconnected' };
    }
    if (this.activeSessionCount === 0) {
      return { kind: 'noSessions' };
    }
    return { kind: 'sessionsActive' };
  }

  private recompute(): void {
    const next = this.resolve();
    if (this.last && this.last.kind === next.kind) { return; }
    this.last = next;
    this.feedProvider.pushFeedState(next);
  }
}
