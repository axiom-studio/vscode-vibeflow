/**
 * Comment types mirroring the extension-host VibeFlowComment shape.
 * Kept in the webview to avoid cross-project imports.
 */
export interface VibeFlowComment {
  id: number;
  entity_type: 'document' | 'context';
  entity_id: number;
  project_id: number;
  section_heading: string;
  content: string;
  user_id: number;
  user_email?: string;
  created_at: string;
  updated_at: string;
}

/**
 * Message types for comment operations between webview and extension host.
 */
export type CommentMessage =
  | { type: 'listComments'; entityType: 'document' | 'context'; entityId: number }
  | { type: 'createComment'; entityType: 'document' | 'context'; entityId: number; projectId: number; sectionHeading: string; content: string }
  | { type: 'deleteComment'; commentId: number }
  | { type: 'notifyPersona'; projectId: number; persona: string; promptText: string };

export type CommentEvent =
  | { type: 'commentsList'; payload: VibeFlowComment[] }
  | { type: 'commentCreated'; payload: VibeFlowComment }
  | { type: 'commentDeleted'; payload: { id: number } }
  | { type: 'commentError'; payload: { message: string } };
