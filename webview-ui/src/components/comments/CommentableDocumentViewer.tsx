import { useState, useEffect, useCallback } from 'react';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { useSections, sectionToMarkdown } from '../../hooks/useSections';
import { useDrafts } from '../../hooks/useDrafts';
import { CommentableSection } from './CommentableSection';
import { CommentPopover } from './CommentPopover';
import { CommentList } from './CommentList';
import { SaveAndNotifyButton } from './SaveAndNotifyButton';
import type { VibeFlowComment, CommentEvent, CommentMessage } from './types';
import { getVsCodeApi } from '../../vscodeApi';

interface CommentableDocumentViewerProps {
  content: string;
  documentTitle: string;
  entityType: 'document' | 'context';
  entityId: number;
  projectId: number;
  currentUserId: number | undefined;
}

const vscode = getVsCodeApi() as {
  postMessage: (msg: CommentMessage | { type: 'commentsSaveAndNotify'; payload: unknown }) => void;
};

/**
 * Top-level document viewer with inline comments.
 * Splits content into sections, renders each through MarkdownRenderer,
 * wraps each in CommentableSection. Manages drafts, active popover,
 * and the Save All & Notify flow.
 */
export function CommentableDocumentViewer({
  content,
  documentTitle,
  entityType,
  entityId,
  projectId,
  currentUserId,
}: CommentableDocumentViewerProps) {
  const sections = useSections(content);
  const { drafts, setDraft, clearDraft, clearAllDrafts } = useDrafts();
  const [activeSectionIndex, setActiveSectionIndex] = useState<number | null>(null);
  const [comments, setComments] = useState<VibeFlowComment[]>([]);

  // Fetch comments on mount + poll every 5s
  useEffect(() => {
    function fetchComments() {
      vscode.postMessage({ type: 'listComments', entityType, entityId });
    }
    fetchComments();
    const timer = setInterval(fetchComments, 5000);
    return () => clearInterval(timer);
  }, [entityType, entityId]);

  // Listen for comment events from the extension host
  useEffect(() => {
    function handleMessage(event: MessageEvent<CommentEvent>) {
      const msg = event.data;
      if (!msg?.type) { return; }
      switch (msg.type) {
        case 'commentsList':
          setComments(msg.payload);
          break;
        case 'commentCreated':
          setComments(prev => [...prev, msg.payload]);
          break;
        case 'commentDeleted':
          setComments(prev => prev.filter(c => c.id !== msg.payload.id));
          break;
        case 'commentError':
          console.error('[Comments]', msg.payload.message);
          break;
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleAddComment = useCallback((sectionIndex: number) => {
    setActiveSectionIndex(prev => prev === sectionIndex ? null : sectionIndex);
  }, []);

  const handleDraftChange = useCallback((sectionIndex: number, value: string) => {
    setDraft(sectionIndex, value);
  }, [setDraft]);

  const handleSaveDraft = useCallback((sectionIndex: number) => {
    // For individual section save, we create the single comment immediately
    const draft = drafts[sectionIndex];
    if (!draft || !draft.trim()) { return; }

    const section = sections[sectionIndex];
    vscode.postMessage({
      type: 'createComment',
      entityType,
      entityId,
      projectId,
      sectionHeading: section.heading || 'Introduction',
      content: draft.trim(),
    });

    clearDraft(sectionIndex);
    setActiveSectionIndex(null);
  }, [drafts, sections, entityType, entityId, projectId, clearDraft]);

  const handleCancelDraft = useCallback((sectionIndex: number) => {
    clearDraft(sectionIndex);
    setActiveSectionIndex(null);
  }, [clearDraft]);

  const handleDeleteComment = useCallback((commentId: number) => {
    vscode.postMessage({ type: 'deleteComment', commentId });
    // Optimistic: remove from list immediately (will restore on error via commentError message)
    setComments(prev => prev.filter(c => c.id !== commentId));
  }, []);

  const handleSaveAllAndNotify = useCallback(() => {
    // Send all drafts + sections to extension for batch save + persona picker
    vscode.postMessage({
      type: 'commentsSaveAndNotify',
      payload: {
        documentTitle,
        entityType,
        entityId,
        projectId,
        drafts,
        sections: sections.map(s => ({ heading: s.heading, lines: s.lines })),
      },
    });
    // Clear drafts optimistically; a commentsList refresh will follow
    clearAllDrafts();
    setActiveSectionIndex(null);
  }, [documentTitle, entityType, entityId, projectId, drafts, sections, clearAllDrafts]);

  const draftCount = Object.values(drafts).filter(v => v.trim()).length;

  return (
    <div className="vf-commentable-document">
      <SaveAndNotifyButton draftCount={draftCount} onClick={handleSaveAllAndNotify} />

      <div className="prose-vf">
        {sections.map((section, idx) => {
          const sectionMarkdown = sectionToMarkdown(section);
          const sectionComments = comments.filter(c => c.section_heading === (section.heading || 'Introduction'));
          const isPopoverOpen = activeSectionIndex === idx;

          return (
            <CommentableSection
              key={idx}
              heading={section.heading}
              sectionIndex={idx}
              comments={sectionComments}
              draftContent={drafts[idx]}
              onAddComment={handleAddComment}
              popoverOpen={isPopoverOpen}
              commentListSlot={
                <CommentList
                  sectionHeading={section.heading || 'Introduction'}
                  comments={comments}
                  currentUserId={currentUserId}
                  onDelete={handleDeleteComment}
                />
              }
              popoverSlot={
                <CommentPopover
                  sectionHeading={section.heading}
                  draftValue={drafts[idx] ?? ''}
                  onChange={(v) => handleDraftChange(idx, v)}
                  onSave={() => handleSaveDraft(idx)}
                  onCancel={() => handleCancelDraft(idx)}
                />
              }
            >
              <MarkdownRenderer content={sectionMarkdown} inline />
            </CommentableSection>
          );
        })}
      </div>
    </div>
  );
}
