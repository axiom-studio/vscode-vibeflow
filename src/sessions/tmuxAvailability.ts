import { execFile } from 'child_process';
import * as os from 'os';

/**
 * Detect whether tmux is usable on this machine for the
 * opt-in headless-backing mode (todo #1615 — Chat-First Mode
 * #6). Windows always returns `{ available: false }` because
 * tmux is Unix only.
 *
 * Uses `tmux -V` (version probe — safe, side-effect-free) with
 * `execFile` argv form. Never shells out. Cached for the lifetime
 * of the extension host since users very rarely install/uninstall
 * tmux mid-session.
 */
let cached: { available: boolean; version?: string } | undefined;

export function detectTmuxAvailability(): Promise<{ available: boolean; version?: string }> {
  if (cached) { return Promise.resolve(cached); }
  if (os.platform() === 'win32') {
    cached = { available: false };
    return Promise.resolve(cached);
  }
  return new Promise(resolve => {
    execFile('tmux', ['-V'], { timeout: 1500 }, (err, stdout) => {
      if (err) {
        cached = { available: false };
        resolve(cached);
        return;
      }
      const out = String(stdout || '').trim();
      // `tmux 3.4` is the canonical output shape; degrade gracefully.
      const m = out.match(/tmux\s+([0-9a-z.-]+)/i);
      cached = { available: true, version: m ? m[1] : undefined };
      resolve(cached);
    });
  });
}

/**
 * Reset the cached availability result. Tests use this; users
 * shouldn't need to call it.
 */
export function resetTmuxAvailabilityCache(): void {
  cached = undefined;
}
