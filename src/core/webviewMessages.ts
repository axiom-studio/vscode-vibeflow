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

import type { ActivityEntry, VibeFlowComment, VibeFlowProgressSnapshot } from '../api/types.js';

/**
 * Progress payload pushed to the Activity Feed when an agent publishes a
 * structured progress field via publish_todo_log / publish_issue_log. This
 * replaces the old "Pinned Plan" pattern of scraping log text — agents
 * publish structured progress per the wire shape, and we render it
 * directly. `null` clears the indicator.
 */
export interface ProgressIndicatorPayload {
  personaName: string;
  personaKey: string;
  workItemType: 'todo' | 'issue';
  workItemId: number;
  workItemTitle: string;
  progress: VibeFlowProgressSnapshot;
}

/**
 * Resolved empty/connection state for the Activity Feed. The host derives
 * this from auth state, project selection, active session count, and poll
 * health (see FeedStateController) and the webview combines it with
 * `entries.length` to pick between four spec'd presentations from
 * Design Spec Doc #224 §"Activity Feed States":
 *   - unauthenticated → "Connect to VibeFlow…" CTA
 *   - noSessions      → "No active agent sessions" CTA
 *   - sessionsActive  → spinner if no entries yet, otherwise the live feed
 *   - disconnected    → top banner "Connection lost. Retrying…" overlaying
 *                       whatever else is rendered (entries persist underneath)
 */
export type FeedState =
  | { kind: 'unauthenticated' }
  | { kind: 'noSessions' }
  | { kind: 'sessionsActive' }
  | { kind: 'disconnected' };

// ============================================================
// Activity Feed
// ============================================================

export type ActivityFeedHostMessage =
  | { type: 'activityEntry'; payload: ActivityEntry }
  | { type: 'activityEntries'; payload: ActivityEntry[] }
  | { type: 'clearActivity' }
  | { type: 'showSettings' }
  | { type: 'showActivity' }
  | { type: 'progressIndicator'; payload: ProgressIndicatorPayload | null }
  | { type: 'feedState'; payload: FeedState }
  | { type: 'settingsData'; payload: unknown }
  | { type: 'validationResult'; payload: { field: string; valid: boolean; message?: string } };

export type ActivityFeedClientMessage =
  | { type: 'ready' }
  | { type: 'closeSettings' }
  | { type: 'respondToPrompt'; payload: { promptId: string } }
  // Empty-state CTA buttons. The webview dispatches these instead of the
  // host registering a per-button command — keeps the React side stateless
  // and routes through the existing extension command IDs.
  | { type: 'runSetup' }
  | { type: 'launchSession' }
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
  | { type: 'refreshProjects' }
  | { type: 'updateStickyModel'; payload: { persona: string; model: string } }
  | { type: 'resetStickyModel'; payload: { persona: string } }
  // Generic command-passthrough — the Settings panel uses this to fire
  // extension commands (like vibeflow.openCli) directly from a tab so we
  // don't need a one-off wire shape per button.
  | { type: 'runCommand'; payload: string };

// ============================================================
// Work Item Panel
// ============================================================

import type {
  VibeFlowComplianceFinding,
  VibeFlowAttachment,
  VibeFlowSecurityReview,
  VibeFlowQAReview,
  VibeFlowComplianceTag,
} from '../api/types.js';

/**
 * Initial work-item context the host hands to the React webview via a body
 * data attribute (see WorkItemPanelManager.renderHtml). The webview uses it
 * to render header chrome immediately on mount, before the first
 * snapshot lands.
 */
export interface WorkItemPanelInfo {
  type: 'todo' | 'issue';
  id: number;
  title: string;
  status: string;
  priority: string;
  featureName?: string;
  claimedBy?: string;
}

/**
 * Snapshot pushed every poll cycle. Single source of truth for the
 * Details / Attachments / Logs tabs. Built from parallel API calls
 * via Promise.allSettled so a partial failure degrades only the
 * affected section.
 */
export interface WorkItemPanelSnapshot {
  // Header / state
  status: string;
  qa_verified: boolean;
  security_reviewed: boolean;
  // Details tab
  description: string;
  user_email: string;
  created_at: string;
  updated_at: string;
  target_branch: string;
  feature_name: string;
  claimed_by: string;
  priority: string;
  compliance_tags: VibeFlowComplianceTag[];
  // Attachments tab (count drives the tab label)
  attachments: VibeFlowAttachment[];
  // Logs sub-tabs
  execution_logs: { content: string; message_type?: string; created_at: string }[];
  security_findings: VibeFlowComplianceFinding[];
  security_review?: VibeFlowSecurityReview;
  qa_review?: VibeFlowQAReview;
}

export type WorkItemPanelHostMessage =
  | { type: 'snapshot'; payload: WorkItemPanelSnapshot };

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
  | { type: 'dashboardData'; payload: unknown }
  | { type: 'dashboardError'; payload: { message: string } };

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
  | { type: 'listComments'; entityType: 'document' | 'context'; entityId: number }
  | { type: 'createComment'; entityType: 'document' | 'context'; entityId: number; projectId: number; sectionHeading: string; content: string }
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
