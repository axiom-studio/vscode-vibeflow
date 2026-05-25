import { memo, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import type { ChatPrompt, SessionMode } from './sessionChatTypes';
import { DiffBlock } from './DiffBlock';
import { PersonaAvatar } from './PersonaAvatar';
import { enhanceLeafText, type ChatTokenDispatch } from './chatTokens';
import { AssetCard } from './AssetCard';
import { getVsCodeApi } from '../../vscodeApi';

interface Props {
  msg: ChatPrompt;
  personaName: string;
  /**
   * Optional persona portrait — `{serverUrl}/persona/professional/...jpg`.
   * Shared mapping lives in `personaAvatars.ts` so the chat and the
   * dashboard's agent topology render the same images for each persona.
   * Falls back to a single-letter glyph when undefined (offline, unknown
   * persona, etc.).
   */
  personaAvatarUrl?: string;
  /** User's preferred inline diff layout, threaded down from SessionChatView. */
  diffView: 'unified' | 'split';
  /**
   * Per-launch session mode (#2329). Used to suppress the
   * "agent is autonomous, won't reply to plain chat" stale-pending
   * hint in chat-first mode where the agent DOES reply via
   * `response_text`. The hint is correct ONLY for vanilla / vibeflow
   * (terminal-driven) sessions; for chat-first it would actively
   * mislead the user.
   */
  sessionMode: SessionMode;
  onRespond?: (promptId: string, text: string) => void;
}

/**
 * One row in the chat transcript. Renders either:
 *   - source='user' messages: plain user text (right-edge accent border)
 *   - source='agent' messages: agent prompt (left side, markdown body),
 *     plus an inline reply form when status='pending'
 *
 * Distinct visual treatment for the two sources without crowding the
 * panel with full bubbles — see Roo-Code / Continue / Cursor: agent
 * content reads better as a "post" than a "bubble".
 *
 * **Memoized** (`React.memo` default shallow equality, #2330): the
 * transcript is rendered as a plain `messages.map(... => <MessageBubble>)`
 * (NOT virtualized today), so on every parent state change every visible
 * bubble would re-render — including a full re-pass of
 * `react-markdown` + `rehype-highlight` for agent bodies. Default
 * shallow-compare works here because: the host produces a NEW `msg`
 * reference whenever any field changes (no in-place mutation —
 * `mergeAppend` upserts by replacing the entry), `personaName` /
 * `personaAvatarUrl` / `diffView` are stable across keystrokes, and
 * `onRespond` is stable too (it's the `respond` callback from
 * SessionChatView which is created once per render-cycle with stable
 * deps — see SessionChatView). If a future change to `onRespond` makes
 * it non-stable, this memo will degrade silently to "always re-render";
 * worth a `useCallback` audit if profile data ever points back here.
 */
function MessageBubbleImpl({ msg, personaName, personaAvatarUrl, diffView, sessionMode, onRespond }: Props) {
  const [replyText, setReplyText] = useState('');
  const isUser = msg.source === 'user';
  const isAgentPending = msg.source === 'agent' && msg.status === 'pending';
  const author = isUser ? 'You' : personaName;
  const time = formatTime(msg.created_at);

  // User → agent prompts can sit in `pending` indefinitely when the
  // agent is autonomous AND terminal-driven (vanilla / vibeflow):
  // it picks up work items via `wait_for_work` and doesn't reply to
  // conversational messages unless they match a tracked todo / issue.
  // Without a hint, the `pending` badge reads like a bug ("the agent
  // ignored me"). Surface a subtle explainer once the message has been
  // pending past PENDING_HINT_THRESHOLD_MS.
  //
  // **Suppressed in chat-first mode** (#2329 follow-up): chat-first
  // agents DO reply via `response_text` — that's the whole point of
  // chat-first. The hint would actively mislead the user there. The
  // WorkingIndicator ("Working... 1m 23s") in the message header is
  // already sufficient signal that the agent is alive and processing;
  // a chat-first user just needs to wait, not "create a work item".
  const showStalePendingHint = isUser
    && msg.status === 'pending'
    && sessionMode !== 'chat_first'
    && isStale(msg.created_at, PENDING_HINT_THRESHOLD_MS);

  return (
    <div className={isUser ? 'msg-row msg-user' : 'msg-row msg-agent'}>
      <PersonaAvatar
        className="msg-avatar"
        src={isUser ? undefined : personaAvatarUrl}
        fallbackGlyph={avatarGlyph(isUser, personaName)}
      />
      <div className="msg-body">
        <div className="msg-header">
          <span className="msg-author">{author}</span>
          <span className="msg-time">{time}</span>
          {msg.status === 'pending' && <WorkingIndicator startTime={msg.created_at} />}
          {msg.status === 'expired' && (
            <span className="msg-status msg-status-expired">expired</span>
          )}
        </div>
        <div className="msg-content">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={markdownComponents(diffView)}
          >
            {stripAgentFooter(msg.prompt_text || '')}
          </ReactMarkdown>
        </div>

        {msg.response_text && (
          <div className="msg-response">
            <div className="msg-response-label">Response</div>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={markdownComponents(diffView)}
            >
              {msg.response_text}
            </ReactMarkdown>
          </div>
        )}

        {showStalePendingHint && (
          <div className="msg-pending-hint" role="note">
            <span className="msg-pending-hint-icon" aria-hidden="true">ⓘ</span>
            <span>
              The agent is running autonomously — it picks up tracked todos and
              issues via <code>wait_for_work</code> and won&apos;t reply to
              plain chat. Create a work item or attach this message to one to
              get a response.
            </span>
          </div>
        )}

        {isAgentPending && onRespond && (
          <form
            className="msg-reply-form"
            onSubmit={e => {
              e.preventDefault();
              const text = replyText.trim();
              if (!text) { return; }
              onRespond(msg.prompt_id, text);
              setReplyText('');
            }}
          >
            <input
              type="text"
              placeholder="Reply to this prompt..."
              value={replyText}
              onChange={e => setReplyText(e.target.value)}
              autoFocus
            />
            <button type="submit" disabled={!replyText.trim()}>Reply</button>
          </form>
        )}
      </div>
    </div>
  );
}

/**
 * Strip the host-emitted agent-targeted footer from the user-visible
 * chat. SessionPanelManager.ts::annotateChatTextForAgent appends a
 * single italic line at the end of any message that has `[asset:N]`
 * tokens, instructing the LLM how to fetch the file:
 *
 *   _Agents: fetch via the `list_attachments` MCP tool with
 *   entity_type='project' ... or directly via /rest/v1/vibeflow/assets/<id>/download ..._
 *
 * That line is useful to the agent on the other side of `createPrompt`
 * (it tells the LLM what tool to call) but reads like leaked instructions
 * in the user's own transcript. The host keeps emitting the full footer
 * so the agent still sees it; this filter only affects the webview render.
 *
 * The content of the footer contains `_` characters (in `list_attachments`,
 * `entity_type`, `asset_id`), so we can't naively match the closing italic
 * with `[^_]*?`. Instead we anchor on the closing `_` immediately followed
 * by optional whitespace + end-of-string, with `.*` greedily consuming the
 * single-line content (default flag: `.` doesn't match newlines, so this
 * won't run away into multi-line content).
 *
 * Anchored at end-of-string because `annotateChatTextForAgent` always
 * appends the footer last. Issue #2333.
 */
function stripAgentFooter(text: string): string {
  return text.replace(/\n\n_Agents: .*_\s*$/, '');
}

/**
 * ReactMarkdown component overrides shared by the prompt body and
 * inline-response renderers. The `code` override is where unified-diff
 * and patch fences (```diff / ```patch) get routed to the dedicated
 * `DiffBlock` for inline-unified/inline-split rendering — everything
 * else falls through to the default `<code>` so rehype-highlight can
 * still colorize it.
 *
 * We unwrap diff blocks from the surrounding `<pre>` element too
 * (the `pre` override): without this, the markdown renderer wraps
 * our DiffBlock in `<pre><code>…</code></pre>`, which forces the
 * whole diff into the default code-block padding/scroll container
 * and breaks the split-view's horizontal layout.
 */
function markdownComponents(diffView: 'unified' | 'split'): Components {
  return {
    a({ href, children }) {
      return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
    },
    table({ children }) {
      return <div style={{ overflowX: 'auto' }}><table>{children}</table></div>;
    },
    code({ className, children, ...props }) {
      const lang = /language-(\S+)/.exec(className || '')?.[1];
      if (lang === 'diff' || lang === 'patch') {
        return <DiffBlock text={childrenToString(children)} mode={diffView} />;
      }
      // Inline `code` (no language class) — recurse through enhanceLeafText so
      // commit hashes / file paths wrapped in backticks (e.g. `` `abc1234` ``)
      // become clickable buttons. Without this they render as opaque monospace
      // and click does nothing. Issue #2334.
      //
      // Fenced code with a known language stays opaque so rehype-highlight's
      // syntax coloring isn't interrupted by token buttons inside source code.
      if (!lang) {
        return <code className={className} {...props}>{enhanceLeafText(children, chatTokenDispatch)}</code>;
      }
      return <code className={className} {...props}>{children}</code>;
    },
    pre({ children, ...props }) {
      // If the only child is a ```diff/```patch fenced code element,
      // drop the <pre> wrapper so DiffBlock controls its own layout.
      const codeChild = extractSingleCodeChild(children);
      const lang = codeChild ? /language-(\S+)/.exec(codeChild.className || '')?.[1] : undefined;
      if (lang === 'diff' || lang === 'patch') {
        return <>{children}</>;
      }
      return <pre {...props}>{children}</pre>;
    },
    // Walk leaf text inside text-bearing markdown containers and
    // promote commit hashes / file paths to clickable buttons. We
    // only override containers whose children are plain prose;
    // `<code>` / `<pre>` are handled above and their inner text
    // never re-enters this path (React elements pass through
    // `enhanceLeafText` untouched). #2084 / #1613.
    //
    // Includes inline emphasis wrappers (strong/em/del/ins/sub/sup)
    // because react-markdown wraps `**hash**` / `*hash*` in those —
    // without an override there, the inner text would be a child of
    // a React element and our walker would skip it.
    p({ children, ...props }) {
      return <p {...props}>{enhanceLeafText(children, chatTokenDispatch)}</p>;
    },
    li({ children, ...props }) {
      return <li {...props}>{enhanceLeafText(children, chatTokenDispatch)}</li>;
    },
    td({ children, ...props }) {
      return <td {...props}>{enhanceLeafText(children, chatTokenDispatch)}</td>;
    },
    th({ children, ...props }) {
      return <th {...props}>{enhanceLeafText(children, chatTokenDispatch)}</th>;
    },
    blockquote({ children, ...props }) {
      return <blockquote {...props}>{enhanceLeafText(children, chatTokenDispatch)}</blockquote>;
    },
    h1({ children, ...props }) {
      return <h1 {...props}>{enhanceLeafText(children, chatTokenDispatch)}</h1>;
    },
    h2({ children, ...props }) {
      return <h2 {...props}>{enhanceLeafText(children, chatTokenDispatch)}</h2>;
    },
    h3({ children, ...props }) {
      return <h3 {...props}>{enhanceLeafText(children, chatTokenDispatch)}</h3>;
    },
    h4({ children, ...props }) {
      return <h4 {...props}>{enhanceLeafText(children, chatTokenDispatch)}</h4>;
    },
    h5({ children, ...props }) {
      return <h5 {...props}>{enhanceLeafText(children, chatTokenDispatch)}</h5>;
    },
    h6({ children, ...props }) {
      return <h6 {...props}>{enhanceLeafText(children, chatTokenDispatch)}</h6>;
    },
    strong({ children, ...props }) {
      return <strong {...props}>{enhanceLeafText(children, chatTokenDispatch)}</strong>;
    },
    em({ children, ...props }) {
      return <em {...props}>{enhanceLeafText(children, chatTokenDispatch)}</em>;
    },
    del({ children, ...props }) {
      return <del {...props}>{enhanceLeafText(children, chatTokenDispatch)}</del>;
    },
  };
}

/**
 * Dispatch closure for the click-to-open buttons emitted by
 * `enhanceLeafText`. Singleton — no instance state — so we don't
 * thread props through every markdown render.
 *
 * Both messages have host-side handlers in
 * `src/views/sessions/SessionPanelManager.ts` (`chatOpenCommit`,
 * `chatOpenPath`). The host re-validates payloads on receipt.
 */
const chatTokenDispatch: ChatTokenDispatch = {
  openCommit(hash) {
    getVsCodeApi().postMessage({ type: 'chatOpenCommit', payload: { hash } });
  },
  openPath(path, line, column) {
    getVsCodeApi().postMessage({ type: 'chatOpenPath', payload: { path, line, column } });
  },
  renderAsset(assetId, name) {
    return <AssetCard id={assetId} name={name} />;
  },
};

function childrenToString(children: ReactNode): string {
  if (typeof children === 'string') { return children; }
  if (Array.isArray(children)) { return children.map(childrenToString).join(''); }
  if (children && typeof children === 'object' && 'props' in children) {
    return childrenToString((children as { props: { children?: ReactNode } }).props.children);
  }
  return '';
}

/**
 * react-markdown wraps fenced code in `<pre><code className="language-…">`.
 * When the only child of <pre> is that <code>, return it so the caller can
 * inspect className without iterating arbitrary children.
 */
function extractSingleCodeChild(children: ReactNode): { className?: string } | null {
  const arr = Array.isArray(children) ? children : [children];
  const real = arr.filter(c => c !== null && c !== undefined && c !== '');
  if (real.length !== 1) { return null; }
  const only = real[0];
  if (only && typeof only === 'object' && 'props' in only) {
    return (only as { props: { className?: string } }).props;
  }
  return null;
}

/**
 * How long a user → agent prompt must sit in `pending` before we
 * surface the "agent is autonomous, won't reply to chitchat" hint.
 * 60s is long enough to skip the normal-latency case (agent processes
 * within ~5s when it's actually polling) but short enough to be
 * useful — by the time you've sent a follow-up, the hint is already
 * up on the first message.
 *
 * The hint re-evaluates on every parent re-render (poll-driven, every
 * ~5s + on every chatAppend), so it appears within ~5s of crossing
 * the threshold without needing a per-message timer.
 */
const PENDING_HINT_THRESHOLD_MS = 60 * 1000;

function isStale(iso: string, thresholdMs: number): boolean {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) { return false; }
  return Date.now() - t >= thresholdMs;
}

/**
 * Animated "Working… {elapsed}" indicator for pending prompts.
 *
 * Replaces the previous static `pending` status chip (which read like
 * a bug — "the agent ignored me"). Mirrors axiomcloud's chat surface:
 * three breathing dots + a live tabular-nums time counter so the user
 * can see both *the agent is alive* AND *how long it has been working*.
 *
 * The interval is cleaned up on unmount or `startTime` change, so
 * rapid prompt churn (transcript replay, message dedupe) doesn't leak
 * timers. The dots animation is purely CSS — the JS tick only updates
 * the elapsed display.
 */
function WorkingIndicator({ startTime }: { startTime: string }) {
  const start = Date.parse(startTime);
  const validStart = Number.isFinite(start);
  const [elapsedMs, setElapsedMs] = useState(() =>
    validStart ? Math.max(0, Date.now() - start) : 0,
  );

  useEffect(() => {
    if (!validStart) { return; }
    const tick = () => setElapsedMs(Math.max(0, Date.now() - start));
    tick(); // sync on mount so a re-rendered pending prompt isn't briefly 0s.
    const id = window.setInterval(tick, 1000);
    return () => { window.clearInterval(id); };
  }, [start, validStart]);

  const elapsedLabel = formatElapsed(elapsedMs);
  return (
    <span className="msg-working" aria-label={`Working for ${elapsedLabel}`}>
      <span className="msg-working-label">Working</span>
      <span className="msg-working-dots" aria-hidden="true">
        <span>.</span><span>.</span><span>.</span>
      </span>
      <span className="msg-working-time">{elapsedLabel}</span>
    </span>
  );
}

/**
 * Compact elapsed-time format aligned with axiomcloud's chat counter.
 *
 *   0–59s → `12s`
 *   1–59m → `1m 24s` (or `5m` when seconds === 0)
 *   ≥ 60m → `1h 12m` (or `2h` when minutes === 0)
 *
 * Always uses ASCII to keep tabular-nums width predictable.
 */
function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) { return `${totalSec}s`; }
  const totalMin = Math.floor(totalSec / 60);
  const remSec = totalSec % 60;
  if (totalMin < 60) {
    return remSec > 0 ? `${totalMin}m ${remSec}s` : `${totalMin}m`;
  }
  const hours = Math.floor(totalMin / 60);
  const remMin = totalMin % 60;
  return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`;
}

function avatarGlyph(isUser: boolean, personaName: string): string {
  if (isUser) { return 'U'; }
  // First letter of persona, uppercase.
  return personaName.trim().charAt(0).toUpperCase() || 'A';
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/**
 * Memoized export — see the MessageBubbleImpl doc-comment for the
 * shallow-equality rationale (#2330). Wraps the impl so all current
 * import sites (`import { MessageBubble }`) keep working unchanged.
 */
export const MessageBubble = memo(MessageBubbleImpl);

