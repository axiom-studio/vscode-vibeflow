import { describe, it, expect } from 'vitest';
import { parseLogString } from './client.js';

// Log entries are `*[<timestamp> | <source>]*\n<content>` blocks concatenated
// into one TEXT column. The activity feed fetches only the appended suffix each
// poll, so the parser must handle both a full log and a boundary-aligned delta.
const A = '*[2026-06-29T05:00:00Z | session-abc]*\n⚡ Started building';
const B = '\n*[2026-06-29T05:00:05Z | session-abc]*\n✅ Tests passed';

describe('parseLogString', () => {
  it('parses a full concatenated log (timestamp, source, emoji → message_type)', () => {
    const entries = parseLogString(A + B);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      created_at: '2026-06-29T05:00:00Z',
      source: 'session-abc',
      message_type: 'action', // ⚡
    });
    expect(entries[0].content).toContain('Started building');
    expect(entries[1]).toMatchObject({
      created_at: '2026-06-29T05:00:05Z',
      message_type: 'test_result', // ✅
    });
  });

  it('parses a delta chunk (suffix starting at an entry boundary) into just the new entries', () => {
    // B is logs[since:] — the feed's steady-state case after seeing A.
    const entries = parseLogString(B);
    expect(entries).toHaveLength(1);
    expect(entries[0].created_at).toBe('2026-06-29T05:00:05Z');
    expect(entries[0].content).toContain('Tests passed');
  });

  it('returns [] for empty / whitespace (no new content this poll)', () => {
    expect(parseLogString('')).toEqual([]);
    expect(parseLogString('   \n ')).toEqual([]);
  });

  it('handles the bare-timestamp form (no source)', () => {
    const entries = parseLogString('*[2026-06-29T05:00:00Z]*\n📋 Done');
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBeUndefined();
    expect(entries[0].message_type).toBe('summary'); // 📋
  });
});
