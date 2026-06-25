import { describe, it, expect } from 'vitest';
import {
  MENTION_KINDS,
  parseMentionState,
  formatMentionToken,
  applyMention,
  shouldFetch,
  type MentionState,
} from './mentionParser.js';

describe('MENTION_KINDS', () => {
  it('contains the six documented kinds in stable order', () => {
    expect(MENTION_KINDS).toEqual(['document', 'context', 'todo', 'issue', 'feature', 'reference', 'symbol']);
  });
});

describe('parseMentionState — activation rules', () => {
  it('returns inactive for empty input', () => {
    const s = parseMentionState('', 0);
    expect(s.active).toBe(false);
  });

  it('returns inactive when cursor is out of range', () => {
    expect(parseMentionState('hello', -1).active).toBe(false);
    expect(parseMentionState('hello', 99).active).toBe(false);
  });

  it('returns inactive when no @ precedes the cursor', () => {
    const s = parseMentionState('hello world', 11);
    expect(s.active).toBe(false);
  });

  it('activates at the start of the input', () => {
    const s = parseMentionState('@', 1);
    expect(s.active).toBe(true);
    expect(s.tokenStart).toBe(0);
    expect(s.rawToken).toBe('');
    expect(s.kind).toBeUndefined();
    expect(s.query).toBe('');
  });

  it('activates when @ follows a space', () => {
    const s = parseMentionState('hi @doc', 7);
    expect(s.active).toBe(true);
    expect(s.tokenStart).toBe(3);
    expect(s.rawToken).toBe('doc');
    expect(s.query).toBe('doc');
  });

  it('activates when @ follows a newline', () => {
    const s = parseMentionState('line\n@x', 7);
    expect(s.active).toBe(true);
  });

  it('does NOT activate when @ is mid-word (no preceding whitespace)', () => {
    const s = parseMentionState('user@host', 9);
    expect(s.active).toBe(false);
  });

  it('does NOT activate when cursor is past a terminator', () => {
    const s = parseMentionState('@doc and stuff', 14);
    expect(s.active).toBe(false);
  });

  it('terminates on closing bracket', () => {
    expect(parseMentionState('@doc]', 5).active).toBe(false);
  });

  it('terminates on closing paren', () => {
    expect(parseMentionState('@doc)', 5).active).toBe(false);
  });

  it('terminates on tab', () => {
    expect(parseMentionState('@doc\t', 5).active).toBe(false);
  });
});

describe('parseMentionState — kind resolution', () => {
  it('leaves kind undefined while typing the type prefix', () => {
    const s = parseMentionState('@to', 3);
    expect(s.active).toBe(true);
    expect(s.kind).toBeUndefined();
    expect(s.query).toBe('to'); // picker filters type list against this
  });

  it('resolves kind after the colon', () => {
    const s = parseMentionState('@todo:', 6);
    expect(s.kind).toBe('todo');
    expect(s.query).toBe('');
  });

  it('resolves kind + query', () => {
    const s = parseMentionState('@issue:1234', 11);
    expect(s.kind).toBe('issue');
    expect(s.query).toBe('1234');
  });

  it('handles a colon for every documented kind', () => {
    for (const k of MENTION_KINDS) {
      const s = parseMentionState(`@${k}:`, k.length + 2);
      expect(s.kind).toBe(k);
    }
  });

  it('falls back to undefined kind when the type fragment is unknown', () => {
    const s = parseMentionState('@bogus:foo', 10);
    expect(s.kind).toBeUndefined();
    expect(s.query).toBe('bogus:foo'); // full rawToken stays in query
  });

  it('treats cursor mid-token (between kind and colon) as still-typing the type', () => {
    const s = parseMentionState('@tod', 4);
    expect(s.kind).toBeUndefined();
  });
});

describe('formatMentionToken', () => {
  it('formats the canonical [kind:id "name"] shape', () => {
    expect(formatMentionToken('todo', 123, 'Fix the thing')).toBe('[todo:123 "Fix the thing"]');
  });

  it('accepts a string id (symbols use file#line)', () => {
    expect(formatMentionToken('symbol', 'src/foo.ts#42', 'handleClick')).toBe('[symbol:src/foo.ts#42 "handleClick"]');
  });

  it('formats a Confluence reference token', () => {
    expect(formatMentionToken('reference', 42, 'Onboarding Guide')).toBe('[reference:42 "Onboarding Guide"]');
  });

  it('escapes embedded double quotes in the name', () => {
    expect(formatMentionToken('document', 5, 'He said "hi"')).toBe('[document:5 "He said \\"hi\\""]');
  });

  it('leaves single quotes and other punctuation alone', () => {
    expect(formatMentionToken('feature', 7, `Bob's plan, etc.`)).toBe(`[feature:7 "Bob's plan, etc."]`);
  });
});

describe('applyMention', () => {
  const token = '[todo:42 "fix"]';

  function active(value: string, tokenStart: number, rawToken: string): MentionState {
    return { active: true, tokenStart, rawToken, query: rawToken };
  }

  it('returns input unchanged when state is inactive', () => {
    const r = applyMention('plain text', { active: false, tokenStart: -1, rawToken: '', query: '' }, token);
    expect(r.next).toBe('plain text');
    expect(r.caret).toBe(10);
  });

  it('replaces a bare @ at start with the token + trailing space', () => {
    const r = applyMention('@', active('@', 0, ''), token);
    expect(r.next).toBe(`${token} `);
    expect(r.caret).toBe(token.length + 1);
  });

  it('replaces a partially-typed @kind with the token + trailing space', () => {
    const r = applyMention('hi @to', active('hi @to', 3, 'to'), token);
    expect(r.next).toBe(`hi ${token} `);
    expect(r.caret).toBe(`hi ${token} `.length);
  });

  it('preserves text after the @-token range', () => {
    const r = applyMention('@todo after', active('@todo after', 0, 'todo'), token);
    expect(r.next).toBe(`${token} after`);
  });

  it('does NOT add a trailing space when the next char is already whitespace', () => {
    const r = applyMention('@ x', active('@ x', 0, ''), token);
    // The @ token ends at the space (index 1), space already there.
    expect(r.next).toBe(`${token} x`);
  });

  it('handles cursor pointing into a mid-stream mention (forward-walk to terminator)', () => {
    // User typed "@todo:42 something", cursor is at the 't' in 'something'.
    // applyMention with tokenStart=0 should consume up through ':42'.
    const value = '@todo:42 something';
    const state = active(value, 0, 'todo:42');
    const r = applyMention(value, state, token);
    expect(r.next).toBe(`${token} something`);
  });
});

describe('shouldFetch', () => {
  it('returns false when the query was just opened (empty → non-empty)', () => {
    // Picker already has the unfiltered list from its first fetch — no need
    // to refetch on first keystroke.
    expect(shouldFetch('', 'a')).toBe(false);
  });

  it('returns true when the query changes between non-empty values', () => {
    expect(shouldFetch('foo', 'foob')).toBe(true);
    expect(shouldFetch('abc', 'xyz')).toBe(true);
  });

  it('returns false when the query is unchanged', () => {
    expect(shouldFetch('foo', 'foo')).toBe(false);
    expect(shouldFetch('', '')).toBe(false);
  });
});
