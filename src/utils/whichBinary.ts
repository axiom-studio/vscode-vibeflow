import { execFileSync } from 'child_process';

/**
 * Resolve a binary on the current process's PATH.
 *
 * Uses `which` (POSIX) / `where` (Windows) via execFileSync — argv form,
 * no shell — so a maliciously-named binary can't break out. Errors and
 * non-zero exits are swallowed and treated as "not found". `where` on
 * Windows can return multiple lines; the first wins (matches the
 * precedent in `cliCommands.resolveBinary`).
 *
 * Results memoize per process so the Settings snapshot build (which
 * calls this once per provider) doesn't fork four child processes on
 * every webview refresh. PATH changes are rare and re-activating the
 * extension clears the cache; if a user installs `claude` mid-session
 * and wants the status dot to flip, they'll need to reopen the panel
 * after a Reload Window. Cheap correctness trade-off.
 *
 * `null` in the cache means "looked up, not found" — distinct from a
 * cache miss.
 */
const cache = new Map<string, string | null>();

function lookup(name: string): string | null {
  const cached = cache.get(name);
  if (cached !== undefined) { return cached; }
  let resolved: string | null = null;
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, [name], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    resolved = out.split(/\r?\n/)[0]?.trim() || null;
  } catch {
    resolved = null;
  }
  cache.set(name, resolved);
  return resolved;
}

export function isBinaryOnPath(name: string): boolean {
  return lookup(name) !== null;
}

/**
 * Absolute path of `name` on PATH, or undefined when not found.
 * Used by `sessions/terminalLaunch.ts` to spawn agent binaries as the
 * terminal process (`shellPath`) — with no shell in the terminal there
 * is no shell to do PATH resolution for us (issue #4995).
 */
export function resolveBinaryPath(name: string): string | undefined {
  return lookup(name) ?? undefined;
}

export function clearWhichBinaryCache(): void {
  cache.clear();
}
