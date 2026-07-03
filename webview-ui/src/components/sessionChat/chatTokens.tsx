/**
 * Webview-side tokenizer for the two click-to-open affordances we
 * want inside ReactMarkdown-rendered chat text:
 *
 *   1. Commit hashes — `[a-f0-9]{7,40}` → click → host fires
 *      `git.viewCommit` (opens the commit details view in a new editor
 *      tab). #2084 / #1613 sub-feature 5.
 *   2. File paths — `path/to/file.ts[:line[:col]]` → click → host
 *      opens the file at the given position in a new editor tab.
 *      #1613 sub-feature 2.
 *
 * Why we live here and not in the host's `chatRenderer.ts`:
 * - The host module is a parallel TS source-of-truth for the wire
 *   format (segment kinds + validators). It's deliberately not
 *   importable from the webview (CSP forbids cross-bundle imports
 *   at runtime, and re-bundling host code into the webview would
 *   drag vscode types into the browser build).
 * - The host's tokenizer also re-implements bold / italic / code
 *   tokenization because the host can synthesize raw HTML. We
 *   already use ReactMarkdown for those, so we only need the leaf-
 *   text scan for commit hashes + paths.
 *
 * Design: a `enhanceLeafText(children, dispatch)` helper that walks
 * ReactMarkdown's `children` arrays + string leaves and replaces
 * matched substrings with `<button>` elements. React elements are
 * left untouched, so anything wrapped in `<code>` / `<a>` / `<pre>`
 * by the markdown layer is NOT re-scanned — code samples stay verbatim.
 */

import { Fragment, type ReactNode, type MouseEvent } from 'react';

/**
 * Regex pair — mirrors `RE_COMMIT` / `RE_PATH` in
 * `src/views/sessions/chatRenderer.ts`. Kept in sync by convention,
 * not by import (see top-of-file note).
 *
 * Note on `lookbehind`: VSCode webviews run on Electron + Chromium ≥ 100,
 * which supports lookbehind groups. Vite's esbuild target also
 * preserves them. Safe to use.
 */
// Hyphens added to both lookbehind and lookahead so UUID fragments
// (e.g. `80998aa-42ec-4d21-b8c4-6989d27...` prompt ids) don't have
// their 7-hex-char segments rendered as clickable commit hashes.
// A real commit hash in prose is bounded by punctuation / whitespace,
// never by `-<hex>` on either side. Issue #2326.
//
// Issue #3358 adds two more guards, because bare prompt-id fragments
// ("user prompt 6d85db0f", "From user prompt 76197006 (asset ...)")
// are lexically identical to short hashes:
//   1. a hex run 1-3 separators after the word "prompt" is a prompt
//      reference, never a commit;
//   2. an all-digit run is overwhelmingly an id/number, not a hash —
//      abbreviated git hashes virtually always carry a letter (the
//      rare pure-digit hash staying plain text is the cheaper error).
// Known residual: a backticked prompt id (`d4156609`) reaches the
// tokenizer as a bare code leaf with no surrounding text, so keyword
// context can't save it — clicking such a chip lands on the polite
// #3357 fallback rather than a raw git error.
const RE_COMMIT = /(?<![#A-Za-z0-9-])(?<![Pp]rompt[\s:(-]{1,3})(?<!0x)\b(?!\d{7,40}\b)([a-f0-9]{7,40})\b(?![A-Za-z0-9-])/g;
const RE_PATH = /(?<![A-Za-z0-9_/\\.-])(\.{0,2}\/?[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8})(?::(\d{1,6})(?::(\d{1,6}))?)?(?![A-Za-z0-9_/\\.-])/g;

/**
 * Blocklist for the path tokenizer (#2329 follow-up via user prompt
 * 20588c4d).
 *
 * The agent frequently references vibeflow-backend documents in chat
 * by bare filename — e.g. "Updated context: vscode-extension-v2-context.md".
 * Those files live in the vibeflow backend, NOT in the workspace, so
 * matching them with RE_PATH renders a clickable button that fails
 * (openWorkspaceRelativePath can't find the file). Worse, it MISLEADS
 * the user — they click expecting the context viewer and get nothing.
 *
 * Until the agent emits structured tokens (`[context:N "title"]`,
 * `[document:N "title"]`, etc. — Layer B per the design discussion),
 * the safer behavior is to leave these filenames as plain text rather
 * than render a broken clickable. The text is still readable; users
 * navigate to the matching context via the Documents/Contexts tree
 * for now.
 *
 * Extend this regex when new naming conventions surface. Today:
 *   - `*-context.md`         — vibeflow project / feature contexts
 *   - `*-architecture.md`    — architecture docs (if used)
 *   - `prd-*.md` / `prd_*.md` — product requirements docs
 *   - `arch-*.md` / `arch_*.md` — abbreviated architecture docs
 */
const RE_PATH_VIBEFLOW_DOC_BLOCKLIST = /(?:-context\.md|-architecture\.md|^prd[-_]|^arch[-_])/i;
/**
 * Chat attachment token (#1670): `[asset:123 "filename.ext"]`.
 *
 * The filename can contain `\\` and `\"` escapes (mirrors the host's
 * `buildAssetToken` output in useChatAttachments.ts). We unescape
 * before passing to the renderer. Capture groups:
 *   1: asset id (positive integer)
 *   2: escaped filename
 */
const RE_ASSET = /\[asset:(\d+)\s+"((?:[^"\\]|\\[\\"])*)"\]/g;

/**
 * Work-item reference token (#3350): `issue #123` / `todo #123`
 * (case-insensitive, optional bold/backtick handled by the markdown
 * layer before we see the leaf). Click → host opens the work item in
 * a new editor tab via `vibeflow.openWorkItemPanel`.
 *
 * Deliberately keyword-prefixed: a bare `#123` is too ambiguous (PR
 * numbers, markdown artifacts, ordinal shorthand) — a false link that
 * opens the wrong work item is worse than plain text.
 */
const RE_WORK_ITEM = /\b(issue|todo)\s+#(\d{1,10})\b/gi;

/**
 * Validators that re-assert the regex output before we emit a
 * postMessage. The host re-validates on receipt, but matching the
 * host's shape here keeps us from posting obviously-malformed
 * payloads on every paint.
 */
function isValidCommitHash(s: string): boolean {
  return /^[a-f0-9]{7,40}$/.test(s);
}

export interface ChatTokenDispatch {
  openCommit(hash: string): void;
  openPath(path: string, line?: number, column?: number): void;
  /**
   * Render a chat-attachment token as JSX (#1670). When omitted, the
   * token falls through to plain text — that's the case for surfaces
   * like the Activity Feed where assets don't apply.
   */
  renderAsset?: (assetId: number, name: string) => ReactNode;
  /**
   * Open a referenced work item (#3350). When omitted, `issue #N` /
   * `todo #N` stay plain text — same opt-in contract as renderAsset.
   */
  openWorkItem?: (kind: 'issue' | 'todo', id: number) => void;
}

/** Reverse the escapes that `useChatAttachments.buildAssetToken` applies. */
function unescapeAssetName(escaped: string): string {
  return escaped.replace(/\\([\\"])/g, '$1');
}

/**
 * Walk a ReactMarkdown `children` tree, scanning string leaves for
 * commit hashes / paths and inlining clickable buttons in their
 * place. Returns ReactNode that can be slotted straight back into
 * a paragraph / list-item / table cell.
 *
 * React elements (already-rendered markdown nodes like `<code>`,
 * `<strong>`, `<a>`) pass through untouched, so:
 *   - inline code: `git log abc123` → "abc123" stays as plain text
 *     inside the `<code>` (not clickable — we DON'T want it).
 *   - markdown links: `[abc123](https://...)` → the anchor wins, no
 *     duplicate scan.
 */
export function enhanceLeafText(
  children: ReactNode,
  dispatch: ChatTokenDispatch,
): ReactNode {
  if (typeof children === 'string') {
    return scanString(children, dispatch);
  }
  if (Array.isArray(children)) {
    return children.map((c, i) => (
      <Fragment key={i}>{enhanceLeafText(c, dispatch)}</Fragment>
    ));
  }
  // Numbers / booleans / null / undefined / React elements — leave as-is.
  return children;
}

/**
 * Internal: scan a single string for the two regex hits, sort hits
 * by start position, walk + emit `<button>` for each match and
 * plain text for the gaps.
 *
 * On overlap, the earlier match wins. (Today the two regexes can't
 * overlap because the path regex requires a `.` + ext and the
 * commit regex rejects after-word-chars — but the overlap guard
 * stays for the case where future regexes might.)
 */
function scanString(text: string, dispatch: ChatTokenDispatch): ReactNode {
  if (!text) { return text; }
  interface Hit { start: number; end: number; node: ReactNode }
  const hits: Hit[] = [];

  // Commit hashes
  const commitRe = new RegExp(RE_COMMIT.source, RE_COMMIT.flags);
  let m: RegExpExecArray | null;
  while ((m = commitRe.exec(text)) !== null) {
    if (m[0].length === 0) { commitRe.lastIndex++; continue; }
    const hash = m[1];
    if (!isValidCommitHash(hash)) { continue; }
    hits.push({
      start: m.index,
      end: m.index + m[0].length,
      node: (
        <CommitHashButton
          key={`c-${m.index}`}
          hash={hash}
          onClick={() => dispatch.openCommit(hash)}
        />
      ),
    });
  }

  // Paths
  const pathRe = new RegExp(RE_PATH.source, RE_PATH.flags);
  while ((m = pathRe.exec(text)) !== null) {
    if (m[0].length === 0) { pathRe.lastIndex++; continue; }
    const pathStr = m[1];
    // Skip vibeflow-backend doc filenames — they aren't workspace files
    // and clicking them would mislead the user. See RE_PATH_VIBEFLOW_DOC_BLOCKLIST
    // header for the convention list and the longer Layer-A vs Layer-B
    // design note.
    //
    // We use `basename` (drop everything up to the last `/`) so a
    // legitimate workspace file at e.g. `docs/notes-context.md` would
    // also be skipped — that's the conservative call for now; a user
    // who really does have a `-context.md` in their workspace can still
    // open it via the Explorer.
    const basename = pathStr.replace(/^.*[/\\]/, '');
    if (RE_PATH_VIBEFLOW_DOC_BLOCKLIST.test(basename)) { continue; }
    const line = m[2] ? Number(m[2]) : undefined;
    const column = m[3] ? Number(m[3]) : undefined;
    const raw = m[0];
    hits.push({
      start: m.index,
      end: m.index + m[0].length,
      node: (
        <PathRefButton
          key={`p-${m.index}`}
          label={raw}
          onClick={() => dispatch.openPath(pathStr, line, column)}
        />
      ),
    });
  }

  // Work-item references — `issue #N` / `todo #N` (#3350). Only emit
  // when the dispatch supplies a handler; otherwise leave plain text.
  if (dispatch.openWorkItem) {
    const openWorkItem = dispatch.openWorkItem;
    const workItemRe = new RegExp(RE_WORK_ITEM.source, RE_WORK_ITEM.flags);
    while ((m = workItemRe.exec(text)) !== null) {
      if (m[0].length === 0) { workItemRe.lastIndex++; continue; }
      const kind = m[1].toLowerCase() as 'issue' | 'todo';
      const id = Number(m[2]);
      if (!Number.isFinite(id) || id <= 0) { continue; }
      hits.push({
        start: m.index,
        end: m.index + m[0].length,
        node: (
          <WorkItemRefButton
            key={`w-${m.index}`}
            kind={kind}
            id={id}
            label={m[0]}
            onClick={() => openWorkItem(kind, id)}
          />
        ),
      });
    }
  }

  // Chat attachment tokens — `[asset:N "name"]` (#1670). Only emit when
  // the dispatch supplies a renderer; otherwise leave the literal in
  // place (Activity Feed case).
  if (dispatch.renderAsset) {
    const assetRe = new RegExp(RE_ASSET.source, RE_ASSET.flags);
    while ((m = assetRe.exec(text)) !== null) {
      if (m[0].length === 0) { assetRe.lastIndex++; continue; }
      const assetId = Number(m[1]);
      if (!Number.isFinite(assetId) || assetId <= 0) { continue; }
      const name = unescapeAssetName(m[2]);
      hits.push({
        start: m.index,
        end: m.index + m[0].length,
        node: (
          <span key={`a-${m.index}`} className="asset-token">
            {dispatch.renderAsset(assetId, name)}
          </span>
        ),
      });
    }
  }

  if (hits.length === 0) { return text; }
  hits.sort((a, b) => a.start - b.start);

  const out: ReactNode[] = [];
  let cursor = 0;
  let keyIdx = 0;
  for (const hit of hits) {
    if (hit.start < cursor) { continue; } // overlap — skip
    if (hit.start > cursor) {
      out.push(<Fragment key={`t-${keyIdx++}`}>{text.slice(cursor, hit.start)}</Fragment>);
    }
    out.push(hit.node);
    cursor = hit.end;
  }
  if (cursor < text.length) {
    out.push(<Fragment key={`t-${keyIdx++}`}>{text.slice(cursor)}</Fragment>);
  }
  return out;
}

/**
 * Render a commit hash as a click-to-open editor-area diff button.
 * Styled as a subtle monospace pill so it reads as "interactive
 * reference" without shouting in the chat flow. Short-form (7 chars)
 * shown in the UI; full hash carried in the data attribute + the
 * `onClick` closure so the host gets the original string.
 */
function CommitHashButton({ hash, onClick }: { hash: string; onClick: () => void }) {
  const short = hash.length > 7 ? hash.slice(0, 7) : hash;
  return (
    <button
      type="button"
      className="chat-commit-hash"
      title={`Open commit ${hash} in editor`}
      data-hash={hash}
      onClick={(e: MouseEvent<HTMLButtonElement>) => { e.preventDefault(); onClick(); }}
    >
      {short}
    </button>
  );
}

/**
 * Render an `issue #N` / `todo #N` reference as a click-to-open bubble
 * chip (#3350, per reference screenshot asset #1449). Label preserves
 * the original text so casing ("Issue #12") survives; the kind drives
 * the per-kind accent color in CSS.
 */
function WorkItemRefButton({ kind, id, label, onClick }: {
  kind: 'issue' | 'todo';
  id: number;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`chat-workitem-ref chat-workitem-${kind}`}
      title={`Open ${kind} #${id} in a new tab`}
      onClick={(e: MouseEvent<HTMLButtonElement>) => { e.preventDefault(); onClick(); }}
    >
      {label}
    </button>
  );
}

/**
 * Render a path reference as a click-to-open file button. Preserves
 * the original text (with the `:line:col` suffix if present) so the
 * label exactly matches what the agent typed — the reported bug was
 * paths showing as plain text; the fix is just to make them clickable,
 * not to reformat.
 */
function PathRefButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="chat-path-ref"
      title={`Open ${label} in editor`}
      onClick={(e: MouseEvent<HTMLButtonElement>) => { e.preventDefault(); onClick(); }}
    >
      {label}
    </button>
  );
}
