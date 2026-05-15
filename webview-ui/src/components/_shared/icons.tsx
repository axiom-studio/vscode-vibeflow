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
