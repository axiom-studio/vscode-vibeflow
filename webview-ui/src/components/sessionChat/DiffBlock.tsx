import { useMemo } from 'react';
import { getVsCodeApi } from '../../vscodeApi';

interface Props {
  /** Raw unified-diff text (the content of a ```diff fenced block). */
  text: string;
  /** User preference for inline rendering — controlled via Settings → Session Defaults → Chat. */
  mode: 'unified' | 'split';
  /** Hint for the syntax language to set on the synthetic before/after docs when opening in the VSCode diff editor. Inferred from the diff's file header when present. */
  language?: string;
}

// One row of the rendered diff. `kind` drives gutter color + which side
// the text appears on in split view.
interface DiffLine {
  kind: 'context' | 'add' | 'remove' | 'hunk' | 'meta';
  text: string;
  /** 1-based line number on the "before" side (when applicable). */
  oldNo?: number;
  /** 1-based line number on the "after" side (when applicable). */
  newNo?: number;
}

// Pair-row used in split view. Either side may be null when the hunk has
// pure additions or pure removals.
interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

const vscode = getVsCodeApi();

/**
 * Renders a unified-format diff in either inline-unified or inline-split
 * style, with an "Open in Editor" affordance that opens the standard
 * VSCode diff editor on a reconstructed before/after pair.
 *
 * Parser is intentionally tolerant: malformed diffs degrade to plain
 * text rendering — chat must never crash because a model emitted a
 * weird hunk header.
 */
export function DiffBlock({ text, mode, language }: Props) {
  const { lines, stats, filePath, inferredLanguage } = useMemo(() => parseUnifiedDiff(text), [text]);

  const effectiveLanguage = language ?? inferredLanguage;
  const title = filePath ? `Diff: ${filePath}` : 'Diff';

  const openInEditor = () => {
    if (!vscode) { return; }
    const { before, after } = reconstructSides(lines);
    vscode.postMessage({
      type: 'openDiff',
      payload: { title, before, after, language: effectiveLanguage, filePath },
    });
  };

  return (
    <div className="diff-block">
      <div className="diff-header">
        <div className="diff-header-title">
          {filePath ? (
            <span className="diff-filepath">{filePath}</span>
          ) : (
            <span className="diff-filepath diff-filepath-empty">Diff</span>
          )}
          <span className="diff-stat diff-stat-add">+{stats.added}</span>
          <span className="diff-stat diff-stat-remove">−{stats.removed}</span>
        </div>
        <div className="diff-header-actions">
          <button
            type="button"
            className="diff-open-btn"
            onClick={openInEditor}
            title="Open in VSCode's native diff editor (full review with gutter actions, scroll-sync, navigate-hunks)"
          >
            ⇗ Open in Editor
          </button>
        </div>
      </div>
      {mode === 'split' ? (
        <SplitView lines={lines} />
      ) : (
        <UnifiedView lines={lines} />
      )}
    </div>
  );
}

function UnifiedView({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="diff-unified">
      {lines.map((line, i) => (
        <div key={i} className={`diff-row diff-row-${line.kind}`}>
          <span className="diff-gutter diff-gutter-old">{line.oldNo ?? ''}</span>
          <span className="diff-gutter diff-gutter-new">{line.newNo ?? ''}</span>
          <span className="diff-sign">{signFor(line.kind)}</span>
          <span className="diff-text">{line.text}</span>
        </div>
      ))}
    </div>
  );
}

function SplitView({ lines }: { lines: DiffLine[] }) {
  const rows = useMemo(() => alignSplitRows(lines), [lines]);
  return (
    <div className="diff-split">
      <div className="diff-split-header">
        <span>Before</span>
        <span>After</span>
      </div>
      <div className="diff-split-body">
        {rows.map((row, i) => (
          <div key={i} className="diff-split-row">
            <div className={`diff-split-cell diff-cell-${row.left?.kind ?? 'empty'}`}>
              <span className="diff-gutter">{row.left?.oldNo ?? ''}</span>
              <span className="diff-text">{row.left?.text ?? ''}</span>
            </div>
            <div className={`diff-split-cell diff-cell-${row.right?.kind ?? 'empty'}`}>
              <span className="diff-gutter">{row.right?.newNo ?? ''}</span>
              <span className="diff-text">{row.right?.text ?? ''}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function signFor(kind: DiffLine['kind']): string {
  if (kind === 'add') { return '+'; }
  if (kind === 'remove') { return '−'; }
  if (kind === 'hunk') { return '@'; }
  return ' ';
}

/**
 * Walk a unified diff and emit one DiffLine per source line, tracking
 * old/new line numbers across hunks. Permissive — junk lines surface
 * as 'meta' rows rather than throwing.
 */
function parseUnifiedDiff(text: string): {
  lines: DiffLine[];
  stats: { added: number; removed: number };
  filePath?: string;
  inferredLanguage?: string;
} {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let added = 0;
  let removed = 0;
  let filePath: string | undefined;

  for (const raw of text.split('\n')) {
    if (raw.startsWith('@@')) {
      // hunk header: @@ -L,N +L,N @@
      const m = /@@\s*-(\d+)(?:,\d+)?\s*\+(\d+)(?:,\d+)?\s*@@/.exec(raw);
      if (m) {
        oldNo = parseInt(m[1], 10);
        newNo = parseInt(m[2], 10);
      }
      out.push({ kind: 'hunk', text: raw });
      continue;
    }
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('diff ') || raw.startsWith('index ')) {
      // file header lines — capture filePath from `+++ b/path` line
      if (raw.startsWith('+++ ')) {
        const path = raw.slice(4).replace(/^[ab]\//, '');
        if (path && path !== '/dev/null') { filePath = path; }
      }
      out.push({ kind: 'meta', text: raw });
      continue;
    }
    if (raw.startsWith('+')) {
      out.push({ kind: 'add', text: raw.slice(1), newNo });
      newNo += 1;
      added += 1;
      continue;
    }
    if (raw.startsWith('-')) {
      out.push({ kind: 'remove', text: raw.slice(1), oldNo });
      oldNo += 1;
      removed += 1;
      continue;
    }
    if (raw.startsWith(' ')) {
      out.push({ kind: 'context', text: raw.slice(1), oldNo, newNo });
      oldNo += 1;
      newNo += 1;
      continue;
    }
    // Empty line or unrecognized — treat as context to preserve formatting.
    if (raw === '') {
      out.push({ kind: 'context', text: '', oldNo, newNo });
      oldNo += 1;
      newNo += 1;
      continue;
    }
    out.push({ kind: 'meta', text: raw });
  }

  // Strip trailing empty context row if the diff ends with a newline.
  while (out.length && out[out.length - 1].kind === 'context' && !out[out.length - 1].text) {
    out.pop();
  }

  const inferredLanguage = filePath ? inferLanguage(filePath) : undefined;
  return { lines: out, stats: { added, removed }, filePath, inferredLanguage };
}

/**
 * Pair add/remove runs into the same SplitRow so the user reads the
 * replacement on the same horizontal line. Context rows mirror on both
 * sides. Pure adds without a paired remove get a blank left cell;
 * pure removes get a blank right cell.
 */
function alignSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.kind === 'hunk' || line.kind === 'meta') {
      rows.push({
        left: { ...line, text: line.text },
        right: { ...line, text: line.text },
      });
      i += 1;
      continue;
    }
    if (line.kind === 'context') {
      rows.push({ left: line, right: line });
      i += 1;
      continue;
    }
    // We're at an add or remove. Collect the consecutive removes and
    // adds in this hunk-section and pair them.
    const removes: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && (lines[i].kind === 'remove' || lines[i].kind === 'add')) {
      if (lines[i].kind === 'remove') { removes.push(lines[i]); }
      else { adds.push(lines[i]); }
      i += 1;
    }
    const pairCount = Math.max(removes.length, adds.length);
    for (let k = 0; k < pairCount; k += 1) {
      rows.push({
        left: removes[k] ?? null,
        right: adds[k] ?? null,
      });
    }
  }
  return rows;
}

/**
 * Build the two synthetic file contents the VSCode diff editor opens.
 * Re-applies adds to construct the "after" side and removes to
 * construct the "before" side. Context lines appear in both.
 */
function reconstructSides(lines: DiffLine[]): { before: string; after: string } {
  const before: string[] = [];
  const after: string[] = [];
  for (const line of lines) {
    if (line.kind === 'context') {
      before.push(line.text);
      after.push(line.text);
    } else if (line.kind === 'remove') {
      before.push(line.text);
    } else if (line.kind === 'add') {
      after.push(line.text);
    }
    // hunk / meta lines are dropped — they're not part of the file
  }
  return {
    before: before.join('\n'),
    after: after.join('\n'),
  };
}

function inferLanguage(filePath: string): string | undefined {
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (!ext) { return undefined; }
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescriptreact',
    js: 'javascript',
    jsx: 'javascriptreact',
    py: 'python',
    go: 'go',
    rs: 'rust',
    java: 'java',
    rb: 'ruby',
    php: 'php',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    hpp: 'cpp',
    cs: 'csharp',
    swift: 'swift',
    kt: 'kotlin',
    sh: 'shellscript',
    bash: 'shellscript',
    zsh: 'shellscript',
    md: 'markdown',
    json: 'json',
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'toml',
    html: 'html',
    css: 'css',
    scss: 'scss',
    sql: 'sql',
  };
  return map[ext];
}

