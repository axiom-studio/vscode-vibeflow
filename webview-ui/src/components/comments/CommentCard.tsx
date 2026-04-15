import { useState, useCallback } from 'react';
import type { VibeFlowComment } from './types';

interface CommentCardProps {
  comment: VibeFlowComment;
  currentUserId: number | undefined;
  onDelete: (commentId: number) => void;
}

/**
 * Single comment card with metadata, content, and hover-reveal delete button.
 * Matches axiomcloud DocumentPopoutModal lines 377-406.
 */
export function CommentCard({ comment, currentUserId, onDelete }: CommentCardProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const isOwner = currentUserId !== undefined && comment.user_id === currentUserId;
  const showDelete = isOwner && isHovered;

  const handleDeleteClick = useCallback(() => {
    setConfirming(true);
  }, []);

  const handleConfirm = useCallback(() => {
    onDelete(comment.id);
    setConfirming(false);
  }, [comment.id, onDelete]);

  const handleCancel = useCallback(() => {
    setConfirming(false);
  }, []);

  return (
    <div
      className="vf-comment-card"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        background: 'rgba(139, 92, 246, 0.06)',
        border: '1px solid rgba(139, 92, 246, 0.15)',
        borderRadius: 5,
        padding: '8px 10px',
        marginTop: 6,
        fontSize: 12,
        position: 'relative',
      }}
    >
      {/* Metadata header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          marginBottom: 4,
          fontSize: 11,
        }}
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill="#c084fc">
          <path d="M2 2h12v8H6l-4 4V2zm1 1v8.5L5.5 9H13V3H3z" />
        </svg>
        <span style={{ color: '#c084fc', fontWeight: 500 }}>
          {comment.user_email ?? `User #${comment.user_id}`}
        </span>
        <span style={{ color: 'var(--feed-muted)' }}>·</span>
        <span style={{ color: 'var(--feed-muted)' }} title={comment.created_at}>
          {formatRelativeTime(comment.created_at)}
        </span>

        {showDelete && !confirming && (
          <button
            type="button"
            onClick={handleDeleteClick}
            aria-label="Delete comment"
            style={{
              marginLeft: 'auto',
              background: 'transparent',
              border: 'none',
              color: 'var(--feed-muted)',
              cursor: 'pointer',
              padding: '0 2px',
              fontSize: 13,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        )}
      </div>

      {/* Content */}
      <div
        style={{
          color: 'var(--feed-fg)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          lineHeight: 1.5,
        }}
      >
        {comment.content}
      </div>

      {/* Inline delete confirmation */}
      {confirming && (
        <div
          style={{
            marginTop: 6,
            padding: '6px 8px',
            background: 'var(--vscode-inputValidation-warningBackground, rgba(204,167,0,0.1))',
            border: '1px solid var(--feed-warning)',
            borderRadius: 3,
            fontSize: 11,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span>Delete comment?</span>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              type="button"
              onClick={handleConfirm}
              style={{
                padding: '2px 8px',
                fontSize: 10,
                background: 'var(--feed-error)',
                color: 'white',
                border: 'none',
                borderRadius: 2,
                cursor: 'pointer',
              }}
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={handleCancel}
              style={{
                padding: '2px 8px',
                fontSize: 10,
                background: 'transparent',
                color: 'var(--feed-muted)',
                border: '1px solid var(--feed-border)',
                borderRadius: 2,
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Format ISO timestamp as relative time:
 * "just now" (<60s), "Nm ago" (<1h), "Nh ago" (<1d), "Nd ago" (<=7d),
 * absolute date (>7d).
 */
function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const deltaSec = Math.max(0, Math.floor((now - then) / 1000));

  if (deltaSec < 60) { return 'just now'; }
  if (deltaSec < 3600) { return `${Math.floor(deltaSec / 60)}m ago`; }
  if (deltaSec < 86400) { return `${Math.floor(deltaSec / 3600)}h ago`; }
  if (deltaSec <= 7 * 86400) { return `${Math.floor(deltaSec / 86400)}d ago`; }
  return new Date(iso).toLocaleDateString();
}
