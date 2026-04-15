import { useEffect, useRef, useCallback } from 'react';

interface CommentPopoverProps {
  sectionHeading: string;
  draftValue: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

/**
 * Inline comment input popover matching axiomcloud DocumentPopoutModal
 * lines 421-432. Fixed 320px width, positioned below the section's
 * toggle button. Autofocuses textarea on mount.
 */
export function CommentPopover({
  sectionHeading,
  draftValue,
  onChange,
  onSave,
  onCancel,
}: CommentPopoverProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftValueRef = useRef(draftValue);
  draftValueRef.current = draftValue;

  const hasDraft = draftValue.trim().length > 0;

  // Autofocus on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Escape key closes popover
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  // Click outside closes popover (only if draft is empty)
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const el = containerRef.current;
      if (!el) { return; }
      if (!el.contains(e.target as Node) && !draftValueRef.current.trim()) {
        onCancel();
      }
    }
    // Delay to avoid closing on the click that opened the popover
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onCancel]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Cmd/Ctrl+Enter saves
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && hasDraft) {
      e.preventDefault();
      onSave();
    }
  }, [hasDraft, onSave]);

  return (
    <div
      ref={containerRef}
      className="vf-comment-popover"
      style={{
        position: 'absolute',
        top: '100%',
        right: 0,
        marginTop: 6,
        width: 320,
        background: 'var(--vscode-editorHoverWidget-background, var(--feed-bg))',
        border: '1px solid var(--feed-border)',
        borderRadius: 6,
        padding: 10,
        boxShadow: '0 4px 12px rgba(0,0,0,0.35)',
        zIndex: 100,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 6,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--feed-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: 240,
          }}
          title={sectionHeading || 'Preamble'}
        >
          {sectionHeading || 'Preamble'}
        </span>
        {hasDraft && (
          <span
            style={{
              fontSize: 9,
              fontWeight: 600,
              padding: '1px 5px',
              borderRadius: 2,
              background: 'var(--feed-warning)',
              color: 'var(--vscode-editor-background)',
              textTransform: 'uppercase',
            }}
          >
            Draft
          </span>
        )}
      </div>

      {/* Textarea */}
      <textarea
        ref={textareaRef}
        rows={3}
        value={draftValue}
        placeholder="Add your comment..."
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        style={{
          width: '100%',
          minHeight: 60,
          resize: 'vertical',
          padding: '6px 8px',
          fontSize: 12,
          fontFamily: 'var(--vscode-font-family)',
          background: 'var(--feed-input-bg)',
          color: 'var(--feed-fg)',
          border: '1px solid var(--feed-input-border)',
          borderRadius: 4,
          outline: 'none',
          boxSizing: 'border-box',
        }}
      />

      {/* Actions */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 6,
          marginTop: 8,
        }}
      >
        <button
          type="button"
          onClick={onCancel}
          style={{
            padding: '4px 10px',
            fontSize: 11,
            background: 'transparent',
            color: 'var(--feed-muted)',
            border: '1px solid var(--feed-border)',
            borderRadius: 3,
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={!hasDraft}
          style={{
            padding: '4px 10px',
            fontSize: 11,
            background: hasDraft ? 'var(--feed-button-bg)' : 'var(--feed-border)',
            color: hasDraft ? 'var(--feed-button-fg)' : 'var(--feed-muted)',
            border: 'none',
            borderRadius: 3,
            cursor: hasDraft ? 'pointer' : 'not-allowed',
          }}
        >
          Save
        </button>
      </div>
    </div>
  );
}
