import type { CSSProperties, ReactNode } from 'react';

interface StatusPillProps {
  /**
   * Any CSS color expression — `var(--vscode-…)`, a hex literal, a
   * `color-mix(...)` expression. Drives both the text color and the
   * tinted background.
   */
  color: string;
  /** Pill content. Plain text or a short fragment with an arrow / glyph. */
  children: ReactNode;
  /** Size tier; controls font-size and padding. Default 'sm'. */
  size?: 'sm' | 'md';
  /** Optional tooltip / native title attribute. */
  title?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * Generic tinted pill primitive. The visual discipline (introduced in
 * #1656 ActivityItem and lifted here in #1657) is:
 *
 *   - Background = `color-mix(in oklab, ${color} 16%, transparent)` —
 *     theme-safe across light / dark / high-contrast. Works for any
 *     CSS color expression (named, hex, `var(...)`, `color-mix(...)`).
 *   - Foreground = the same `${color}` at full saturation. Readable on
 *     all themes because the background is the perceptual mix.
 *   - No border. The mix is the affordance.
 *
 * Caller composes semantic content inside `children`. Example usages:
 *
 *   // Activity-feed status transition
 *   <StatusPill color={STATUS_COLORS[s] ?? 'var(--feed-muted)'}>
 *     → {label}
 *   </StatusPill>
 *
 *   // Branch-readiness PASS/PENDING badge
 *   <StatusPill color="var(--feed-success)" size="md">
 *     PASS
 *   </StatusPill>
 */
export function StatusPill({
  color,
  children,
  size = 'sm',
  title,
  className,
  style,
}: StatusPillProps) {
  const sizing: CSSProperties = size === 'md'
    ? { fontSize: 11, padding: '2px 7px', borderRadius: 4 }
    : { fontSize: 9.5, padding: '1px 5px', borderRadius: 3 };
  return (
    <span
      title={title}
      className={className}
      style={{
        ...sizing,
        color,
        background: `color-mix(in oklab, ${color} 16%, transparent)`,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
    </span>
  );
}
