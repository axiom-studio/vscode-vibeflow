import { useState, useCallback, type ReactNode } from 'react';
import type { VibeFlowComment } from './types';

interface CommentableSectionProps {
  heading: string;
  sectionIndex: number;
  children: ReactNode; // Rendered markdown content for the section
  comments: VibeFlowComment[];
  draftContent: string | undefined;
  onAddComment: (sectionIndex: number) => void;
  commentListSlot?: ReactNode; // CommentList rendered below content
  popoverSlot?: ReactNode; // CommentPopover rendered below list when open
  popoverOpen: boolean;
}

/**
 * Wraps a markdown section with hover-reveal comment toggle button.
 * Hover state is React-managed (not CSS-only) so it stays active
 * while the popover is open. Matches PRD #227 §4.3.
 */
export function CommentableSection({
  heading,
  sectionIndex,
  children,
  comments,
  draftContent,
  onAddComment,
  commentListSlot,
  popoverSlot,
  popoverOpen,
}: CommentableSectionProps) {
  const [isHovered, setIsHovered] = useState(false);

  const handleToggleClick = useCallback(() => {
    onAddComment(sectionIndex);
  }, [sectionIndex, onAddComment]);

  const showToggle = isHovered || popoverOpen;
  const commentCount = comments.length;
  const hasDraft = !!draftContent && draftContent.trim().length > 0;

  return (
    <div
      className="vf-commentable-section"
      data-section-index={sectionIndex}
      data-section-heading={heading}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{ position: 'relative' }}
    >
      <CommentToggleButton
        visible={showToggle}
        commentCount={commentCount}
        hasDraft={hasDraft}
        onClick={handleToggleClick}
      />
      {children}
      {commentListSlot}
      {popoverOpen && popoverSlot}
    </div>
  );
}

interface CommentToggleButtonProps {
  visible: boolean;
  commentCount: number;
  hasDraft: boolean;
  onClick: () => void;
}

/**
 * Absolute-positioned toggle button at top-right of a section.
 * Shows comment count badge if any comments exist.
 * Shows a dot indicator if there's an unsaved draft.
 */
function CommentToggleButton({ visible, commentCount, hasDraft, onClick }: CommentToggleButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={commentCount > 0 ? `View ${commentCount} comment(s)` : 'Add comment'}
      className="vf-comment-toggle"
      style={{
        position: 'absolute',
        top: 8,
        right: -4,
        opacity: visible ? 1 : 0,
        transition: 'opacity 120ms',
        pointerEvents: visible ? 'auto' : 'none',
        background: 'var(--feed-button-bg)',
        color: 'var(--feed-button-fg)',
        border: 'none',
        borderRadius: 4,
        padding: '2px 8px',
        fontSize: 11,
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
      }}
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
        <path d="M2 2h12v8H6l-4 4V2zm1 1v8.5L5.5 9H13V3H3z" />
      </svg>
      {commentCount > 0 && <span>{commentCount}</span>}
      {hasDraft && (
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'var(--feed-warning)',
            marginLeft: 2,
          }}
          title="Unsaved draft"
        />
      )}
    </button>
  );
}
