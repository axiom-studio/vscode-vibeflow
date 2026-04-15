interface SaveAndNotifyButtonProps {
  draftCount: number;
  onClick: () => void;
}

/**
 * Top-level "Save All & Notify..." button shown at the top of the
 * markdown viewer when there are unsaved drafts. Disabled when no drafts.
 */
export function SaveAndNotifyButton({ draftCount, onClick }: SaveAndNotifyButtonProps) {
  const hasDrafts = draftCount > 0;

  return (
    <div
      className="vf-save-notify-bar"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 50,
        padding: '8px 12px',
        background: 'var(--feed-bg)',
        borderBottom: '1px solid var(--feed-border)',
        display: 'flex',
        justifyContent: 'flex-end',
        gap: 8,
      }}
    >
      <button
        type="button"
        onClick={onClick}
        disabled={!hasDrafts}
        style={{
          padding: '5px 14px',
          fontSize: 12,
          fontWeight: 500,
          background: hasDrafts ? 'var(--feed-button-bg)' : 'var(--feed-border)',
          color: hasDrafts ? 'var(--feed-button-fg)' : 'var(--feed-muted)',
          border: 'none',
          borderRadius: 4,
          cursor: hasDrafts ? 'pointer' : 'not-allowed',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <path d="M2 2h10l2 2v10H2V2zm1 1v10h10V4.5L11.5 3H3zm2 1h6v3H5V4zm0 5h6v4H5V9z" />
        </svg>
        Save All & Notify{hasDrafts ? `… (${draftCount})` : ''}
      </button>
    </div>
  );
}
