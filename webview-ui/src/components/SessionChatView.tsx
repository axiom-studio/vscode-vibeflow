import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { getVsCodeApi } from '../vscodeApi';
import { MessageBubble } from './sessionChat/MessageBubble';
import { SideRail } from './sessionChat/SideRail';
import { PersonaAvatar } from './sessionChat/PersonaAvatar';
import { MentionPicker } from './sessionChat/MentionPicker';
import { personaAvatarUrl } from '../personaAvatars';
import {
  MENTION_KINDS,
  applyMention,
  formatMentionToken,
  parseMentionState,
  type MentionKind,
  type MentionState,
} from './sessionChat/mentionParser';
import type {
  ChatPrompt,
  LogEntry,
  MentionItem,
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
  // User preference for how ```diff fences render inline in chat.
  // Seeded from the body data attribute the host stamps in getHtml,
  // live-updated when the host pushes an `update` carrying chatDiffView
  // (Settings → Session Defaults → Chat — Diff View).
  const [diffView, setDiffView] = useState<'unified' | 'split'>(readInitialDiffView());
  // axiomcloud base URL — used to resolve persona avatar portraits
  // (`{serverUrl}/persona/professional/{Char}_{Role}.jpg`). Stamped on
  // the body by the host on mount; never changes during a panel's life.
  const serverUrl = document.body.dataset.vfServerUrl ?? '';
  const personaAvatar = personaAvatarUrl(meta.personaKey, serverUrl);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Track whether the user is currently pinned to the bottom. Drives
  // auto-scroll-on-append + the visibility of the floating "scroll to
  // bottom" pill.
  const pinnedToBottomRef = useRef(true);

  // @mention picker state (todo #1614). `cursor` is the textarea
  // selectionStart snapshot taken on every change/keyup; combined with
  // `draft` it drives `mentionState`. `mentionResults` holds the latest
  // host response keyed by the most-recent requestId we've sent.
  // `selectedIndex` tracks the highlighted row (resets to 0 whenever the
  // visible list changes shape). `requestSeqRef` is monotonic; we drop
  // stale `chatMentionResults` whose echoed requestId is older.
  const [cursor, setCursor] = useState(0);
  const [mentionItems, setMentionItems] = useState<MentionItem[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const lastQuerySignatureRef = useRef<string>('');
  const requestSeqRef = useRef(0);
  const latestRequestIdRef = useRef(0);
  // Track the tokenStart the user dismissed via Escape. While the
  // cursor remains inside the same @-token, the picker stays closed
  // without erasing what they typed (matches VS Code / GitHub UX).
  // Cleared automatically once the user moves past the token or
  // starts a fresh @-token.
  const dismissedTokenStartRef = useRef<number>(-1);

  const rawMentionState: MentionState = useMemo(
    () => parseMentionState(draft, cursor),
    [draft, cursor],
  );

  // Apply the Escape-dismissal mask: same @-token, same start ⇒ keep closed.
  const mentionState: MentionState = (
    rawMentionState.active && dismissedTokenStartRef.current === rawMentionState.tokenStart
  )
    ? { active: false, tokenStart: -1, rawToken: '', query: '' }
    : rawMentionState;

  // Reset dismissal when the user starts a new @-token (different start)
  // or leaves any @-token entirely.
  useEffect(() => {
    if (!rawMentionState.active || rawMentionState.tokenStart !== dismissedTokenStartRef.current) {
      dismissedTokenStartRef.current = -1;
    }
  }, [rawMentionState.active, rawMentionState.tokenStart]);

  // List of options visible in the picker (kind chooser vs item list).
  // Used to bound selectedIndex during keyboard nav.
  const visibleOptionCount = mentionState.active
    ? (mentionState.kind === undefined
        ? (MENTION_KINDS as readonly MentionKind[]).filter(k =>
            mentionState.query === '' || k.startsWith(mentionState.query.toLowerCase()),
          ).length
        : mentionItems.length)
    : 0;

  // Reset selected index when the visible list changes shape.
  useEffect(() => {
    setSelectedIndex(0);
  }, [mentionState.kind, mentionState.query, mentionItems.length, mentionState.active]);

  // Issue a host query whenever the kind+query signature changes while
  // the picker is open. Skipping when `kind` is undefined (kind chooser
  // is purely client-side — no host involvement until a kind is picked).
  useEffect(() => {
    if (!mentionState.active || mentionState.kind === undefined) {
      // Picker closed or still on kind chooser — clear any prior items.
      if (mentionItems.length > 0) { setMentionItems([]); }
      if (mentionLoading) { setMentionLoading(false); }
      return;
    }
    const signature = `${mentionState.kind} ${mentionState.query}`;
    if (signature === lastQuerySignatureRef.current) { return; }
    lastQuerySignatureRef.current = signature;
    const requestId = ++requestSeqRef.current;
    latestRequestIdRef.current = requestId;
    setMentionLoading(true);
    vscode.postMessage({
      type: 'chatMentionQuery',
      payload: { requestId, kind: mentionState.kind, query: mentionState.query },
    });
  }, [mentionState.active, mentionState.kind, mentionState.query, mentionItems.length, mentionLoading]);

  function commitMention(index: number) {
    if (!mentionState.active) { return; }
    let token: string;
    if (mentionState.kind === undefined) {
      const filtered = (MENTION_KINDS as readonly MentionKind[]).filter(k =>
        mentionState.query === '' || k.startsWith(mentionState.query.toLowerCase()),
      );
      const k = filtered[index];
      if (!k) { return; }
      // Pre-seed the chosen kind by replacing the @-token with `@kind:`.
      const before = draft.slice(0, mentionState.tokenStart);
      // Walk to the end of the current @-token in the source.
      let end = mentionState.tokenStart + 1;
      while (end < draft.length) {
        const ch = draft[end];
        if (ch === ' ' || ch === '\n' || ch === '\t' || ch === ')' || ch === ']') { break; }
        end++;
      }
      const after = draft.slice(end);
      const inserted = `@${k}:`;
      const next = before + inserted + after;
      const caret = before.length + inserted.length;
      setDraft(next);
      // Reset list state for the new kind; the host query effect
      // will refire on the next render because (kind, query) changes.
      setMentionItems([]);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) { return; }
        el.focus();
        el.setSelectionRange(caret, caret);
        setCursor(caret);
      });
      return;
    }
    const item = mentionItems[index];
    if (!item) { return; }
    token = formatMentionToken(mentionState.kind, item.id, item.name);
    const { next, caret } = applyMention(draft, mentionState, token);
    setDraft(next);
    setMentionItems([]);
    lastQuerySignatureRef.current = '';
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) { return; }
      el.focus();
      el.setSelectionRange(caret, caret);
      setCursor(caret);
    });
  }

  function dismissMention() {
    // Close the picker without modifying the text — the user keeps
    // whatever @-token they were typing (it becomes literal text).
    // The mask is keyed on tokenStart, so starting a new @-token
    // reopens the picker automatically.
    if (!rawMentionState.active) { return; }
    dismissedTokenStartRef.current = rawMentionState.tokenStart;
    setMentionItems([]);
    lastQuerySignatureRef.current = '';
    setMentionLoading(false);
  }

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
        case 'chatMentionResults': {
          // Drop stale results — only the latest in-flight requestId wins.
          if (m.payload.requestId !== latestRequestIdRef.current) { break; }
          setMentionItems(m.payload.items);
          setMentionLoading(false);
          break;
        }
        case 'update':
          if (m.payload.session) {
            setMeta(prev => ({ ...prev, ...(m.payload.session as Partial<SessionMeta>) }));
          }
          if (Array.isArray(m.payload.logs)) {
            setLogs(m.payload.logs);
          }
          if (m.payload.chatDiffView === 'unified' || m.payload.chatDiffView === 'split') {
            setDiffView(m.payload.chatDiffView);
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
    // While the @mention picker is open, hijack Arrow/Enter/Escape so
    // the textarea doesn't act on them. Enter no longer sends; it
    // commits the highlighted picker row (todo #1614).
    if (mentionState.active && visibleOptionCount > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(i => (i + 1) % visibleOptionCount);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(i => (i - 1 + visibleOptionCount) % visibleOptionCount);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        commitMention(selectedIndex);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        dismissMention();
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        commitMention(selectedIndex);
        return;
      }
    }
    // Plain Enter sends, Shift+Enter inserts a newline (Slack/Discord
    // /ChatGPT convention). Avoids the Cmd+Enter collision with
    // extensions like LeetCode that bind Cmd+Enter globally — webview
    // keyboard events propagate to VS Code's keybinding service even
    // after preventDefault, so the only reliable way to dodge the
    // collision is to not use Cmd+Enter at all.
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      send();
    }
  }

  function snapshotCursor() {
    const el = textareaRef.current;
    if (!el) { return; }
    setCursor(el.selectionStart);
  }

  return (
    <div className={`session-chat-root${railOpen ? '' : ' rail-collapsed'}`}>
      {/* Chat column (75% — full width when rail is collapsed) */}
      <div className="chat-column">
        <div className="chat-header">
          <div className="chat-header-title">
            <PersonaAvatar
              className="chat-header-avatar"
              src={personaAvatar}
              fallbackGlyph={meta.personaName.trim().charAt(0).toUpperCase() || 'A'}
            />
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
            <EmptyState personaName={meta.personaName} personaAvatarUrl={personaAvatar} />
          ) : (
            messages.map(msg => (
              <MessageBubble
                key={msg.id}
                msg={msg}
                personaName={meta.personaName}
                personaAvatarUrl={personaAvatar}
                diffView={diffView}
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
          <div className="chat-textarea-wrap">
            <MentionPicker
              state={mentionState}
              items={mentionItems}
              selectedIndex={selectedIndex}
              loading={mentionLoading}
              onPick={commitMention}
              onHoverIndex={setSelectedIndex}
            />
            <textarea
              ref={textareaRef}
              className="chat-textarea"
              value={draft}
              onChange={e => {
                setDraft(e.target.value);
                // Cursor moves with the change; snapshot after React
                // applies the new value (selectionStart reflects post-edit).
                snapshotCursor();
              }}
              onKeyUp={snapshotCursor}
              onClick={snapshotCursor}
              onSelect={snapshotCursor}
              onKeyDown={onTextareaKey}
              placeholder={`Message ${meta.personaName}…   (Enter to send · Shift+Enter for newline · @ to mention)`}
              rows={2}
            />
          </div>
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
        personaAvatarUrl={personaAvatar}
        onStop={() => vscode.postMessage({ type: 'stop' })}
        onRefresh={() => vscode.postMessage({ type: 'refresh' })}
      />
    </div>
  );
}

function EmptyState({ personaName, personaAvatarUrl }: { personaName: string; personaAvatarUrl?: string }) {
  const glyph = personaName.trim().charAt(0).toUpperCase() || 'A';
  return (
    <div className="chat-empty">
      <PersonaAvatar
        className="chat-empty-avatar"
        src={personaAvatarUrl}
        fallbackGlyph={glyph}
      />
      <div className="chat-empty-title">{personaName}</div>
      <div className="chat-empty-sub">
        Say hello or ask {personaName} to start on a work item.
      </div>
      <div className="chat-empty-hints">
        <div>Press <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for newline</div>
      </div>
    </div>
  );
}

function readInitialDiffView(): 'unified' | 'split' {
  const v = document.body.dataset.vfDiffView;
  return v === 'split' ? 'split' : 'unified';
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
