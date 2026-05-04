/**
 * Comment types — re-exports from the shared host/webview protocol so
 * the comments folder has a single import path. The canonical
 * definitions live in src/core/webviewMessages.ts and src/api/types.ts.
 */
export type { VibeFlowComment } from '../../../../src/api/types';
export type {
  CommentsClientMessage as CommentMessage,
  CommentsHostMessage as CommentEvent,
} from '../../../../src/core/webviewMessages';
