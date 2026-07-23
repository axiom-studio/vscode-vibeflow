import { describe, expect, it } from 'vitest';
import { activeFirst } from './cloudRunnerCommands.js';

describe('activeFirst (#2894 Start over prefill)', () => {
  const items = [
    { label: 'Claude', value: 'claude' },
    { label: 'Codex', value: 'codex' },
    { label: 'Cursor', value: 'cursor' },
  ];

  it('moves the previously-chosen item to the front so it lands highlighted', () => {
    expect(activeFirst(items, i => i.value === 'cursor')).toEqual([
      { label: 'Cursor', value: 'cursor' },
      { label: 'Claude', value: 'claude' },
      { label: 'Codex', value: 'codex' },
    ]);
  });

  it('preserves relative order of the non-active items', () => {
    expect(activeFirst(items, i => i.value === 'codex').map(i => i.value)).toEqual([
      'codex', 'claude', 'cursor',
    ]);
  });

  it('is a no-op when the active item is already first', () => {
    const result = activeFirst(items, i => i.value === 'claude');
    expect(result).toBe(items); // same reference — nothing to reorder
  });

  it('is a no-op when no item matches (first pass, defaults undefined)', () => {
    const result = activeFirst(items, i => i.value === 'nope');
    expect(result).toBe(items);
  });
});
