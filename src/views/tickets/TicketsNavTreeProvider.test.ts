import { describe, it, expect } from 'vitest';
import { TicketsNavTreeProvider } from './TicketsNavTreeProvider.js';
import type { WorkItemsTreeProvider } from '../workItems/WorkItemsTreeProvider.js';

/**
 * #2808 / #3389-adjacent — the Browse-nav "Cloud Runners" row is a
 * capability-exposure gate: it must appear ONLY when the org has the Cloud
 * Runners feature flag. This test pins that fail-closed behavior so a future
 * refactor of `getChildren` / `setCloudRunnersEnabled` can't silently expose
 * the row to non-entitled orgs.
 */

const CLOUD_RUNNERS_ROW = 'tickets-nav-cloud-runners';
const GIT_PROVIDERS_ROW = 'tickets-nav-git-providers';

/** Minimal WorkItemsTreeProvider — the nav only reads counts + a refresh event. */
function fakeWorkItems(): WorkItemsTreeProvider {
  return {
    onDidRefresh: (_cb: () => void) => ({ dispose() { /* no-op */ } }),
    getTodos: () => [],
    getIssues: () => [],
    getFeatures: () => [],
  } as unknown as WorkItemsTreeProvider;
}

/**
 * Same, but exposes the refresh callback so a test can drive the background
 * tick the nav rides for its runner count.
 */
function fakeWorkItemsWithTick(): { provider: WorkItemsTreeProvider; tick: () => void } {
  let cb: (() => void) | undefined;
  const provider = {
    onDidRefresh: (fn: () => void) => { cb = fn; return { dispose() { /* no-op */ } }; },
    getTodos: () => [],
    getIssues: () => [],
    getFeatures: () => [],
  } as unknown as WorkItemsTreeProvider;
  return { provider, tick: () => cb?.() };
}

/** Client stub exposing only what the nav calls, plus a call counter. */
function fakeClient(listProjectCloudRunners: () => Promise<unknown[]>) {
  const calls = { count: 0 };
  const client = {
    listProjectCloudRunners: () => { calls.count++; return listProjectCloudRunners(); },
  } as unknown as Parameters<TicketsNavTreeProvider['connect']>[0];
  return { client, calls };
}

function rowIds(nav: TicketsNavTreeProvider): string[] {
  return nav.getChildren().map(n => n.id);
}

function cloudRunnersRow(nav: TicketsNavTreeProvider) {
  return nav.getChildren().find(n => n.id === CLOUD_RUNNERS_ROW);
}

/** Let the nav's fire-and-forget count refresh settle. */
function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

describe('TicketsNavTreeProvider — Cloud Runners row flag gate', () => {
  it('hides the Cloud Runners row by default (flag unknown / disabled)', () => {
    const nav = new TicketsNavTreeProvider(fakeWorkItems());
    expect(rowIds(nav)).not.toContain(CLOUD_RUNNERS_ROW);
    // The regular Browse sections are always present.
    expect(rowIds(nav)).toContain('tickets-nav-todos');
  });

  it('shows the row when enabled and hides it again when disabled', () => {
    const nav = new TicketsNavTreeProvider(fakeWorkItems());

    nav.setCloudRunnersEnabled(true);
    expect(rowIds(nav)).toContain(CLOUD_RUNNERS_ROW);

    nav.setCloudRunnersEnabled(false);
    expect(rowIds(nav)).not.toContain(CLOUD_RUNNERS_ROW);
  });

  it('shows Git Providers directly after Cloud Runners under the same flag (#2822)', () => {
    const nav = new TicketsNavTreeProvider(fakeWorkItems());
    expect(rowIds(nav)).not.toContain(GIT_PROVIDERS_ROW); // hidden by default

    nav.setCloudRunnersEnabled(true);
    const ids = rowIds(nav);
    expect(ids).toContain(GIT_PROVIDERS_ROW);
    expect(ids.indexOf(GIT_PROVIDERS_ROW)).toBe(ids.indexOf(CLOUD_RUNNERS_ROW) + 1);

    nav.setCloudRunnersEnabled(false);
    expect(rowIds(nav)).not.toContain(GIT_PROVIDERS_ROW);
  });

  it('fires onDidChangeTreeData only when the flag actually changes', () => {
    const nav = new TicketsNavTreeProvider(fakeWorkItems());
    let fired = 0;
    nav.onDidChangeTreeData(() => { fired++; });

    nav.setCloudRunnersEnabled(true);
    expect(fired).toBe(1);

    nav.setCloudRunnersEnabled(true); // no-op — same value
    expect(fired).toBe(1);

    nav.setCloudRunnersEnabled(false);
    expect(fired).toBe(2);
  });
});

/**
 * The Cloud Runners row shipped without the live count every other Browse row
 * carries. These pin the count's contract: it appears only once a fetch lands,
 * it never fires a spurious re-render, and a background failure can neither
 * blank the row nor escape into the tree.
 */
describe('TicketsNavTreeProvider — Cloud Runners count', () => {
  it('renders no description until the first fetch lands, then the runner count', async () => {
    const nav = new TicketsNavTreeProvider(fakeWorkItems());
    const { client } = fakeClient(async () => [{ id: 1 }, { id: 2 }, { id: 3 }]);

    nav.connect(client, 7);
    nav.setCloudRunnersEnabled(true);
    // Before the fetch resolves the row must be bare — a "0" here would read as
    // "this project has no runners", which we don't know yet.
    expect(cloudRunnersRow(nav)?.description).toBeUndefined();

    await flush();
    expect(cloudRunnersRow(nav)?.description).toBe('3');
  });

  it('does not fetch while the org flag is off', async () => {
    const nav = new TicketsNavTreeProvider(fakeWorkItems());
    const { client, calls } = fakeClient(async () => [{ id: 1 }]);

    nav.connect(client, 7); // flag still false
    await flush();
    expect(calls.count).toBe(0);

    nav.setCloudRunnersEnabled(true);
    await flush();
    expect(calls.count).toBe(1);
  });

  it('updates the count on the work-items refresh tick', async () => {
    const { provider, tick } = fakeWorkItemsWithTick();
    const nav = new TicketsNavTreeProvider(provider);
    let runners: unknown[] = [{ id: 1 }];
    const { client } = fakeClient(async () => runners);

    nav.connect(client, 7);
    nav.setCloudRunnersEnabled(true);
    await flush();
    expect(cloudRunnersRow(nav)?.description).toBe('1');

    runners = [{ id: 1 }, { id: 2 }];
    tick();
    await flush();
    expect(cloudRunnersRow(nav)?.description).toBe('2');
  });

  it('re-renders only when the count actually changes', async () => {
    const { provider, tick } = fakeWorkItemsWithTick();
    const nav = new TicketsNavTreeProvider(provider);
    const { client } = fakeClient(async () => [{ id: 1 }]);
    nav.connect(client, 7);
    nav.setCloudRunnersEnabled(true);
    await flush();

    let fired = 0;
    nav.onDidChangeTreeData(() => { fired++; });
    tick(); // same count comes back
    await flush();
    // Exactly one fire — the tick's own re-render. The count refresh must not
    // add a second one when nothing changed.
    expect(fired).toBe(1);
  });

  it('keeps the last known count when a background fetch fails', async () => {
    const { provider, tick } = fakeWorkItemsWithTick();
    const nav = new TicketsNavTreeProvider(provider);
    let fail = false;
    const { client } = fakeClient(async () => {
      if (fail) { throw new Error('network down'); }
      return [{ id: 1 }, { id: 2 }];
    });

    nav.connect(client, 7);
    nav.setCloudRunnersEnabled(true);
    await flush();
    expect(cloudRunnersRow(nav)?.description).toBe('2');

    fail = true;
    tick();
    await flush();
    // Still 2 — a transient failure must not blank the row, and must not throw.
    expect(cloudRunnersRow(nav)?.description).toBe('2');
  });

  it('drops the previous project count on reconnect', async () => {
    const nav = new TicketsNavTreeProvider(fakeWorkItems());
    const first = fakeClient(async () => [{ id: 1 }, { id: 2 }]);
    nav.connect(first.client, 7);
    nav.setCloudRunnersEnabled(true);
    await flush();
    expect(cloudRunnersRow(nav)?.description).toBe('2');

    // Switching projects must not leave the old project's number on screen
    // while the new one loads.
    let resolveSecond: (v: unknown[]) => void = () => { /* set below */ };
    const second = fakeClient(() => new Promise<unknown[]>(res => { resolveSecond = res; }));
    nav.connect(second.client, 9);
    expect(cloudRunnersRow(nav)?.description).toBeUndefined();

    resolveSecond([{ id: 5 }]);
    await flush();
    expect(cloudRunnersRow(nav)?.description).toBe('1');
  });
});
