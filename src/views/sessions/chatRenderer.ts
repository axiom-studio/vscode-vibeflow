/**
 * Pure-function helpers for rendering chat messages in the Session
 * Panel (todo #1613 — Chat-First Mode #4, IDE superpowers).
 *
 * Lives in its own module so:
 *  1. It is independently testable — no `vscode` import, no DOM, no
 *     side effects.
 *  2. The webview's nonced `<script>` can inline a JS port of these
 *     same shapes (CSP forbids importing extension code into the
 *     webview at runtime) — keeping the host-side TS and the
 *     webview-side JS as parallel implementations of the same
 *     primitives.
 *  3. Host-side callers (the `askSelection` command in Commit C)
 *     reuse `composeSelectionPrompt` directly.
 *
 * **Security note**: the segment types this file produces are
 * structurally distinct from raw HTML. Renderers MUST html-escape
 * each segment's textual content before insertion into the DOM —
 * the segment shape only tells the renderer WHICH wrapper tag and
 * which `data-action` to attach. Untrusted strings never become
 * markup directly.
 */

/**
 * One tokenized piece of a chat message. The webview maps each kind
 * to a wrapper element (or to plain text) and html-escapes the
 * inner text before insertion.
 *
 * `inline` segments compose into a paragraph; `block` segments
 * (currently just `codeBlock`) take their own line.
 */
export type ChatSegment =
  | { kind: 'plain'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }
  | { kind: 'inlineCode'; text: string }
  | { kind: 'codeBlock'; text: string; language?: string }
  | { kind: 'link'; label: string; href: string }
  | { kind: 'path'; raw: string; path: string; line?: number; column?: number }
  | { kind: 'commitHash'; hash: string };

/**
 * Pre-compiled patterns. Defined module-level so we don't recompile
 * per token call. The `g` flag is used with `exec` in a loop, so the
 * `lastIndex` discipline matters — each tokenizer pass copies the
 * regex via `new RegExp(re.source, re.flags)` to avoid leaking state
 * between calls. (Tests will exercise back-to-back calls.)
 */
const RE_CODE_FENCE = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g;
const RE_INLINE_CODE = /`([^`\n]+)`/g;
const RE_BOLD = /\*\*([^*\n]+)\*\*/g;
const RE_ITALIC = /(?<![*\w])\*([^*\n]+)\*(?!\w)/g;
const RE_LINK = /\[([^\]\n]+)\]\(([^()\s]+)\)/g;
/**
 * Recognize `path/file.ext[:line[:col]]`. Constraints:
 *  - At least one `/` or `.` to avoid catching bare words.
 *  - Allows leading `./` and `../`.
 *  - Path char class deliberately conservative (no spaces, no quotes,
 *    no shell metas) — robustness over completeness.
 *  - Optional `:line` and `:col` (decimal, up to 6 digits).
 * Drive-letter Windows paths are NOT handled here (rare in agent
 * output; can be added if a user reports a miss).
 */
const RE_PATH = /(?<![A-Za-z0-9_/\\.-])(\.{0,2}\/?[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8})(?::(\d{1,6})(?::(\d{1,6}))?)?(?![A-Za-z0-9_/\\.-])/g;
/**
 * Recognize git commit hashes — 7 to 40 hex chars. Anti-false-positive
 * guards: not inside a longer word; not preceded by `#` (which would
 * look like a CSS color or issue id) and not preceded by `0x` (hex
 * literal in code). Length floor of 7 matches `git --abbrev=7`
 * minimum default; we accept up to 40 (full sha1).
 */
// Hyphens in lookbehind/lookahead so UUID fragments (e.g. prompt ids
// like `80998aa-42ec-4d21-b8c4-6989d27...`) don't have their 7-hex
// segments mis-recognized as commit hashes. Mirrors the parallel
// fix in `chatTokens.tsx:41` for the webview-side copy. Issue #2326.
// #3358 guards (kept in sync with chatTokens.tsx): a hex run 1-3
// separators after the word "prompt" is a prompt reference, and an
// all-digit run is an id/number — neither renders as a commit chip.
const RE_COMMIT = /(?<![#A-Za-z0-9-])(?<![Pp]rompt[\s:(-]{1,3})(?<!0x)\b(?!\d{7,40}\b)([a-f0-9]{7,40})\b(?![A-Za-z0-9-])/g;

/**
 * Tokenize a chat message body into structured segments.
 *
 * Order of resolution: code-fence blocks first (they swallow any
 * inline syntax inside); then for each non-fence chunk we resolve
 * inline patterns left-to-right with the longest-prefix match. Bold
 * is checked before italic so `**foo**` parses correctly (italic's
 * regex would otherwise grab the inner `*foo*`).
 *
 * Anything that doesn't match a pattern becomes a `plain` segment.
 * Adjacent `plain` segments are merged at the end so renderers
 * don't emit needless spans.
 */
export function tokenizeChatMessage(input: string): ChatSegment[] {
  if (!input) { return []; }

  // First pass: split on code-fence blocks (```lang ... ```).
  // Anything between fences is a single `codeBlock` segment that
  // does NOT get further inline tokenization.
  const out: ChatSegment[] = [];
  const fenceRe = new RegExp(RE_CODE_FENCE.source, RE_CODE_FENCE.flags);
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(input)) !== null) {
    if (match.index > lastIndex) {
      pushInlineSegments(input.slice(lastIndex, match.index), out);
    }
    out.push({ kind: 'codeBlock', text: match[2], language: match[1] || undefined });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < input.length) {
    pushInlineSegments(input.slice(lastIndex), out);
  }

  return mergeAdjacentPlain(out);
}

/**
 * Second pass for non-fence text: resolve inline patterns
 * left-to-right. We do this by collecting ALL matches across all
 * patterns into a single sorted list, then walking it greedily and
 * skipping any match that overlaps a chosen one. This handles
 * precedence cleanly (bold > italic; inline code > everything else
 * inside the backticks; paths and commit hashes are precedence-low
 * because they're recognized in plain prose).
 */
function pushInlineSegments(text: string, out: ChatSegment[]): void {
  if (!text) { return; }

  interface Hit { start: number; end: number; seg: ChatSegment; priority: number }
  const hits: Hit[] = [];
  // Higher priority wins on overlap (and on tie, earlier start).
  collectAll(text, RE_INLINE_CODE, hits, 5, m => ({ kind: 'inlineCode', text: m[1] }));
  collectAll(text, RE_LINK, hits, 4, m => ({ kind: 'link', label: m[1], href: m[2] }));
  collectAll(text, RE_BOLD, hits, 3, m => ({ kind: 'bold', text: m[1] }));
  collectAll(text, RE_ITALIC, hits, 2, m => ({ kind: 'italic', text: m[1] }));
  collectAll(text, RE_PATH, hits, 1, m => ({
    kind: 'path',
    raw: m[0],
    path: m[1],
    line: m[2] ? Number(m[2]) : undefined,
    column: m[3] ? Number(m[3]) : undefined,
  }));
  collectAll(text, RE_COMMIT, hits, 1, m => ({ kind: 'commitHash', hash: m[1] }));

  // Sort by start asc, then by priority desc (so a code-span match
  // at the same start beats a bold match).
  hits.sort((a, b) => a.start - b.start || b.priority - a.priority);

  let cursor = 0;
  for (const hit of hits) {
    if (hit.start < cursor) { continue; } // overlaps a previously-chosen hit
    if (hit.start > cursor) {
      out.push({ kind: 'plain', text: text.slice(cursor, hit.start) });
    }
    out.push(hit.seg);
    cursor = hit.end;
  }
  if (cursor < text.length) {
    out.push({ kind: 'plain', text: text.slice(cursor) });
  }
}

function collectAll(
  text: string,
  re: RegExp,
  hits: { start: number; end: number; seg: ChatSegment; priority: number }[],
  priority: number,
  build: (m: RegExpExecArray) => ChatSegment,
): void {
  const r = new RegExp(re.source, re.flags);
  let m: RegExpExecArray | null;
  while ((m = r.exec(text)) !== null) {
    if (m[0].length === 0) {
      // Defensive: zero-width match would infinite-loop.
      r.lastIndex++;
      continue;
    }
    hits.push({ start: m.index, end: m.index + m[0].length, seg: build(m), priority });
  }
}

function mergeAdjacentPlain(segs: ChatSegment[]): ChatSegment[] {
  const out: ChatSegment[] = [];
  for (const s of segs) {
    const prev = out[out.length - 1];
    if (s.kind === 'plain' && prev && prev.kind === 'plain') {
      prev.text += s.text;
    } else {
      out.push(s);
    }
  }
  return out;
}

/**
 * Compose a chat prompt from a code selection. Used by the
 * `vibeflow.chat.askSelection` command (Commit C) to seed the chat
 * textarea with a fenced code block + a header that tells the
 * agent which file and lines the selection came from.
 *
 * Line numbers are 1-indexed in the rendered header (matches VS
 * Code's "Go to Line" UX), and inclusive of both ends.
 *
 * The header is on its own line above the fence so the agent's
 * markdown parser sees a clean code block. We deliberately do not
 * include the workspace path — only the workspace-relative path —
 * so prompts copied to other tools (axiomcloud chat, agent logs)
 * don't leak the user's absolute path.
 */
export function composeSelectionPrompt(opts: {
  relativePath: string;
  startLine: number; // 0-indexed in the input; we add 1 for display
  endLine: number;   // 0-indexed, inclusive
  text: string;
  languageId?: string;
}): string {
  const lang = (opts.languageId ?? '').trim();
  const display = opts.startLine === opts.endLine
    ? `${opts.relativePath}:${opts.startLine + 1}`
    : `${opts.relativePath}:${opts.startLine + 1}-${opts.endLine + 1}`;
  return `From \`${display}\`:\n\n\`\`\`${lang}\n${opts.text}\n\`\`\`\n`;
}

/**
 * Parse `path/to/file.ts:42:7` into its parts. Exposed so the host
 * `openPath` handler can re-verify the webview-supplied string
 * before calling `vscode.window.showTextDocument`. Returns
 * `undefined` if the input doesn't look like a path.
 *
 * Host-side callers MUST resolve the result against the workspace
 * folder before opening — `path/to/file.ts` is a workspace-relative
 * path, never an absolute path (which would let an agent message
 * open arbitrary files on disk).
 */
export function parsePathReference(raw: string): { path: string; line?: number; column?: number } | undefined {
  const r = new RegExp(RE_PATH.source, ''); // no 'g' for single-match
  const m = r.exec(raw);
  if (!m) { return undefined; }
  // Reject if the match isn't the whole input.
  if (m[0] !== raw) { return undefined; }
  return {
    path: m[1],
    line: m[2] ? Number(m[2]) : undefined,
    column: m[3] ? Number(m[3]) : undefined,
  };
}

/**
 * Validate a commit hash before letting the host invoke `git diff`
 * against it. Defensive — even though the webview only emits
 * `data-hash` values it tokenized itself, an attacker who could
 * inject a malicious chat message must not be able to smuggle
 * non-hex content through this path. Rejects empty, too-short,
 * too-long, or non-hex input.
 */
export function isValidCommitHash(s: string): boolean {
  return typeof s === 'string' && /^[a-f0-9]{7,40}$/.test(s);
}
