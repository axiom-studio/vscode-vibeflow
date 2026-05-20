import { execFileSync } from 'child_process';

/**
 * Check whether a binary is resolvable on the current process's PATH.
 *
 * Uses `which` (POSIX) / `where` (Windows) via execFileSync — argv form,
 * no shell — so a maliciously-named binary can't break out. Errors and
 * non-zero exits are swallowed and treated as "not found".
 *
 * Results memoize per process so the Settings snapshot build (which
 * calls this once per provider) doesn't fork four child processes on
 * every webview refresh. PATH changes are rare and re-activating the
 * extension clears the cache; if a user installs `claude` mid-session
 * and wants the status dot to flip, they'll need to reopen the panel
 * after a Reload Window. Cheap correctness trade-off.
 */
const cache = new Map<string, boolean>();

export function isBinaryOnPath(name: string): boolean {
  const cached = cache.get(name);
  if (cached !== undefined) { return cached; }
  let found = false;
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(cmd, [name], { stdio: ['ignore', 'pipe', 'ignore'] });
    found = true;
  } catch {
    found = false;
  }
  cache.set(name, found);
  return found;
}

export function clearWhichBinaryCache(): void {
  cache.clear();
}
