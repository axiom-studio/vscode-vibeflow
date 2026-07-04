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

/** Minimal WorkItemsTreeProvider — the nav only reads counts + a refresh event. */
function fakeWorkItems(): WorkItemsTreeProvider {
  return {
    onDidRefresh: (_cb: () => void) => ({ dispose() { /* no-op */ } }),
    getTodos: () => [],
    getIssues: () => [],
    getFeatures: () => [],
  } as unknown as WorkItemsTreeProvider;
}

function rowIds(nav: TicketsNavTreeProvider): string[] {
  return nav.getChildren().map(n => n.id);
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
