import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import type { ChatPrompt } from './sessionChatTypes';

interface Props {
  msg: ChatPrompt;
  personaName: string;
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
export function MessageBubble({ msg, personaName, onRespond }: Props) {
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
            components={{
              a: ({ href, children }) => (
                <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
              ),
              table: ({ children }) => (
                <div style={{ overflowX: 'auto' }}><table>{children}</table></div>
              ),
            }}
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
