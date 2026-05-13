import { useState } from 'react';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import type { ChatPrompt } from './sessionChatTypes';
import { DiffBlock } from './DiffBlock';

interface Props {
  msg: ChatPrompt;
  personaName: string;
  /** User's preferred inline diff layout, threaded down from SessionChatView. */
  diffView: 'unified' | 'split';
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
 */
export function MessageBubble({ msg, personaName, diffView, onRespond }: Props) {
  const [replyText, setReplyText] = useState('');
  const isUser = msg.source === 'user';
  const isAgentPending = msg.source === 'agent' && msg.status === 'pending';
  const author = isUser ? 'You' : personaName;
  const time = formatTime(msg.created_at);

  return (
    <div className={isUser ? 'msg-row msg-user' : 'msg-row msg-agent'}>
      <div className="msg-avatar" aria-hidden="true">
        {avatarGlyph(isUser, personaName)}
      </div>
      <div className="msg-body">
        <div className="msg-header">
          <span className="msg-author">{author}</span>
          <span className="msg-time">{time}</span>
          {msg.status && msg.status !== 'acknowledged' && msg.status !== 'responded' && (
            <span className={`msg-status msg-status-${msg.status}`}>{msg.status}</span>
          )}
        </div>
        <div className="msg-content">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={markdownComponents(diffView)}
          >
            {msg.prompt_text || ''}
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
  };
}

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
