import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

/**
 * Light structural renderer for agent message bodies (#chat-structure).
 *
 * The persona agents emit freeform markdown, but write *structure* as
 * plain-text house-style conventions that react-markdown otherwise flattens
 * into a wall of `<p>`/`<strong>`. This component recognizes those
 * conventions and renders them as real elements:
 *
 *   - a metadata header line       `[2026-…Z | session-…]`     → muted caption
 *   - ALL-CAPS section headers     SYSTEM MAP / PLAN / …        → section label
 *   - emoji phase markers          🤔 Thinking — …  ⚠️ WARN — …  → labeled callout
 *
 * Everything it does NOT recognize falls straight through to react-markdown,
 * so unknown content (prose, code fences, ```diff blocks, tables) renders
 * exactly as before. The structure is ADDITIVE and fence-aware — it never
 * splits inside a code block, so DiffBlock and syntax highlighting are
 * untouched. Heuristic by nature: if an agent changes its phrasing the
 * special styling simply stops applying; nothing breaks.
 */

type Tone = 'info' | 'success' | 'warn' | 'security' | 'note';

type Seg =
  | { kind: 'md'; text: string }
  | { kind: 'meta'; text: string }
  | { kind: 'section'; text: string }
  | { kind: 'phase'; tone: Tone; label: string; body: string };

interface Props {
  text: string;
  /** The shared markdownComponents(diffView) from MessageBubble — keeps chip
   *  buttons, ```diff → DiffBlock, and tables working inside structured bodies. */
  mdComponents: Components;
}

// `[<iso> | session-<id>]` on its own line.
const META_RE = /^\[[^\]]*\bsession-[A-Za-z0-9-]+\][.\s]*$/;

// An ALL-CAPS section header line, optionally with a trailing lowercase
// parenthetical: SYSTEM MAP · PLAN · NOT TOUCHED (intentionally) · TEST GAP (explicit)
const SECTION_RE = /^[A-Z][A-Z0-9]*(?: [A-Z0-9]+)*(?: \([a-z][a-z ]*\))?$/;

// A line that begins with an emoji (optionally + variation selector) and a space.
// Any leading pictographic acts as a phase marker — that's how the agents prefix
// Thinking / Context / Diff / Next / Verification / Done / WARN lines.
const PHASE_RE = /^(\p{Extended_Pictographic}️?)\s+(.+)$/u;

function toneForEmoji(emoji: string): Tone {
  const e = emoji.replace(/️/g, '');
  if (e === '⚠') { return 'warn'; }
  if (e === '✅') { return 'success'; }
  if (e === '🔒') { return 'security'; }
  if (e === '📋') { return 'note'; }
  return 'info';
}

// Split "Thinking — Reproduced the …" / "Next: typecheck …" into label + body.
// Label is the run-in up to the first em-dash or colon; everything else is body.
function splitLabel(rest: string): { label: string; body: string } {
  const m = rest.match(/^([^—:]{1,48}?)\s*[—:]\s+(.+)$/);
  if (m) { return { label: m[1].trim(), body: m[2] }; }
  return { label: '', body: rest };
}

function segment(raw: string): Seg[] {
  const lines = raw.split('\n');
  const segs: Seg[] = [];
  let buf: string[] = [];
  let inFence = false;

  const flush = () => {
    if (buf.length > 0) {
      segs.push({ kind: 'md', text: buf.join('\n') });
      buf = [];
    }
  };

  for (const line of lines) {
    const t = line.trim();

    // Fence-aware: never classify anything inside a ``` code block.
    if (t.startsWith('```')) { inFence = !inFence; buf.push(line); continue; }
    if (inFence || t === '') { buf.push(line); continue; }

    if (META_RE.test(t)) { flush(); segs.push({ kind: 'meta', text: t }); continue; }

    if (t.length >= 3 && t.length <= 40 && SECTION_RE.test(t)) {
      flush();
      segs.push({ kind: 'section', text: t });
      continue;
    }

    const pm = t.match(PHASE_RE);
    if (pm) {
      const { label, body } = splitLabel(pm[2]);
      flush();
      segs.push({ kind: 'phase', tone: toneForEmoji(pm[1]), label, body });
      continue;
    }

    buf.push(line);
  }
  flush();
  return segs;
}

function Markdown({ text, components }: { text: string; components: Components }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={components}
    >
      {text}
    </ReactMarkdown>
  );
}

export function StructuredAgentBody({ text, mdComponents }: Props) {
  const segs = useMemo(() => segment(text), [text]);
  return (
    <>
      {segs.map((seg, i) => {
        if (seg.kind === 'meta') {
          return <div key={i} className="chat-meta">{seg.text}</div>;
        }
        if (seg.kind === 'section') {
          return <div key={i} className="chat-section">{seg.text}</div>;
        }
        if (seg.kind === 'phase') {
          return (
            <div key={i} className={`chat-phase chat-phase-${seg.tone}`}>
              <span className="chat-phase-dot" aria-hidden="true" />
              <div className="chat-phase-content">
                {seg.label && <span className="chat-phase-label">{seg.label}</span>}
                <span className="chat-phase-body">
                  <Markdown text={seg.body} components={mdComponents} />
                </span>
              </div>
            </div>
          );
        }
        return <Markdown key={i} text={seg.text} components={mdComponents} />;
      })}
    </>
  );
}
