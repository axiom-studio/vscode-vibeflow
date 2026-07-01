import { useDeferredValue, useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react';
import { getVsCodeApi } from '../vscodeApi';
import { MessageBubble } from './sessionChat/MessageBubble';
import { SideRail } from './sessionChat/SideRail';
import { PersonaAvatar } from './sessionChat/PersonaAvatar';
import { MentionPicker } from './sessionChat/MentionPicker';
import { personaAvatarUrl } from '../personaAvatars';
import { PERSONA_COLORS } from '../types';
import {
  ArrowDownIcon,
  ChevronIcon,
  GitBranchIcon,
  PaperPlaneIcon,
  PaperclipIcon,
  SpinnerIcon,
  XIcon,
  EyeIcon,
} from './_shared/icons';
import { useChatAttachments, type PendingUpload } from './sessionChat/useChatAttachments';
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
  // `useDeferredValue` (#2330): lets React paint a textarea keystroke
  // immediately and re-render the transcript on the NEXT idle paint
  // when there are many messages. The textarea's draft state lives in
  // `draft` (set in the textarea's onChange) — that stays priority;
  // the transcript-list re-render lags behind by one frame, which is
  // imperceptible for the user typing but eliminates the dropped-frame
  // path when the message list is long.
  const deferredMessages = useDeferredValue(messages);

  // Inline "Working…" affordance (#2704): while an agent reply is pending,
  // also show a compact working indicator on the most-recent user message —
  // in addition to the existing standalone pending-agent row. Both read the
  // same pending state, so they clear together the moment the reply lands.
  // Recomputes only when the message list changes (never per keystroke), so
  // the value passed to the memoized MessageBubble stays stable while typing.
  const pendingSince = useMemo(() => {
    const p = deferredMessages.find(m => m.source === 'agent' && m.status === 'pending');
    return p ? p.created_at : undefined;
  }, [deferredMessages]);
  const lastUserIndex = useMemo(() => {
    for (let i = deferredMessages.length - 1; i >= 0; i--) {
      if (deferredMessages[i].source === 'user') { return i; }
    }
    return -1;
  }, [deferredMessages]);
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
  const [showTmuxButton, setShowTmuxButton] = useState<boolean>(readInitialShowTmuxButton());
  // axiomcloud base URL — used to resolve persona avatar portraits
  // (`{serverUrl}/persona/professional/{Char}_{Role}.jpg`). Stamped on
  // the body by the host on mount; never changes during a panel's life.
  const serverUrl = document.body.dataset.vfServerUrl ?? '';
  const personaAvatar = personaAvatarUrl(meta.personaKey, serverUrl);
  const personaColor = PERSONA_COLORS[meta.personaKey] ?? 'var(--vscode-textLink-foreground)';

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Track whether the user is currently pinned to the bottom. Drives
  // auto-scroll-on-append + the visibility of the floating "scroll to
  // bottom" pill.
  const pinnedToBottomRef = useRef(true);

  // Load-older infinite scroll (#2711). `loadingOlder` gates the fetch and
  // drives the "Loading older messages…" indicator. `prependAnchorRef` holds
  // the scroller height captured just before a prepend commits; the layout
  // effect below adds the height that grew at the top so inserting older rows
  // above the viewport doesn't make it jump. `prevFirstIdRef` distinguishes a
  // prepend (first id changes) from a racing append (bottom grows, first id
  // unchanged) so only a real prepend triggers the restore.
  const [loadingOlder, setLoadingOlder] = useState(false);
  const prependAnchorRef = useRef<number | null>(null);
  const prevFirstIdRef = useRef<number | undefined>(undefined);
  // Set on a full-replace `chatTranscript` (#2712): the first transcript must
  // open ALREADY pinned to the bottom. Doing it here in the layout effect
  // (pre-paint) avoids the visible top→bottom jump the rAF scroll caused on
  // panel open.
  const initialScrollPendingRef = useRef(false);

  useLayoutEffect(() => {
    const first = deferredMessages[0]?.id;
    const el = scrollerRef.current;
    if (initialScrollPendingRef.current && el && deferredMessages.length > 0) {
      // Initial / full-replace transcript — jump to the bottom before paint so
      // the panel opens at the bottom with no visible scroll. Guarded on a
      // non-empty list so an intermediate empty deferredMessages (useDeferred-
      // Value lag) doesn't clear the flag prematurely.
      el.scrollTop = el.scrollHeight;
      pinnedToBottomRef.current = true;
      setShowScrollDown(false);
      initialScrollPendingRef.current = false;
    } else {
      // Older messages prepended → keep the viewport stable.
      const anchor = prependAnchorRef.current;
      if (
        anchor !== null &&
        prevFirstIdRef.current !== undefined &&
        first !== undefined &&
        first !== prevFirstIdRef.current &&
        el
      ) {
        el.scrollTop += el.scrollHeight - anchor;
        prependAnchorRef.current = null;
      }
    }
    prevFirstIdRef.current = first;
  }, [deferredMessages]);

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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const { pending: pendingUploads, attachFiles, dismiss: dismissUpload } = useChatAttachments({
    appendToDraft: useCallback((token: string) => {
      setDraft(prev => prev.length === 0 || /\s$/.test(prev) ? `${prev}${token} ` : `${prev} ${token} `);
    }, []),
  });
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
  //
  // **Debounced by 200ms** (#2330 fix 3/3): a fast typist after picking
  // a kind otherwise fires one postMessage round-trip per keystroke,
  // each hitting the VibeFlow Cloud REST endpoint via
  // `client.listDocuments / listFeatures / ...`. The host responds
  // asynchronously, but the postMessage write itself + the React
  // re-render triggered by `setMentionLoading(true)` block the keystroke.
  // 200ms is "feels instant" for a typist (~3-5 chars per debounce
  // window typically) while collapsing N postMessages into 1. The
  // monotonic `requestId` echo already drops stale results if a query
  // races; the debounce just stops them from being issued in the first
  // place. Reverting THIS commit alone restores per-keystroke fetch.
  useEffect(() => {
    if (!mentionState.active || mentionState.kind === undefined) {
      // Picker closed or still on kind chooser — clear any prior items.
      if (mentionItems.length > 0) { setMentionItems([]); }
      if (mentionLoading) { setMentionLoading(false); }
      return;
    }
    const signature = `${mentionState.kind} ${mentionState.query}`;
    if (signature === lastQuerySignatureRef.current) { return; }
    // Capture the kind+query NOW; the closure that runs after the
    // debounce window may see a stale mentionState if the user has
    // since typed more characters (in which case THIS effect run will
    // be superseded by a new one whose timeout cancels this one).
    const kind = mentionState.kind;
    const query = mentionState.query;
    setMentionLoading(true);
    const timer = window.setTimeout(() => {
      lastQuerySignatureRef.current = signature;
      const requestId = ++requestSeqRef.current;
      latestRequestIdRef.current = requestId;
      vscode.postMessage({
        type: 'chatMentionQuery',
        payload: { requestId, kind, query },
      });
    }, 200);
    return () => window.clearTimeout(timer);
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
          // Open at the bottom on full replace, but do the scroll PRE-paint in
          // the layout effect (not the rAF queueScrollToBottom) so the panel
          // doesn't visibly render from the top and then jump down (#2712).
          initialScrollPendingRef.current = true;
          break;
        case 'chatAppend':
          setMessages(prev => mergeAppend(prev, m.payload.messages));
          if (pinnedToBottomRef.current) { queueScrollToBottom(); }
          break;
        case 'chatPrepend':
          if (m.payload.messages.length > 0) {
            // Capture scroll height BEFORE the prepend commits so the layout
            // effect can keep the viewport stable once older rows render.
            prependAnchorRef.current = scrollerRef.current?.scrollHeight ?? null;
            setMessages(prev => mergePrepend(prev, m.payload.messages));
          }
          setHasMore(m.payload.hasMore);
          setLoadingOlder(false);
          break;
        case 'chatError':
          setError(m.payload.message);
          // A terminal error releases the loading skeleton — otherwise an
          // initial-load failure (host posts chatError, never chatTranscript)
          // would leave the skeleton covering the error banner forever.
          setLoading(false);
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
          if (typeof m.payload.showTmuxButton === 'boolean') {
            setShowTmuxButton(m.payload.showTmuxButton);
          }
          break;
      }
    }
    window.addEventListener('message', handleMessage);
    // Handshake: tell the host we're listening now. The host (re)sends the
    // initial chatTranscript in response, which clears the loading skeleton.
    // Without this, the host's panel-creation-time transcript post can land
    // before this listener exists and be dropped — VS Code's postMessage
    // buffering hides the race, but Cursor's service-worker-gated webview
    // bootstrap exposes it as a skeleton that never resolves.
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  function queueScrollToBottom(smooth = false) {
    // Defer a frame so the DOM has the appended node. `smooth` is opt-in
    // — pass true when the user explicitly clicked the jump-to-bottom
    // button. First-paint history dumps and live appends stay instant
    // to avoid animating a 500-entry scroll on every panel open.
    requestAnimationFrame(() => {
      const el = scrollerRef.current;
      if (!el) { return; }
      if (smooth && typeof el.scrollTo === 'function') {
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      } else {
        el.scrollTop = el.scrollHeight;
      }
    });
  }

  // Not memoized: it reads `hasMore`/`loadingOlder`/`messages` for the
  // auto-load trigger and is only wired to the scroller's onScroll (never
  // passed to the memoized transcript rows), so recreating it per render is
  // free and avoids stale-closure bugs.
  function handleScroll() {
    const el = scrollerRef.current;
    if (!el) { return; }
    const slack = 32; // px tolerance before we consider the user "scrolled up"
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < slack;
    pinnedToBottomRef.current = atBottom;
    setShowScrollDown(!atBottom);
    // Auto-load older history when the user scrolls near the top (#2711).
    if (el.scrollTop < 120 && hasMore && !loadingOlder) {
      loadOlder();
    }
  }

  function send() {
    const text = draft.trim();
    if (!text) { return; }
    vscode.postMessage({ type: 'chatSend', payload: { text } });
    setDraft('');
  }

  // Stable across renders (`vscode` is a module-level const ⇒ empty deps).
  // This stability is load-bearing: `respond` is passed as `onRespond` to
  // every <MessageBubble>, which is React.memo'd with default shallow
  // equality. A fresh reference each render would bust that memo and
  // re-run react-markdown + rehype-highlight for the whole transcript on
  // every keystroke into the chat textarea (the #2330 lag class). See the
  // MessageBubbleImpl doc-comment.
  const respond = useCallback((promptId: string, text: string) => {
    vscode.postMessage({ type: 'chatRespond', payload: { promptId, text } });
  }, []);

  // Stable callbacks for the memoized <SideRail> (#591). Inline arrows
  // here would give the rail a fresh prop reference each render, busting
  // its React.memo and re-rendering the activity ledger on every chat
  // keystroke.
  const handleStop = useCallback(() => vscode.postMessage({ type: 'stop' }), []);
  const handleRefresh = useCallback(() => vscode.postMessage({ type: 'refresh' }), []);

  function loadOlder() {
    const oldest = messages[0];
    if (!oldest || loadingOlder || !hasMore) { return; }
    setLoadingOlder(true);
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
    <div
      className={`session-chat-root${railOpen ? '' : ' rail-collapsed'}${
        meta.sessionMode === 'chat_first' ? ' no-rail' : ''
      }`}
    >
      {/* Chat column (75% — full width when rail is collapsed) */}
      <div className="chat-column">
        <div className="chat-header">
          <div className="chat-header-title">
            <PersonaAvatar
              className="chat-header-avatar"
              src={personaAvatar}
              fallbackGlyph={meta.personaName.trim().charAt(0).toUpperCase() || 'A'}
              fallbackColor={personaColor}
            />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="chat-header-name">{meta.personaName}</div>
              {/*
                Header meta line is verbose by default (model · branch ·
                status) — useful in vanilla/vibeflow sessions where the
                rail also shows that data and the header chip is a
                redundant glance.

                In chat-first mode there's no rail, the agent is purely
                conversational, and branch/model don't change mid-chat.
                Collapsing the meta to a single subdued status pill keeps
                the header focused on persona identity without burdening
                a wide chat panel with breadcrumb noise. #2348.
              */}
              {meta.sessionMode === 'chat_first' ? (
                <div className="chat-header-meta chat-header-meta-minimal">
                  <span
                    className={`chat-header-status chat-header-status-${meta.status}`}
                    aria-hidden
                  />
                  <span style={{ textTransform: 'capitalize' }}>{meta.status}</span>
                </div>
              ) : (
                <div className="chat-header-meta">
                  {meta.model && (
                    <>
                      <span>{meta.model}</span>
                      <span className="divider" aria-hidden />
                    </>
                  )}
                  <span className="chat-header-branch">
                    <GitBranchIcon size={11} />
                    <span style={{ fontFamily: 'var(--vscode-editor-font-family)' }}>{meta.branch}</span>
                  </span>
                  <span className="divider" aria-hidden />
                  <span style={{ textTransform: 'capitalize' }}>{meta.status}</span>
                </div>
              )}
            </div>
          </div>
          {/*
            Show/Hide details toggle: only render when the side rail
            itself is rendered (i.e. NOT in chat-first mode). See the
            <SideRail> render guard below + issue #2329 for the design call.
          */}
          {meta.sessionMode !== 'chat_first' && (
            <button
              className="chat-header-toggle"
              onClick={() => setRailOpen(o => !o)}
              aria-label={railOpen ? 'Collapse side rail' : 'Expand side rail'}
            >
              <span>{railOpen ? 'Hide details' : 'Show details'}</span>
              <span
                className="chat-header-toggle-chevron"
                style={{ transform: railOpen ? 'rotate(0deg)' : 'rotate(180deg)' }}
              >
                <ChevronIcon size={11} />
              </span>
            </button>
          )}
          {/* Chat-first: watch this agent live by opening its shell in a terminal (#2059). */}
          {meta.sessionMode === 'chat_first' && showTmuxButton && (
            <button
              className="chat-header-toggle chat-header-tmux"
              onClick={() => vscode.postMessage({ type: 'chatOpenTmux' })}
              title="Watch this agent live — open its shell in a terminal to follow the raw exchange"
              aria-label="Watch this agent's live shell in a terminal"
            >
              <EyeIcon size={13} />
            </button>
          )}
        </div>

        {(loadingOlder || hasMore) && (
          <div className="chat-load-older">
            {loadingOlder ? (
              <span className="chat-load-older-loading" role="status">
                <SpinnerIcon size={12} />
                Loading older messages…
              </span>
            ) : (
              <button onClick={loadOlder}>Load older messages</button>
            )}
          </div>
        )}

        <div
          className="chat-scroller"
          ref={scrollerRef}
          onScroll={handleScroll}
        >
          {loading ? (
            <div className="chat-loading">
              <div className="chat-skeleton shimmer" />
              <div className="chat-skeleton shimmer" />
              <div className="chat-skeleton shimmer" />
            </div>
          ) : messages.length === 0 ? (
            <EmptyState
              personaName={meta.personaName}
              personaAvatarUrl={personaAvatar}
              personaColor={personaColor}
              sessionMode={meta.sessionMode}
              onUseExample={(text) => {
                setDraft(text);
                // Defer focus to next frame so the textarea exists in the
                // DOM after the empty state unmounts on the first send;
                // before that, the user just gets the pre-filled draft.
                requestAnimationFrame(() => textareaRef.current?.focus());
              }}
            />
          ) : (
            /*
              Transcript rendering is the hot loop on every keystroke into
              the chat textarea (each <MessageBubble> runs react-markdown
              + rehype-highlight even with memo if msg refs change). React 19
              `useDeferredValue` marks the messages prop as low-priority so
              the textarea paint can run first; the transcript catches up on
              the next idle paint. Memo on MessageBubble (see fix 1/3) keeps
              the deferred re-render cheap when only a few bubbles changed.
              Refs #2330 (chat input lag investigation).
            */
            deferredMessages.map((msg, i) => (
              <MessageBubble
                key={msg.id}
                msg={msg}
                // First message of a same-sender run — only the group's first
                // row renders the persona/You header, collapsing the repeated
                // "Security Lead · RESPONSE" stack into one conversational group.
                groupStart={i === 0 || deferredMessages[i - 1].source !== msg.source}
                personaName={meta.personaName}
                personaAvatarUrl={personaAvatar}
                personaColor={personaColor}
                diffView={diffView}
                sessionMode={meta.sessionMode}
                onRespond={respond}
                inlineWorkingSince={pendingSince && i === lastUserIndex ? pendingSince : undefined}
              />
            ))
          )}
        </div>

        {showScrollDown && (
          <button
            className="chat-scroll-down"
            onClick={() => {
              pinnedToBottomRef.current = true;
              queueScrollToBottom(true);
            }}
            aria-label="Scroll to latest message"
          >
            <ArrowDownIcon size={16} />
          </button>
        )}

        {error && (
          <div className="chat-error">
            <span>{error}</span>
            <button onClick={() => setError(null)} aria-label="Dismiss">
              <XIcon size={13} />
            </button>
          </div>
        )}

        <div className="chat-input-area">
          {pendingUploads.length > 0 && (
            <PendingUploadsStrip uploads={pendingUploads} onDismiss={dismissUpload} />
          )}
          <div className="chat-input-row">
            <div
              className={`chat-textarea-wrap${dragOver ? ' is-drag-over' : ''}`}
              onDragOver={e => {
                if (e.dataTransfer?.types?.includes('Files')) {
                  e.preventDefault();
                  e.stopPropagation();
                  if (!dragOver) { setDragOver(true); }
                }
              }}
              onDragLeave={e => {
                // Only un-set when leaving the wrap entirely, not when
                // crossing into a child element.
                if (e.currentTarget === e.target) { setDragOver(false); }
              }}
              onDrop={e => {
                if (e.dataTransfer?.files?.length) {
                  e.preventDefault();
                  e.stopPropagation();
                  setDragOver(false);
                  void attachFiles(e.dataTransfer.files);
                }
              }}
            >
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
                onPaste={e => {
                  // Pull image / file items off the clipboard. Plain
                  // text paste goes through the default behavior (we
                  // only `preventDefault` if we actually found files).
                  const items = e.clipboardData?.items;
                  if (!items) { return; }
                  const files: File[] = [];
                  for (let i = 0; i < items.length; i++) {
                    const item = items[i];
                    if (item.kind === 'file') {
                      const f = item.getAsFile();
                      if (f) { files.push(f); }
                    }
                  }
                  if (files.length > 0) {
                    e.preventDefault();
                    void attachFiles(files);
                  }
                }}
                placeholder={`Message ${meta.personaName}…`}
                rows={2}
              />
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={e => {
                const files = e.target.files;
                if (files && files.length > 0) { void attachFiles(files); }
                // Reset so picking the same file twice in a row still fires onChange.
                e.target.value = '';
              }}
            />
            <button
              className="chat-attach"
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach files"
              title="Attach files (or paste / drag onto the input)"
            >
              <PaperclipIcon size={13} />
            </button>
            <button
              className="chat-send"
              onClick={send}
              disabled={!draft.trim() || pendingUploads.some(p => p.status === 'uploading')}
              title={pendingUploads.some(p => p.status === 'uploading') ? 'Wait for uploads to finish' : undefined}
            >
              <PaperPlaneIcon size={13} />
              <span>Send</span>
            </button>
          </div>
          <div className="chat-input-hints" aria-hidden>
            <kbd>Enter</kbd> to send
            <span className="divider" />
            <kbd>Shift</kbd>+<kbd>Enter</kbd> for newline
            <span className="divider" />
            <kbd>@</kbd> to mention
            <span className="divider" />
            <kbd>Paste</kbd> / drag / <kbd>+</kbd> to attach
          </div>
        </div>
      </div>

      {/*
        Side rail (25%) — hidden entirely in chat-first mode (#2329).
        The rail surfaces work-item state (persona / current task /
        activity ledger) that chat-first agents don't populate; the
        toggle button above is also hidden so there's nothing left to
        toggle. Vanilla + vibeflow YOLO sessions get the rail as before.
      */}
      {meta.sessionMode !== 'chat_first' && (
        <SideRail
          meta={meta}
          logs={logs}
          personaAvatarUrl={personaAvatar}
          onStop={handleStop}
          onRefresh={handleRefresh}
        />
      )}
    </div>
  );
}

/**
 * Pending-upload chips strip (#1670). Sits above the textarea while
 * uploads are in flight. Each chip is a thumbnail/icon + filename +
 * size + a status indicator (spinner or error text) + a dismiss `×`.
 * Successful uploads disappear from the strip (the token is appended
 * to the draft instead).
 */
function PendingUploadsStrip({ uploads, onDismiss }: {
  uploads: PendingUpload[];
  onDismiss: (clientId: string) => void;
}) {
  return (
    <div className="chat-attachment-strip" role="status">
      {uploads.map(upload => (
        <div
          key={upload.clientId}
          className={`chat-attachment-chip${upload.status === 'error' ? ' is-error' : ''}`}
          title={upload.errorMessage ?? upload.name}
        >
          {upload.status === 'uploading' && <SpinnerIcon size={12} />}
          {upload.status === 'error' && <span className="chat-attachment-error-icon" aria-hidden>!</span>}
          <span className="chat-attachment-name">{upload.name}</span>
          <span className="chat-attachment-size">{formatBytes(upload.size)}</span>
          <button
            type="button"
            className="chat-attachment-dismiss"
            onClick={() => onDismiss(upload.clientId)}
            aria-label={`Dismiss ${upload.name}`}
          >
            <XIcon size={10} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Compact size formatter for the attachment chip. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) { return `${bytes} B`; }
  if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function EmptyState({ personaName, personaAvatarUrl, personaColor, sessionMode, onUseExample }: {
  personaName: string;
  personaAvatarUrl?: string;
  personaColor?: string;
  sessionMode: SessionMeta['sessionMode'];
  /** Pre-fill the chat textarea with an example prompt + focus it. */
  onUseExample: (text: string) => void;
}) {
  const glyph = personaName.trim().charAt(0).toUpperCase() || 'A';
  // Mode-aware cold-start copy + prompts.
  //
  // vanilla / vibeflow modes: agent is terminal-driven and picks up
  // tracked work items via `wait_for_work`. The chat is for status
  // queries and work-item-attached questions.
  //
  // chat_first: agent IS the chat. No `wait_for_work` polling, no
  // work-item attachment requirement — every message gets a reply.
  // Cold-start copy reflects that: "ask anything", not "start on a
  // work item".
  const isChatFirst = sessionMode === 'chat_first';
  const subCopy = isChatFirst
    ? `Ask ${personaName} anything.`
    : `Say hello or ask ${personaName} to start on a work item.`;
  const examples = isChatFirst
    ? [
        `Walk me through this codebase.`,
        `What would you change first?`,
        `Find the bug in the last commit.`,
      ]
    : [
        `What are you working on?`,
        `Pick up the next ready issue.`,
        `Review the diff on this branch.`,
      ];
  return (
    <div className={`chat-empty${isChatFirst ? ' chat-empty-chat-first' : ''}`}>
      <PersonaAvatar
        className="chat-empty-avatar"
        src={personaAvatarUrl}
        fallbackGlyph={glyph}
        fallbackColor={personaColor}
      />
      <div className="chat-empty-title">{personaName}</div>
      <div className="chat-empty-sub">{subCopy}</div>
      <div className="chat-empty-chips" role="group" aria-label="Example prompts">
        {examples.map((text) => (
          <button
            key={text}
            type="button"
            className="chat-empty-chip"
            onClick={() => onUseExample(text)}
          >
            {text}
          </button>
        ))}
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

function readInitialShowTmuxButton(): boolean {
  // Default ON (#2059); only an explicit "false" data attribute hides it.
  return document.body.dataset.vfShowTmuxButton !== 'false';
}

function readInitialMeta(): SessionMeta {
  const ds = document.body.dataset;
  const status = (ds.vfStatus as SessionMeta['status']) || 'inactive';
  const rawMode = ds.vfSessionMode;
  const sessionMode: SessionMeta['sessionMode'] =
    rawMode === 'chat_first' || rawMode === 'vibeflow' || rawMode === 'vanilla'
      ? rawMode
      : 'vanilla';
  return {
    sessionId: ds.vfSessionId ?? '',
    personaName: ds.vfPersonaName ?? 'Agent',
    personaKey: ds.vfPersonaKey ?? '',
    model: ds.vfModel ?? '',
    branch: ds.vfBranch ?? 'main',
    status: status === 'active' || status === 'stale' || status === 'inactive' ? status : 'inactive',
    taskTitle: ds.vfTaskTitle ?? '',
    taskStatus: ds.vfTaskStatus ?? '',
    sessionMode,
  };
}

/**
 * Two prompts render identically when the fields the chat UI shows are
 * equal. The host re-fetches still-pending rows every poll (to catch the
 * pending→responded flip); they arrive as fresh deserialized objects with
 * NEW references but unchanged content. Treating those as a no-op (keeping
 * the existing object reference) is what lets MessageBubble's React.memo
 * actually hold instead of re-rendering — and re-flashing an inline image
 * AssetCard (spinner → reload) — every 5s while a message is pending (#3199).
 */
function samePromptRender(a: ChatPrompt, b: ChatPrompt): boolean {
  return a.status === b.status
    && a.response_text === b.response_text
    && a.responded_at === b.responded_at
    && a.updated_at === b.updated_at;
}

function mergeAppend(prev: ChatPrompt[], incoming: ChatPrompt[]): ChatPrompt[] {
  if (incoming.length === 0) { return prev; }
  // Upsert by id. The host re-fetches the recent window when a prompt
  // is still pending so the chip can transition from "Working…" to the
  // agent's response (the row stays at the same id; only response_text
  // / status flip). Replacing existing entries instead of dropping them
  // is what makes that transition appear. Optimistic local sends pass
  // through with the same id from createPrompt so the upsert is a no-op
  // (or a refresh) rather than a duplicate.
  const incomingById = new Map(incoming.map(p => [p.id, p]));
  let changed = false;
  const updated = prev.map(p => {
    const fresh = incomingById.get(p.id);
    if (!fresh) { return p; }
    incomingById.delete(p.id);
    // Preserve the existing reference when nothing the UI renders changed, so
    // the periodic pending-row re-fetch doesn't bust MessageBubble's memo (and
    // re-flash inline images) every poll. Only swap in `fresh` on a real
    // change (e.g. pending→responded, new response_text) — #3199.
    if (fresh === p || samePromptRender(p, fresh)) { return p; }
    changed = true;
    return fresh;
  });
  const novel = Array.from(incomingById.values());
  if (!changed && novel.length === 0) { return prev; }
  return [...updated, ...novel].sort((a, b) => a.id - b.id);
}

function mergePrepend(prev: ChatPrompt[], older: ChatPrompt[]): ChatPrompt[] {
  if (older.length === 0) { return prev; }
  const seen = new Set(prev.map(p => p.id));
  const novel = older.filter(p => !seen.has(p.id));
  return [...novel, ...prev].sort((a, b) => a.id - b.id);
}
