import { useState, useEffect } from 'react';

interface Props {
  /** Absolute portrait URL — `{serverUrl}/persona/professional/...jpg`. */
  src?: string;
  /** Letter shown when src is missing OR when the image fails to load. */
  fallbackGlyph: string;
  /** Optional className applied to the wrapper (so existing avatar
   *  containers — `.msg-avatar`, `.rail-avatar`, etc. — keep their
   *  sizing rules from sessionChat.css). */
  className?: string;
}

/**
 * Shared avatar that prefers a portrait image and falls back to a
 * letter glyph in two cases:
 *   1. `src` is undefined (offline / unknown persona / serverUrl missing
 *      on the body — e.g. the chat panel was opened against an older
 *      host build that didn't stamp `data-vf-server-url`)
 *   2. The browser fails to load the image (404 / DNS / CSP)
 *
 * Self-healing so a transient image failure doesn't leave a broken-image
 * placeholder permanently visible.
 */
export function PersonaAvatar({ src, fallbackGlyph, className }: Props) {
  const [errored, setErrored] = useState(false);

  // Reset the error flag whenever the src actually changes — otherwise a
  // first-load 404 would suppress a subsequent successful URL.
  useEffect(() => { setErrored(false); }, [src]);

  if (!src || errored) {
    return (
      <div className={className} aria-hidden="true">
        {fallbackGlyph}
      </div>
    );
  }
  return (
    <div className={className} aria-hidden="true">
      <img src={src} alt="" onError={() => setErrored(true)} />
    </div>
  );
}
