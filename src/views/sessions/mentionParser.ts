/**
 * Pure-function helpers for the @mention autocomplete picker.
 *
 * Canonical location for BOTH host and webview. The webview's
 * `mentionParser.ts` shim re-exports from here so changes land
 * in one place. Webview-ui/tsconfig.json `include` adds this
 * path so the webview Vite/tsc graph picks it up.
 *
 * Wire-shape parity with axiomcloud: sent prompts embed mentions
 * as `[<type>:<id> "<name>"]`. axiomcloud's existing
 * `parseAttachmentRefs` (`VibeFlowSessions.jsx:1775`) already
 * resolves this — no server-side change needed.
 */

/**
 * The supported mention kinds. `reference` is a Confluence reference —
 * a read-only pointer to an external Atlassian page, server-backed via
 * the references API; the agent resolves it with `get_reference_content`.
 * `symbol` is IDE-only: it resolves via VS Code's workspace-symbol
 * provider (LSP-backed) and is not understood by axiomcloud's parser.
 * The token still embeds with a stable `[symbol:<file>#<line> "<name>"]`
 * shape so a server roundtrip is not lossy — the agent can decode the
 * location even if axiomcloud cannot.
 */
export const MENTION_KINDS = ['document', 'context', 'todo', 'issue', 'feature', 'reference', 'symbol'] as const;
export type MentionKind = typeof MENTION_KINDS[number];

/**
 * The result of parsing the textarea's current state at the
 * cursor. `active === true` means we're inside an @-prefixed
 * token and should show the picker. `tokenStart` is the
 * character index of the leading `@` — used to replace the
 * token range when the user selects a suggestion.
 *
 * `kind` is set once the user has typed `@<kind>` (or a unique
 * prefix); before that, `kind === undefined` and the picker
 * renders the type list.
 */
export interface MentionState {
  active: boolean;
  tokenStart: number;
  /** Everything between `@` and cursor, NOT including the `@` itself. */
  rawToken: string;
  /** Resolved mention kind (e.g. `todo`), or undefined while the user is still typing the type. */
  kind?: MentionKind;
  /** The search query AFTER the resolved kind. Empty when only the kind has been typed. */
  query: string;
}

/**
 * Parse the textarea content around the cursor and decide
 * whether the picker should be open.
 *
 * Activation rules (modeled on axiomcloud's behavior):
 *  - The `@` must be either at index 0 or preceded by whitespace.
 *  - The token may not contain whitespace, `)`, `]`, or another
 *    `@` — those terminate the mention.
 *  - If the cursor is past a terminator, the picker stays closed.
 *
 * Kind resolution:
 *  - Look for a `:` separator inside the rawToken. Everything
 *    before is the kind candidate (must match `MENTION_KINDS`),
 *    everything after is the query.
 *  - If no `:` is present yet, we're still typing the kind —
 *    `kind` stays undefined and `query` holds the prefix typed
 *    so far (so the picker can filter the type list).
 */
export function parseMentionState(value: string, cursor: number): MentionState {
  if (cursor < 0 || cursor > value.length) {
    return { active: false, tokenStart: -1, rawToken: '', query: '' };
  }

  // Walk backward from the cursor until we find `@`, whitespace,
  // or the start of the string.
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
    return {
      active: true,
      tokenStart: i,
      rawToken,
      query: rawToken,
    };
  }
  const candidate = rawToken.slice(0, colon);
  const after = rawToken.slice(colon + 1);
  const isKnown = (MENTION_KINDS as readonly string[]).includes(candidate);
  if (!isKnown) {
    // The user typed `@something:` where `something` isn't a
    // known kind. Treat the whole thing as still selecting a
    // kind (rare; happens if they're typing fast).
    return { active: true, tokenStart: i, rawToken, query: rawToken };
  }
  return {
    active: true,
    tokenStart: i,
    rawToken,
    kind: candidate as MentionKind,
    query: after,
  };
}

/**
 * Build the wire-shape token for a resolved mention. axiomcloud's
 * `parseAttachmentRefs` expects exactly this format. We escape
 * embedded `"` in the name so a name containing quotes doesn't
 * truncate the token early.
 *
 * For workspace symbols, id is `<relativePath>#<line>` (1-indexed
 * line). axiomcloud will silently leave the token as-is — that
 * is fine; the agent can still resolve the location locally.
 */
export function formatMentionToken(kind: MentionKind, id: string | number, name: string): string {
  const escapedName = name.replace(/"/g, '\\"');
  return `[${kind}:${id} "${escapedName}"]`;
}

/**
 * Splice a mention token into the input string, replacing the
 * `@...` range. Returns `{ next, caret }` where `caret` is the
 * new cursor position (just after the inserted token + trailing
 * space, so the next keystroke continues a new word).
 */
export function applyMention(value: string, state: MentionState, token: string): { next: string; caret: number } {
  if (!state.active) { return { next: value, caret: value.length }; }
  const before = value.slice(0, state.tokenStart);
  // Walk forward from `tokenStart + 1` to find the end of the
  // @-token so we don't swallow content the user has typed past
  // the cursor.
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

/**
 * Decide whether the search query is "short enough to inline-filter"
 * vs. "should trigger a server fetch". Today every vibeflow type
 * is paginated client-side after a single list call, so this is
 * mostly a placeholder — the picker fetches once and filters.
 * Kept as a function so the picker can adopt it without rewriting
 * its loop when we eventually add a `searchEntities` endpoint.
 */
export function shouldFetch(prev: string, next: string): boolean {
  // Refetch when the kind changes OR when crossing the 0→1 query
  // boundary (so the picker shows full list before any typing).
  return prev === '' && next !== '' ? false : prev !== next;
}
