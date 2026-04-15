import { CommentCard } from './CommentCard';
import type { VibeFlowComment } from './types';

interface CommentListProps {
  sectionHeading: string;
  comments: VibeFlowComment[];
  currentUserId: number | undefined;
  onDelete: (commentId: number) => void;
}

/**
 * Renders comments filtered for a specific section. Matches axiomcloud
 * DocumentPopoutModal lines 377-406. Empty state renders nothing
 * (no empty placeholder).
 */
export function CommentList({ sectionHeading, comments, currentUserId, onDelete }: CommentListProps) {
  const sectionComments = comments.filter(c => c.section_heading === sectionHeading);

  if (sectionComments.length === 0) {
    return null;
  }

  return (
    <div
      className="vf-comment-list"
      style={{
        marginTop: 8,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {sectionComments.map(comment => (
        <CommentCard
          key={comment.id}
          comment={comment}
          currentUserId={currentUserId}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}
