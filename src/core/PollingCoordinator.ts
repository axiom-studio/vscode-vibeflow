import * as vscode from 'vscode';

/**
 * Minimal disposable shape — matches `vscode.Disposable` structurally without
 * importing it into the coordinator's core, so the scheduling logic stays
 * vscode-free and unit-testable.
 */
export interface Disposer {
  dispose(): void;
}

/**
 * Drives recurring ticks. Production is backed by `setInterval`
 * (`intervalScheduler`); tests inject an in-memory scheduler they advance by
 * hand — no fake timers.
 */
export interface PollScheduler {
  /** Invoke `cb` every `ms`. Returns a function that stops it. */
  every(ms: number, cb: () => void): () => void;
}

/**
 * Reports whether the editor window has focus. Production is backed by
 * `vscode.window` (`vscodeFocusSource`); tests inject a togglable stub.
 */
export interface FocusSource {
  isFocused(): boolean;
  /** Subscribe to focus changes. Returns a function that unsubscribes. */
  onChange(cb: (focused: boolean) => void): () => void;
}

/** Production scheduler backed by `setInterval`. */
export const intervalScheduler: PollScheduler = {
  every(ms, cb) {
    const t = setInterval(cb, ms);
    return () => clearInterval(t);
  },
};

interface Subscription {
  intervalMs: number;
  onTick: () => void;
  elapsedMs: number;
  label: string;
}

/**
 * One timer drives every poller. Subscribers register a recurring tick; the
 * coordinator accumulates elapsed time against a single base interval and fires
 * each subscriber when its interval is due — collapsing N `setInterval`s into
 * one as consumers migrate onto it. Ticks pause while the window is unfocused
 * (no background polling), and every subscriber fires once on refocus so stale
 * views refresh immediately.
 *
 * The core is vscode-free: scheduling and focus arrive through injected
 * adapters, so a test drives it with an in-memory scheduler and a togglable
 * focus source — no mocks, no fake timers.
 */
export class PollingCoordinator implements Disposer {
  private readonly subs = new Set<Subscription>();
  private stopTimer: (() => void) | undefined;
  private stopFocus: (() => void) | undefined;
  private focused: boolean;

  constructor(
    private readonly scheduler: PollScheduler = intervalScheduler,
    focus?: FocusSource,
    /** Base granularity; subscriber intervals are rounded up to a multiple. */
    private readonly baseMs: number = 1000,
    /** Optional sink for debug observability — fire/pause/resume lines. */
    private readonly log?: (msg: string) => void,
  ) {
    this.focused = focus ? focus.isFocused() : true;
    this.stopFocus = focus?.onChange((f) => this.onFocusChange(f));
  }

  /**
   * Register `onTick` to run every `intervalMs` (clamped to at least the base
   * interval). Returns a Disposer that unsubscribes; the timer stops when the
   * last subscriber leaves.
   */
  subscribe(intervalMs: number, onTick: () => void, label?: string): Disposer {
    const sub: Subscription = {
      intervalMs: Math.max(this.baseMs, intervalMs),
      onTick,
      elapsedMs: 0,
      label: label ?? `${intervalMs}ms`,
    };
    this.subs.add(sub);
    this.ensureTimer();
    return {
      dispose: () => {
        this.subs.delete(sub);
        if (this.subs.size === 0) { this.clearTimer(); }
      },
    };
  }

  private ensureTimer(): void {
    if (this.stopTimer || this.subs.size === 0) { return; }
    this.stopTimer = this.scheduler.every(this.baseMs, () => this.tick());
  }

  private clearTimer(): void {
    this.stopTimer?.();
    this.stopTimer = undefined;
  }

  private tick(): void {
    if (!this.focused) { return; } // paused while the window is in the background
    // Snapshot so a subscriber disposing mid-tick can't mutate the live set.
    for (const sub of [...this.subs]) {
      if (!this.subs.has(sub)) { continue; }
      sub.elapsedMs += this.baseMs;
      if (sub.elapsedMs >= sub.intervalMs) {
        sub.elapsedMs = 0;
        this.run(sub);
      }
    }
  }

  private onFocusChange(focused: boolean): void {
    const regainedFocus = focused && !this.focused;
    const lostFocus = !focused && this.focused;
    this.focused = focused;
    if (lostFocus) { this.log?.('paused (window blurred)'); return; }
    if (!regainedFocus) { return; }
    this.log?.(`resumed — refreshing ${this.subs.size}`);
    // Refocus → refresh every view once; data may be stale after a pause.
    for (const sub of [...this.subs]) {
      if (!this.subs.has(sub)) { continue; }
      sub.elapsedMs = 0;
      this.run(sub);
    }
  }

  private run(sub: Subscription): void {
    this.log?.(`fire · ${sub.label}`);
    // A poller owns its own error handling (partial-failure resilience); a
    // throw here must not kill the shared timer or the other subscribers.
    try {
      sub.onTick();
    } catch {
      /* swallowed — the subscriber's onTick is responsible for its errors */
    }
  }

  dispose(): void {
    this.clearTimer();
    this.stopFocus?.();
    this.stopFocus = undefined;
    this.subs.clear();
  }
}

/**
 * Production `FocusSource` backed by the editor window's focus state. Kept out
 * of the core class so the coordinator's logic carries no vscode dependency.
 */
export function vscodeFocusSource(): FocusSource {
  return {
    isFocused: () => vscode.window.state.focused,
    onChange: (cb) => {
      const d = vscode.window.onDidChangeWindowState((s) => cb(s.focused));
      return () => d.dispose();
    },
  };
}
