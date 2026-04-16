/**
 * Typed postMessage protocol between extension host and webviews.
 * All new postMessage calls should use these types.
 *
 * Pattern: Roo-Code's WebviewMessage / ExtensionMessage discriminated unions.
 * Every message has a `type` field that TypeScript narrows on switch.
 *
 * Note: existing callsites (Activity Feed, Settings, Comments, Documents)
 * have their own local message types defined in their modules. This file
 * defines the canonical union for new code going forward. A full migration
 * of existing callsites is a separate refactor pass.
 */

// ============================================================
// Extension Host → Webview
// ============================================================

export type ExtensionMessage =
  // Activity Feed
  | { type: 'activityEntry'; payload: import('../api/types.js').ActivityEntry }
  | { type: 'activityEntries'; payload: import('../api/types.js').ActivityEntry[] }
  | { type: 'clearActivity' }
  // View routing
  | { type: 'showSettings' }
  | { type: 'showActivity' }
  | { type: 'showDocument'; content: string; title?: string; entityType?: string; entityId?: number; projectId?: number; currentUserId?: number }
  // Settings
  | { type: 'settingsData'; payload: unknown }
  | { type: 'validationResult'; payload: { field: string; valid: boolean; message?: string } }
  // Comments
  | { type: 'commentsList'; payload: import('../api/types.js').VibeFlowComment[] }
  | { type: 'commentCreated'; payload: import('../api/types.js').VibeFlowComment }
  | { type: 'commentDeleted'; payload: { id: number } }
  | { type: 'commentError'; payload: { message: string } }
  // Session Panel
  | { type: 'update'; payload: { session: unknown; logs: unknown[] } };

// ============================================================
// Webview → Extension Host
// ============================================================

export type WebviewMessage =
  // Lifecycle
  | { type: 'ready' }
  | { type: 'closeSettings' }
  // Activity Feed
  | { type: 'respondToPrompt'; payload: { promptId: string; response: string } }
  // Settings
  | { type: 'getSetting' }
  | { type: 'updateSetting'; payload: { key: string; value: unknown } }
  | { type: 'validateServerUrl'; payload: string }
  | { type: 'validateApiKey'; payload: string }
  | { type: 'setApiKey'; payload: string }
  | { type: 'setProviderToken'; payload: { provider: string; token: string } }
  | { type: 'selectProject'; payload: number }
  | { type: 'refreshProjects' }
  // Comments
  | { type: 'listComments'; entityType: string; entityId: number }
  | { type: 'createComment'; entityType: string; entityId: number; projectId: number; sectionHeading: string; content: string }
  | { type: 'deleteComment'; commentId: number }
  | { type: 'commentsSaveAndNotify'; payload: unknown }
  // Session Panel
  | { type: 'sendPrompt' }
  | { type: 'stop' }
  | { type: 'refresh' }
  | { type: 'loadLogs' };
