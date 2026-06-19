/**
 * Shared inline SVG icons for the webview surfaces.
 *
 * Conventions:
 * - All icons use `stroke="currentColor"` (and `fill="none"` where it matters)
 *   so the consumer controls color via `color: …` on the wrapper.
 * - Default sizes match the dominant usage site at the time of authoring;
 *   override via `size` prop when the consumer needs something different.
 * - No external deps (no Lucide / Phosphor / Heroicons) — keeps the
 *   webview bundle slim and avoids version-pinning a fourth icon library
 *   on top of the design-system icons already shipped via `media/`.
 */

import type { CSSProperties } from 'react';

interface IconProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
  'aria-hidden'?: boolean;
}

function Svg({
  size,
  className,
  style,
  children,
  viewBox = '0 0 24 24',
  ariaHidden = true,
}: IconProps & { children: React.ReactNode; viewBox?: string; ariaHidden?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={ariaHidden}
      className={className}
      style={style}
    >
      {children}
    </svg>
  );
}

export function BoltIcon({ size = 28, ...rest }: IconProps = {}) {
  return (
    <Svg size={size} {...rest}>
      <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
    </Svg>
  );
}

export function InboxIcon({ size = 28, ...rest }: IconProps = {}) {
  return (
    <Svg size={size} {...rest}>
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </Svg>
  );
}

/**
 * Chevron pointer. Defaults to right; rotate via CSS for other directions:
 *   - up:    `transform: rotate(-90deg)`
 *   - down:  `transform: rotate(90deg)`
 *   - left:  `transform: rotate(180deg)`
 */
export function ChevronIcon({ size = 12, ...rest }: IconProps = {}) {
  return (
    <Svg size={size} {...rest}>
      <polyline points="9 6 15 12 9 18" />
    </Svg>
  );
}

export function XIcon({ size = 14, ...rest }: IconProps = {}) {
  return (
    <Svg size={size} {...rest}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </Svg>
  );
}

export function ArrowDownIcon({ size = 14, ...rest }: IconProps = {}) {
  return (
    <Svg size={size} {...rest}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <polyline points="19 12 12 19 5 12" />
    </Svg>
  );
}

export function GitBranchIcon({ size = 12, ...rest }: IconProps = {}) {
  return (
    <Svg size={size} {...rest}>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </Svg>
  );
}

export function PaperPlaneIcon({ size = 14, ...rest }: IconProps = {}) {
  return (
    <Svg size={size} {...rest}>
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </Svg>
  );
}

/**
 * Paperclip — chat attachment affordance (#1670). Simple curve outline
 * matching the visual weight of the other 14-px icons in this set.
 */
export function PaperclipIcon({ size = 14, ...rest }: IconProps = {}) {
  return (
    <Svg size={size} {...rest}>
      <path d="M21.44 11.05L12.25 20.24a6 6 0 0 1-8.49-8.49l8.49-8.49a4 4 0 0 1 5.66 5.66l-8.49 8.49a2 2 0 0 1-2.83-2.83l7.07-7.07" />
    </Svg>
  );
}

/**
 * Generic file icon for non-image attachment chips (#1670). Folded-corner
 * rectangle matching standard "document" semantics.
 */
export function FileIcon({ size = 14, ...rest }: IconProps = {}) {
  return (
    <Svg size={size} {...rest}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </Svg>
  );
}

/**
 * Spinner. Pure CSS rotation — no JS animation loop. Stroke uses
 * `currentColor` with a transparent gap so the spinner reads as a
 * partial arc tracing around the circle.
 *
 * The `.shimmer` exception in `index.css`'s prefers-reduced-motion
 * shield ALSO carves out the `.spinner` class, so this icon keeps
 * rotating even for users who request reduced motion (it's a critical
 * loading affordance, not decorative).
 */
export function SpinnerIcon({ size = 14, ...rest }: IconProps = {}) {
  return (
    <Svg size={size} {...rest} className={`spinner${rest.className ? ` ${rest.className}` : ''}`}>
      <circle cx="12" cy="12" r="9" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" />
    </Svg>
  );
}

export function PlugIcon({ size = 14, ...rest }: IconProps = {}) {
  return (
    <Svg size={size} {...rest}>
      <path d="M9 2v6" />
      <path d="M15 2v6" />
      <path d="M6 8h12v3a6 6 0 0 1-12 0z" />
      <path d="M12 17v5" />
    </Svg>
  );
}

export function CpuIcon({ size = 14, ...rest }: IconProps = {}) {
  return (
    <Svg size={size} {...rest}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" />
    </Svg>
  );
}

export function SlidersIcon({ size = 14, ...rest }: IconProps = {}) {
  return (
    <Svg size={size} {...rest}>
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="20" y2="18" />
      <circle cx="9" cy="6" r="2" />
      <circle cx="15" cy="12" r="2" />
      <circle cx="7" cy="18" r="2" />
    </Svg>
  );
}

export function BrainIcon({ size = 14, ...rest }: IconProps = {}) {
  return (
    <Svg size={size} {...rest}>
      <path d="M9.5 3a3 3 0 0 0-3 3 3 3 0 0 0-3 3 3 3 0 0 0 1 5.5 3 3 0 0 0 1 4.5 3 3 0 0 0 4 0V3z" />
      <path d="M14.5 3a3 3 0 0 1 3 3 3 3 0 0 1 3 3 3 3 0 0 1-1 5.5 3 3 0 0 1-1 4.5 3 3 0 0 1-4 0V3z" />
    </Svg>
  );
}

export function BellIcon({ size = 14, ...rest }: IconProps = {}) {
  return (
    <Svg size={size} {...rest}>
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </Svg>
  );
}

export function TerminalIcon({ size = 14, ...rest }: IconProps = {}) {
  return (
    <Svg size={size} {...rest}>
      <polyline points="4 7 9 12 4 17" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </Svg>
  );
}

export function EyeIcon({ size = 14, ...rest }: IconProps = {}) {
  return (
    <Svg size={size} {...rest}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  );
}

export function InfoIcon({ size = 14, ...rest }: IconProps = {}) {
  return (
    <Svg size={size} {...rest}>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <circle cx="12" cy="8" r="0.5" fill="currentColor" />
    </Svg>
  );
}

export function BugIcon({ size = 14, ...rest }: IconProps = {}) {
  return (
    <Svg size={size} {...rest}>
      <rect x="8" y="6" width="8" height="14" rx="4" />
      <path d="M9 4l2 2M15 4l-2 2" />
      <path d="M3 13h5M16 13h5M5 8l3 2M19 8l-3 2M5 18l3-2M19 18l-3-2" />
    </Svg>
  );
}

export function CheckSquareIcon({ size = 14, ...rest }: IconProps = {}) {
  return (
    <Svg size={size} {...rest}>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <polyline points="8 12 11 15 16 9" />
    </Svg>
  );
}

export function LockIcon({ size = 14, ...rest }: IconProps = {}) {
  return (
    <Svg size={size} {...rest}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </Svg>
  );
}

export function CheckIcon({ size = 14, ...rest }: IconProps = {}) {
  return (
    <Svg size={size} {...rest}>
      <polyline points="5 12 10 17 19 7" />
    </Svg>
  );
}
