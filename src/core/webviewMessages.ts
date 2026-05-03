/**
 * Typed postMessage protocol between extension host and each webview.
 *
 * Pattern: Roo-Code's WebviewMessage / ExtensionMessage discriminated
 * unions. Every message has a `type` field that TypeScript narrows on
 * switch — exhaustive switch statements then catch a missing case at
 * compile time via `assertNever`.
 *
 * **Per-panel unions** (rather than one global mega-union) so each
 * panel's typing stays scoped to messages it actually handles. The
 * compiler complains if a panel's message handler tries to dispatch
 * a message from another panel's protocol.
 */

import type { ActivityEntry, VibeFlowComment } from '../api/types.js';

// ============================================================
// Activity Feed
// ============================================================

export type ActivityFeedHostMessage =
  | { type: 'activityEntry'; payload: ActivityEntry }
  | { type: 'activityEntries'; payload: ActivityEntry[] }
  | { type: 'clearActivity' }
  | { type: 'showSettings' }
  | { type: 'showActivity' }
  | { type: 'settingsData'; payload: unknown }
  | { type: 'validationResult'; payload: { field: string; valid: boolean; message?: string } };

export type ActivityFeedClientMessage =
  | { type: 'ready' }
  | { type: 'closeSettings' }
  | { type: 'respondToPrompt'; payload: { promptId: string } }
  // Settings forwarded through the activity feed when it's the
  // active webview view (see ActivityFeedProvider.settingsHandler).
  | { type: 'getSetting' }
  | { type: 'updateSetting'; payload: { key: string; value: unknown } }
  | { type: 'validateServerUrl'; payload: string }
  | { type: 'validateApiKey'; payload: string }
  | { type: 'setApiKey'; payload: string }
  | { type: 'setProviderToken'; payload: { provider: string } }
  | { type: 'selectProject'; payload: number }
  | { type: 'refreshProjects' };

// ============================================================
// Settings Panel (editor-area webview)
// ============================================================

export type SettingsHostMessage =
  | { type: 'settingsData'; payload: unknown }
  | { type: 'validationResult'; payload: { field: string; valid: boolean; message?: string } };

export type SettingsClientMessage =
  | { type: 'closeSettings' }
  | { type: 'getSetting' }
  | { type: 'updateSetting'; payload: { key: string; value: unknown } }
  | { type: 'validateServerUrl'; payload: string }
  | { type: 'validateApiKey'; payload: string }
  | { type: 'setApiKey'; payload: string }
  | { type: 'setProviderToken'; payload: { provider: string } }
  | { type: 'selectProject'; payload: number }
  | { type: 'refreshProjects' };

// ============================================================
// Work Item Panel
// ============================================================

export type WorkItemPanelHostMessage =
  | { type: 'snapshot'; payload: unknown };

export type WorkItemPanelClientMessage =
  | { type: 'changeStatus' }
  | { type: 'qaVerify' }
  | { type: 'qaReject' }
  | { type: 'securityApprove' }
  | { type: 'securityReject' }
  | { type: 'edit' }
  | { type: 'archive' }
  | { type: 'delete' }
  | { type: 'uploadAttachment' }
  | { type: 'deleteAttachment'; payload: { attachmentId: number } }
  | { type: 'refresh' };

// ============================================================
// Session Panel
// ============================================================

export type SessionPanelHostMessage =
  | { type: 'update'; payload: { session: unknown; logs: unknown[] } };

export type SessionPanelClientMessage =
  | { type: 'sendPrompt' }
  | { type: 'stop' }
  | { type: 'refresh' };

// ============================================================
// Kanban Panel
// ============================================================

export type KanbanHostMessage =
  | { type: 'kanbanData'; payload: unknown }
  | { type: 'kanbanError'; payload: { message: string } };

export type KanbanClientMessage =
  | { type: 'kanbanLoad' }
  | { type: 'kanbanRefresh' }
  | { type: 'kanbanMove'; payload: { itemType: 'todo' | 'issue'; itemId: number; newStatus: string } }
  | { type: 'kanbanOpenItem'; payload: { itemType: 'todo' | 'issue'; itemId: number; title: string } };

// ============================================================
// Dashboard Panel
// ============================================================

export type DashboardHostMessage =
  | { type: 'dashboardSnapshot'; payload: unknown };

export type DashboardClientMessage =
  | { type: 'dashboardLoad' }
  | { type: 'dashboardRefresh' }
  | { type: 'dashboardFocusPersona'; payload: { personaKey: string } }
  | { type: 'dashboardOpenSidebar' };

// ============================================================
// Comments (used by document/context viewers)
// ============================================================

export type CommentsHostMessage =
  | { type: 'commentsList'; payload: VibeFlowComment[] }
  | { type: 'commentCreated'; payload: VibeFlowComment }
  | { type: 'commentDeleted'; payload: { id: number } }
  | { type: 'commentError'; payload: { message: string } };

export type CommentsClientMessage =
  | { type: 'listComments'; entityType: string; entityId: number }
  | { type: 'createComment'; entityType: string; entityId: number; projectId: number; sectionHeading: string; content: string }
  | { type: 'deleteComment'; commentId: number }
  | { type: 'commentsSaveAndNotify'; payload: unknown };

// ============================================================
// Helpers
// ============================================================

/**
 * Use in the default branch of an exhaustive switch on a discriminated
 * union to make the compiler enforce exhaustiveness. If a new variant
 * is added without a case, this call becomes a type error.
 *
 *   switch (msg.type) {
 *     case 'a': ...; break;
 *     case 'b': ...; break;
 *     default: assertNever(msg);
 *   }
 */
export function assertNever(_value: never): void {
  // No-op at runtime — purely a compile-time check.
}
