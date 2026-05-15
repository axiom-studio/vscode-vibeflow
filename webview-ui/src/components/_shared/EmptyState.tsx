import type { CSSProperties, ReactNode } from 'react';

interface EmptyStateAction {
  label: string;
  onClick: () => void;
  /** Optional small note rendered between subtext and the button. */
  hint?: string;
}

interface EmptyStateProps {
  /**
   * Decorative icon. Pass any ReactNode — typically one of the shared
   * inline SVG icons from `./icons`. Optional; renders nothing if
   * undefined so the caller can compose a text-only empty state.
   */
  icon?: ReactNode;
  /** Primary line — 13px medium weight. */
  headline: string;
  /** Supporting line — 11.5px muted. */
  subtext?: string;
  /** Optional call-to-action button. */
  action?: EmptyStateAction;
  /** Override the wrapper className (e.g. to switch from `h-full` to inline). */
  className?: string;
  /** Override the wrapper inline style. */
  style?: CSSProperties;
}

/**
 * Shared empty-state primitive. Generalizes the pattern that shipped
 * in #1656 ActivityFeed (UnauthenticatedState / NoSessionsState /
 * race-fallback "No activity yet" / LoadingState). Same typography
 * ladder used across Activity Feed / Dashboard / Chat:
 *
 *   - 13px font-medium tracking-[-0.005em] headline
 *   - 11.5px muted max-w-[260px] leading-relaxed subtext
 *   - 12px font-medium button with `active:scale-[0.97]` press feedback
 *
 * Layout: centered column, full-height by default (`h-full`). Caller
 * can override via `className`/`style` for inline placements (e.g.
 * Dashboard's Branch-readiness card).
 */
export function EmptyState({
  icon,
  headline,
  subtext,
  action,
  className = 'flex flex-col items-center justify-center h-full px-6 text-center gap-3',
  style,
}: EmptyStateProps) {
  return (
    <div className={className} style={style}>
      {icon !== undefined && (
        <span style={{ color: 'var(--feed-muted)', opacity: 0.85 }}>
          {icon}
        </span>
      )}
      <div className="flex flex-col gap-1.5">
        <p className="text-[13px] font-medium tracking-[-0.005em]">{headline}</p>
        {subtext && (
          <p className="text-[11.5px] text-[var(--feed-muted)] max-w-[260px] leading-relaxed">
            {subtext}
          </p>
        )}
      </div>
      {action && (
        <>
          {action.hint && (
            <p className="text-[10.5px] text-[var(--feed-muted)] opacity-70">{action.hint}</p>
          )}
          <button
            onClick={action.onClick}
            className="mt-1 px-3.5 py-1.5 text-[12px] font-medium rounded-sm cursor-pointer
              bg-[var(--vscode-button-background)]
              text-[var(--vscode-button-foreground)]
              hover:bg-[var(--vscode-button-hoverBackground)]
              border-none outline-none
              transition-all duration-150 ease-out active:scale-[0.97]"
          >
            {action.label}
          </button>
        </>
      )}
    </div>
  );
}
