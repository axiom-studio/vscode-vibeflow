import { useEffect, useRef, useState, useCallback } from 'react';
import { getVsCodeApi } from '../vscodeApi';
import { MessageBubble } from './sessionChat/MessageBubble';
import { SideRail } from './sessionChat/SideRail';
import type {
  ChatPrompt,
  LogEntry,
  SessionMeta,
  ChatHostMessage,
  ChatClientMessage,
} from './sessionChat/sessionChatTypes';
import './sessionChat/sessionChat.css';

const vscode = getVsCodeApi() as { postMessage: (msg: ChatClientMessage) => void };

/**
 * Top-level Session Chat panel. Replaces the inline-HTML render in
 * `src/views/sessions/SessionPanelManager.ts` (todo #1623). Layout:
 * chat fills the left 75%, side rail fills the right 25%. Chat
 * column hosts the message transcript + send box; rail surfaces
 * persona / model / branch / current task / progress / actions.
 *
 * Initial session metadata is read from `document.body.dataset.*`
 * (set by the host's getHtml). Live updates flow over postMessage.
 */
export function SessionChatView() {
  const initialMeta = readInitialMeta();
  const [meta, setMeta] = useState<SessionMeta>(initialMeta);
  const [messages, setMessages] = useState<ChatPrompt[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [showScrollDown, setShowScrollDown] = useState(false);
  // Side rail visibility — collapse to give chat the full width.
  // Persisted within the panel's life only; reload starts expanded.
  const [railOpen, setRailOpen] = useState(true);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  // Track whether the user is currently pinned to the bottom. Drives
  // auto-scroll-on-append + the visibility of the floating "scroll to
  // bottom" pill.
  const pinnedToBottomRef = useRef(true);

  // Host message subscription. Mirrors the SessionPanelHostMessage union
  // from the host's webviewMessages.ts.
  useEffect(() => {
    function handleMessage(ev: MessageEvent<ChatHostMessage>) {
      const m = ev.data;
      if (!m || typeof m !== 'object') { return; }
      switch (m.type) {
        case 'chatTranscript':
          setMessages(m.payload.messages);
          setHasMore(m.payload.hasMore);
          setLoading(false);
          setError(null);
          // Scroll to bottom on full replace.
          queueScrollToBottom();
          break;
        case 'chatAppend':
          setMessages(prev => mergeAppend(prev, m.payload.messages));
          if (pinnedToBottomRef.current) { queueScrollToBottom(); }
          break;
        case 'chatPrepend':
          setMessages(prev => mergePrepend(prev, m.payload.messages));
          setHasMore(m.payload.hasMore);
          break;
        case 'chatError':
          setError(m.payload.message);
          break;
        case 'chatPrefill':
          setDraft(m.payload.text);
          break;
        case 'update':
          if (m.payload.session) {
            setMeta(prev => ({ ...prev, ...(m.payload.session as Partial<SessionMeta>) }));
          }
          if (Array.isArray(m.payload.logs)) {
            setLogs(m.payload.logs);
          }
          break;
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  function queueScrollToBottom() {
    // Defer a frame so the DOM has the appended node.
    requestAnimationFrame(() => {
      const el = scrollerRef.current;
      if (!el) { return; }
      el.scrollTop = el.scrollHeight;
    });
  }

  const handleScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) { return; }
    const slack = 32; // px tolerance before we consider the user "scrolled up"
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < slack;
    pinnedToBottomRef.current = atBottom;
    setShowScrollDown(!atBottom);
  }, []);

  function send() {
    const text = draft.trim();
    if (!text) { return; }
    vscode.postMessage({ type: 'chatSend', payload: { text } });
    setDraft('');
  }

  function respond(promptId: string, text: string) {
    vscode.postMessage({ type: 'chatRespond', payload: { promptId, text } });
  }

  function loadOlder() {
    const oldest = messages[0];
    if (!oldest) { return; }
    vscode.postMessage({ type: 'chatLoadOlder', payload: { beforeId: oldest.id } });
  }

  function onTextareaKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd/Ctrl+Enter sends. Plain Enter inserts a newline so multi-line
    // prompts work without surprise sends.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className={`session-chat-root${railOpen ? '' : ' rail-collapsed'}`}>
      {/* Chat column (75% — full width when rail is collapsed) */}
      <div className="chat-column">
        <div className="chat-header">
          <div className="chat-header-title">
            <div className="chat-header-avatar">
              {meta.personaName.trim().charAt(0).toUpperCase() || 'A'}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="chat-header-name">{meta.personaName}</div>
              <div className="chat-header-meta">
                {meta.model}
                {meta.model && <span className="dot">·</span>}
                <span style={{ fontFamily: 'var(--vscode-editor-font-family)' }}>
                  ⎇ {meta.branch}
                </span>
                <span className="dot">·</span>
                <span style={{ textTransform: 'capitalize' }}>{meta.status}</span>
              </div>
            </div>
          </div>
          <button
            className="chat-header-toggle"
            onClick={() => setRailOpen(o => !o)}
            aria-label={railOpen ? 'Collapse side rail' : 'Expand side rail'}
          >
            {railOpen ? 'Hide details ›' : '‹ Show details'}
          </button>
        </div>

        {hasMore && (
          <div className="chat-load-older">
            <button onClick={loadOlder}>Load older messages</button>
          </div>
        )}

        <div
          className="chat-scroller"
          ref={scrollerRef}
          onScroll={handleScroll}
        >
          {loading ? (
            <div className="chat-loading">
              <div className="chat-skeleton" />
              <div className="chat-skeleton" />
              <div className="chat-skeleton" />
            </div>
          ) : messages.length === 0 ? (
            <EmptyState personaName={meta.personaName} />
          ) : (
            messages.map(msg => (
              <MessageBubble
                key={msg.id}
                msg={msg}
                personaName={meta.personaName}
                onRespond={respond}
              />
            ))
          )}
        </div>

        {showScrollDown && (
          <button
            className="chat-scroll-down"
            onClick={() => {
              pinnedToBottomRef.current = true;
              queueScrollToBottom();
            }}
            aria-label="Scroll to latest message"
          >
            ↓
          </button>
        )}

        {error && (
          <div className="chat-error">
            <span>{error}</span>
            <button onClick={() => setError(null)} aria-label="Dismiss">✕</button>
          </div>
        )}

        <div className="chat-input-row">
          <textarea
            className="chat-textarea"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={onTextareaKey}
            placeholder={`Message ${meta.personaName}…   (⌘/Ctrl+Enter to send)`}
            rows={2}
          />
          <button
            className="chat-send"
            onClick={send}
            disabled={!draft.trim()}
          >
            Send
          </button>
        </div>
      </div>

      {/* Side rail (25%) */}
      <SideRail
        meta={meta}
        logs={logs}
        onStop={() => vscode.postMessage({ type: 'stop' })}
        onRefresh={() => vscode.postMessage({ type: 'refresh' })}
      />
    </div>
  );
}

function EmptyState({ personaName }: { personaName: string }) {
  const glyph = personaName.trim().charAt(0).toUpperCase() || 'A';
  return (
    <div className="chat-empty">
      <div className="chat-empty-avatar">{glyph}</div>
      <div className="chat-empty-title">{personaName}</div>
      <div className="chat-empty-sub">
        Say hello or ask {personaName} to start on a work item.
      </div>
      <div className="chat-empty-hints">
        <div>Press <kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>Enter</kbd> to send</div>
      </div>
    </div>
  );
}

function readInitialMeta(): SessionMeta {
  const ds = document.body.dataset;
  const status = (ds.vfStatus as SessionMeta['status']) || 'inactive';
  return {
    sessionId: ds.vfSessionId ?? '',
    personaName: ds.vfPersonaName ?? 'Agent',
    personaKey: ds.vfPersonaKey ?? '',
    model: ds.vfModel ?? '',
    branch: ds.vfBranch ?? 'main',
    status: status === 'active' || status === 'stale' || status === 'inactive' ? status : 'inactive',
    taskTitle: ds.vfTaskTitle ?? '',
    taskStatus: ds.vfTaskStatus ?? '',
  };
}

function mergeAppend(prev: ChatPrompt[], incoming: ChatPrompt[]): ChatPrompt[] {
  if (incoming.length === 0) { return prev; }
  // Dedupe by id (the host's chatAppend can occasionally re-deliver
  // optimistic + poll-discovered duplicates for the same row).
  const seen = new Set(prev.map(p => p.id));
  const novel = incoming.filter(p => !seen.has(p.id));
  if (novel.length === 0) { return prev; }
  return [...prev, ...novel].sort((a, b) => a.id - b.id);
}

function mergePrepend(prev: ChatPrompt[], older: ChatPrompt[]): ChatPrompt[] {
  if (older.length === 0) { return prev; }
  const seen = new Set(prev.map(p => p.id));
  const novel = older.filter(p => !seen.has(p.id));
  return [...novel, ...prev].sort((a, b) => a.id - b.id);
}
