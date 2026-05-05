// Mirrors src/api/types.ts — shared protocol between extension host and webview.
// Kept as a separate copy to avoid cross-project imports.

export type ActivityMessageType =
  | 'status_change'
  | 'thinking'
  | 'action'
  | 'observation'
  | 'prompt'
  | 'commit'
  | 'completion'
  | 'error'
  | 'summary';

export interface ActivityEntry {
  id: string;
  timestamp: string;
  personaKey: string;
  personaName: string;
  messageType: ActivityMessageType;
  content: string;
  metadata?: Record<string, unknown>;
}

// Mirror of FeedState in src/core/webviewMessages.ts. Kept duplicated to
// avoid cross-project imports; the host is the source of truth and the
// webview combines this with `entries.length` to render one of the four
// presentations from Design Spec Doc #224 §"Activity Feed States".
export type FeedState =
  | { kind: 'unauthenticated' }
  | { kind: 'noSessions' }
  | { kind: 'sessionsActive' }
  | { kind: 'disconnected' };

// Extension -> Webview
export type ExtensionMessage =
  | { type: 'activityEntry'; payload: ActivityEntry }
  | { type: 'activityEntries'; payload: ActivityEntry[] }
  | { type: 'clearActivity'; payload: undefined }
  | { type: 'feedState'; payload: FeedState };

// Webview -> Extension
export type WebviewMessage =
  | { type: 'respondToPrompt'; payload: { promptId: string; response: string } }
  | { type: 'ready'; payload: undefined }
  // Empty-state CTA dispatches.
  | { type: 'runSetup'; payload: undefined }
  | { type: 'launchSession'; payload: undefined };

// Persona color mapping
export const PERSONA_COLORS: Record<string, string> = {
  developer: '#4fc1ff',
  architect: '#c586c0',
  principal_engineer: '#dcdcaa',
  security_lead: '#f44747',
  qa_lead: '#4ec86e',
  product_manager: '#ce9178',
  project_manager: '#9cdcfe',
  ux_designer: '#d7ba7d',
  customer: '#b5cea8',
};

// Message type icons
export const MESSAGE_ICONS: Record<ActivityMessageType, string> = {
  status_change: '🔄',
  thinking: '🤔',
  action: '⚡',
  observation: '👁',
  prompt: '❓',
  commit: '📝',
  completion: '✅',
  error: '❌',
  summary: '📋',
};
