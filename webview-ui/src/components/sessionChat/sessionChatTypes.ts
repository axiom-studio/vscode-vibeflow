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

export interface SessionMeta {
  sessionId: string;
  personaName: string;
  personaKey: string;
  model: string;
  branch: string;
  status: 'active' | 'stale' | 'inactive';
  taskTitle: string;
  taskStatus: string;
}

// Host → webview
export type ChatHostMessage =
  | { type: 'chatTranscript'; payload: { messages: ChatPrompt[]; hasMore: boolean } }
  | { type: 'chatAppend'; payload: { messages: ChatPrompt[] } }
  | { type: 'chatPrepend'; payload: { messages: ChatPrompt[]; hasMore: boolean } }
  | { type: 'chatError'; payload: { message: string } }
  | { type: 'chatPrefill'; payload: { text: string; focus: boolean } }
  | { type: 'update'; payload: { session: Partial<SessionMeta>; logs: LogEntry[] } };

// Webview → host
export type ChatClientMessage =
  | { type: 'chatSend'; payload: { text: string } }
  | { type: 'chatRespond'; payload: { promptId: string; text: string } }
  | { type: 'chatLoadOlder'; payload: { beforeId: number } }
  | { type: 'stop' }
  | { type: 'refresh' };
