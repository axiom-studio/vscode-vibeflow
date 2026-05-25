// Shared types for the Session Chat React panel. Mirrors the host
// SessionPanelHostMessage / SessionPanelClientMessage from
// src/core/webviewMessages.ts — kept narrow here so the React side
// doesn't have to import host-only types.

export type PromptStatus = 'pending' | 'responded' | 'acknowledged' | 'expired';
export type PromptSource = 'agent' | 'user';

export interface ChatPrompt {
  id: number;
  created_at: string;
  updated_at: string;
  prompt_id: string;
  prompt_text: string;
  response_text: string;
  status: PromptStatus;
  responded_at: string | null;
  source: PromptSource;
  message_type?: string;
  work_item_type?: string;
  work_item_id?: number;
}

export interface LogEntry {
  text: string;
  /** ISO timestamp. */
  time?: string;
  /** Origin tag — 'todo' | 'issue' | 'session'. */
  src?: string;
}

/**
 * Per-launch session mode (#2329). Mirrors the host `SESSION_MODES`
 * value set in `src/commands/sessionCommands.ts`. The webview uses
 * this to drive mode-aware UI (today: hides Current Task + Activity
 * rail blocks when `'chat_first'` because those blocks read from
 * work-item state that chat-first agents never populate).
 *
 * Fallback for sessions whose mode is unknown is always `'vanilla'`
 * (host-side `resolveSessionMode`) — preserves pre-#2329 behavior
 * for older launches and reattached-without-launchModeStore-entry
 * sessions.
 */
export type SessionMode = 'vanilla' | 'vibeflow' | 'chat_first';

export interface SessionMeta {
  sessionId: string;
  personaName: string;
  personaKey: string;
  model: string;
  branch: string;
  status: 'active' | 'stale' | 'inactive';
  taskTitle: string;
  taskStatus: string;
  /** Per-launch session mode (#2329). Defaults to 'vanilla'. */
  sessionMode: SessionMode;
}

// One row of the @mention picker (todo #1614). Host resolves the
// kind-specific list (vibeflow entities via REST, or VS Code workspace
// symbols via LSP) and the React picker renders one row per item.
// `id` is type-mixed: numeric for vibeflow entities, string
// `<relativePath>#<line>` for workspace symbols. The token formatter
// handles both cleanly.
export interface MentionItem {
  id: number | string;
  name: string;
  /** Optional secondary text (status, parent, etc.). Plain text only. */
  detail?: string;
}

// Host → webview
export type ChatHostMessage =
  | { type: 'chatTranscript'; payload: { messages: ChatPrompt[]; hasMore: boolean } }
  | { type: 'chatAppend'; payload: { messages: ChatPrompt[] } }
  | { type: 'chatPrepend'; payload: { messages: ChatPrompt[]; hasMore: boolean } }
  | { type: 'chatError'; payload: { message: string } }
  | { type: 'chatPrefill'; payload: { text: string; focus: boolean } }
  // Response to `chatMentionQuery` (todo #1614). `requestId` echoes the
  // client's monotonic counter so stale results from older queries can
  // be dropped before render.
  | { type: 'chatMentionResults'; payload: { requestId: number; kind: string; items: MentionItem[] } }
  | {
      type: 'update';
      payload: {
        session: Partial<SessionMeta>;
        logs: LogEntry[];
        // Optional so older host builds (without the diff-view setting wired)
        // don't break the type. Falls back to the body data attribute.
        chatDiffView?: 'unified' | 'split';
      };
    };

// Webview → host
export type ChatClientMessage =
  | { type: 'chatSend'; payload: { text: string } }
  | { type: 'chatRespond'; payload: { promptId: string; text: string } }
  | { type: 'chatLoadOlder'; payload: { beforeId: number } }
  // Picker asks host to resolve a mention list (todo #1614). `kind` is
  // one of MENTION_KINDS from mentionParser.ts; `query` is the post-colon
  // filter string (or the rawToken when no `:` has been typed yet — the
  // host's match() is a substring check either way). `requestId` is a
  // monotonic counter; host echoes it in `chatMentionResults`.
  | { type: 'chatMentionQuery'; payload: { requestId: number; kind: string; query: string } }
  | {
      type: 'openDiff';
      payload: {
        title: string;
        before: string;
        after: string;
        language?: string;
        filePath?: string;
      };
    }
  | { type: 'stop' }
  | { type: 'refresh' };
