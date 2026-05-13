// Pure-function helpers for the @mention autocomplete picker
// (todo #1614 — Chat-First Mode #5).
//
// Webview-side port of `src/views/sessions/mentionParser.ts`. Same
// dual-life discipline as the existing host file: behavior must stay
// in lockstep with the spec on the host side. The host's parser is the
// reference; this file mirrors it so the React webview doesn't need
// to reach into `src/` (which would require widening
// `webview-ui/tsconfig.json` `include` paths beyond `webviewMessages.ts`
// + `types.ts`).
//
// Wire-shape parity with axiomcloud: sent prompts embed mentions as
// `[<type>:<id> "<name>"]` — see `parseAttachmentRefs` in axiomcloud's
// `VibeFlowSessions.jsx:1775`.

export const MENTION_KINDS = ['document', 'context', 'todo', 'issue', 'feature', 'symbol'] as const;
export type MentionKind = typeof MENTION_KINDS[number];

export interface MentionState {
  active: boolean;
  tokenStart: number;
  /** Everything between `@` and cursor, NOT including the `@` itself. */
  rawToken: string;
  /** Resolved mention kind, or undefined while the user is still typing the type. */
  kind?: MentionKind;
  /** Search query AFTER the resolved kind. Empty when only the kind has been typed. */
  query: string;
}

export function parseMentionState(value: string, cursor: number): MentionState {
  if (cursor < 0 || cursor > value.length) {
    return { active: false, tokenStart: -1, rawToken: '', query: '' };
  }

  // Walk backward from cursor until `@`, whitespace, or string start.
  let i = cursor - 1;
  while (i >= 0) {
    const ch = value[i];
    if (ch === '@') { break; }
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === ')' || ch === ']') {
      return { active: false, tokenStart: -1, rawToken: '', query: '' };
    }
    i--;
  }
  if (i < 0 || value[i] !== '@') {
    return { active: false, tokenStart: -1, rawToken: '', query: '' };
  }
  // The `@` must be at index 0 or preceded by whitespace.
  if (i > 0) {
    const prev = value[i - 1];
    if (prev !== ' ' && prev !== '\n' && prev !== '\t') {
      return { active: false, tokenStart: -1, rawToken: '', query: '' };
    }
  }

  const rawToken = value.slice(i + 1, cursor);
  const colon = rawToken.indexOf(':');
  if (colon === -1) {
    return { active: true, tokenStart: i, rawToken, query: rawToken };
  }
  const candidate = rawToken.slice(0, colon);
  const after = rawToken.slice(colon + 1);
  const isKnown = (MENTION_KINDS as readonly string[]).includes(candidate);
  if (!isKnown) {
    return { active: true, tokenStart: i, rawToken, query: rawToken };
  }
  return { active: true, tokenStart: i, rawToken, kind: candidate as MentionKind, query: after };
}

export function formatMentionToken(kind: MentionKind, id: string | number, name: string): string {
  const escapedName = name.replace(/"/g, '\\"');
  return `[${kind}:${id} "${escapedName}"]`;
}

/**
 * Splice a mention token into the input string, replacing the `@...`
 * range. Returns `{ next, caret }` where `caret` is the new cursor
 * position (just after the inserted token + a trailing space if needed
 * so the next keystroke continues a new word).
 */
export function applyMention(
  value: string,
  state: MentionState,
  token: string,
): { next: string; caret: number } {
  if (!state.active) { return { next: value, caret: value.length }; }
  const before = value.slice(0, state.tokenStart);
  // Walk forward from the `@` until whitespace/terminator/end so we
  // don't swallow what's after the cursor if the user has typed past
  // the active token.
  let end = state.tokenStart + 1;
  while (end < value.length) {
    const ch = value[end];
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === ')' || ch === ']') { break; }
    end++;
  }
  const after = value.slice(end);
  const next = before + token + (after.startsWith(' ') ? '' : ' ') + after;
  const caret = before.length + token.length + (after.startsWith(' ') ? 0 : 1);
  return { next, caret };
}
