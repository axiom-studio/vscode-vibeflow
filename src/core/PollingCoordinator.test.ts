import { describe, it, expect } from 'vitest';
import { PollingCoordinator, type PollScheduler, type FocusSource } from './PollingCoordinator.js';

/**
 * In-memory scheduler the test advances by hand — a real adapter, not a mock.
 * `timers()` reports how many distinct base timers are live, which is how we
 * assert "N subscribers share one timer".
 */
function manualScheduler() {
  const cbs = new Set<() => void>();
  const scheduler: PollScheduler = {
    every(_ms, cb) {
      cbs.add(cb);
      return () => cbs.delete(cb);
    },
  };
  return {
    scheduler,
    tick: () => [...cbs].forEach((c) => c()),
    timers: () => cbs.size,
  };
}

/** Togglable focus source — `set` flips focus and notifies listeners. */
function manualFocus(initial = true) {
  let focused = initial;
  const listeners = new Set<(f: boolean) => void>();
  const source: FocusSource = {
    isFocused: () => focused,
    onChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  return {
    source,
    set: (f: boolean) => {
      focused = f;
      [...listeners].forEach((l) => l(f));
    },
  };
}

describe('PollingCoordinator', () => {
  it('fires a subscriber once its interval elapses, not before', () => {
    const sched = manualScheduler();
    const coord = new PollingCoordinator(sched.scheduler, undefined, 1000);
    let fired = 0;
    coord.subscribe(3000, () => { fired++; });

    sched.tick(); // 1000ms
    sched.tick(); // 2000ms
    expect(fired).toBe(0);
    sched.tick(); // 3000ms
    expect(fired).toBe(1);
    sched.tick(); sched.tick(); sched.tick(); // 6000ms
    expect(fired).toBe(2);
  });

  it('drives many subscribers from a single base timer', () => {
    const sched = manualScheduler();
    const coord = new PollingCoordinator(sched.scheduler, undefined, 1000);
    coord.subscribe(2000, () => {});
    coord.subscribe(5000, () => {});
    coord.subscribe(30000, () => {});
    expect(sched.timers()).toBe(1);
  });

  it('pauses ticks while the window is unfocused', () => {
    const sched = manualScheduler();
    const focus = manualFocus(true);
    const coord = new PollingCoordinator(sched.scheduler, focus.source, 1000);
    let fired = 0;
    coord.subscribe(1000, () => { fired++; });

    focus.set(false);
    sched.tick(); sched.tick(); sched.tick();
    expect(fired).toBe(0); // nothing fires in the background
  });

  it('refreshes every subscriber once when focus is regained', () => {
    const sched = manualScheduler();
    const focus = manualFocus(true);
    const coord = new PollingCoordinator(sched.scheduler, focus.source, 1000);
    let a = 0, b = 0;
    coord.subscribe(30000, () => { a++; });
    coord.subscribe(30000, () => { b++; });

    focus.set(false);
    focus.set(true); // regain
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it('stops the timer when the last subscriber unsubscribes', () => {
    const sched = manualScheduler();
    const coord = new PollingCoordinator(sched.scheduler, undefined, 1000);
    const s1 = coord.subscribe(1000, () => {});
    const s2 = coord.subscribe(1000, () => {});
    expect(sched.timers()).toBe(1);
    s1.dispose();
    expect(sched.timers()).toBe(1); // still one subscriber
    s2.dispose();
    expect(sched.timers()).toBe(0); // last one gone → timer cleared
  });

  it('dispose() stops the timer and all subsequent ticks are inert', () => {
    const sched = manualScheduler();
    const coord = new PollingCoordinator(sched.scheduler, undefined, 1000);
    let fired = 0;
    coord.subscribe(1000, () => { fired++; });
    coord.dispose();
    expect(sched.timers()).toBe(0);
    sched.tick(); // timer is detached; even if invoked, no subscribers remain
    expect(fired).toBe(0);
  });

  it('one subscriber throwing does not stop the others or the timer', () => {
    const sched = manualScheduler();
    const coord = new PollingCoordinator(sched.scheduler, undefined, 1000);
    let good = 0;
    coord.subscribe(1000, () => { throw new Error('boom'); });
    coord.subscribe(1000, () => { good++; });
    sched.tick();
    expect(good).toBe(1);
  });

  it('clamps a sub-base interval up to the base granularity', () => {
    const sched = manualScheduler();
    const coord = new PollingCoordinator(sched.scheduler, undefined, 1000);
    let fired = 0;
    coord.subscribe(200, () => { fired++; }); // below base → fires every base tick
    sched.tick();
    expect(fired).toBe(1);
  });
});
