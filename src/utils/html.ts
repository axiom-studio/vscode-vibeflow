/**
 * Escape a string for safe interpolation into HTML templates.
 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The origin of the configured server URL, for inclusion in a webview CSP
 * source list (#2773). Carries the environment's real scheme — http for
 * local test servers, https in prod — so persona portraits and other
 * server-hosted assets load without a blanket `http:` allowance. Returns
 * '' for unparseable input or non-http(s) schemes so callers can safely
 * drop the token.
 */
export function serverOriginForCsp(serverUrl: string): string {
  try {
    const parsed = new URL(serverUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') { return ''; }
    return parsed.origin;
  } catch {
    return '';
  }
}
