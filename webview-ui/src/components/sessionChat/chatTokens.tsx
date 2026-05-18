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
const RE_COMMIT = /(?<![#A-Za-z0-9])(?<!0x)\b([a-f0-9]{7,40})\b(?![A-Za-z0-9])/g;
const RE_PATH = /(?<![A-Za-z0-9_/\\.-])(\.{0,2}\/?[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8})(?::(\d{1,6})(?::(\d{1,6}))?)?(?![A-Za-z0-9_/\\.-])/g;
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
 * Render a path reference as a click-to-open file button. Preserves
 * the original text (with the `:line:col` suffix if present) so the
 * label exactly matches what the agent typed — Ranjan's reported bug
 * was paths showing as plain text; the fix is just to make them
 * clickable, not to reformat.
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
