import { describe, it, expect } from 'vitest';
import { buildCreateWorkItemOptions } from './workItemCommands.js';

/**
 * #3388 — the "Cloud Runner" entry on the Work Items "+" picker is a
 * capability-exposure gate: it must appear ONLY when the org has the Cloud
 * Runners feature flag. The interactive QuickPick isn't unit-tested (repo
 * convention), so the pure option-list builder carries the regression guard.
 */
describe('buildCreateWorkItemOptions (#3388)', () => {
  it('omits the Cloud Runner option when the flag is off', () => {
    const opts = buildCreateWorkItemOptions(false);
    expect(opts.map(o => o.value)).toEqual(['issue', 'todo', 'feature']);
    expect(opts.some(o => o.value === 'cloudRunner')).toBe(false);
  });

  it('appends the Cloud Runner option when the flag is on', () => {
    const opts = buildCreateWorkItemOptions(true);
    expect(opts.some(o => o.value === 'cloudRunner')).toBe(true);
    // The base work-item types stay first, unchanged.
    expect(opts.slice(0, 3).map(o => o.value)).toEqual(['issue', 'todo', 'feature']);
  });
});
