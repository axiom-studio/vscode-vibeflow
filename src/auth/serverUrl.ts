/**
 * Validate a VibeFlow server URL before any authenticated request rides it.
 *
 * The setup wizard, the CLI-config importer, and the Settings panel all
 * write a `vibeflow.serverUrl` value that subsequently has the API key
 * attached as a Bearer token on every REST and MCP call. If the scheme
 * is plaintext HTTP, every request leaks the key on-path. This helper
 * is the single point of truth for what a "safe" serverUrl looks like.
 *
 * Policy: HTTPS required EXCEPT for localhost / 127.0.0.1 (local dev),
 * matching the spec in issue #1745.
 */

export interface ValidationResult {
  ok: boolean;
  /** User-facing reason when ok is false. Pre-rendered for VSCode toasts. */
  message?: string;
  /** Parsed URL when ok is true — saves callers a second `new URL()` parse. */
  url?: URL;
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

export function validateServerUrl(raw: string): ValidationResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, message: 'Server URL is required.' };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, message: `Server URL is not a valid URL: ${trimmed}` };
  }

  if (url.protocol === 'https:') {
    return { ok: true, url };
  }

  if (url.protocol === 'http:' && LOCAL_HOSTNAMES.has(url.hostname)) {
    // Local dev — HTTP is acceptable. Note: url.hostname strips brackets
    // around `[::1]`, so the literal '::1' check above is correct.
    return { ok: true, url };
  }

  if (url.protocol === 'http:') {
    return {
      ok: false,
      message: 'Server URL must use HTTPS (HTTP allowed only for localhost).',
    };
  }

  return {
    ok: false,
    message: `Unsupported scheme "${url.protocol}". Use https:// or http://localhost.`,
  };
}
