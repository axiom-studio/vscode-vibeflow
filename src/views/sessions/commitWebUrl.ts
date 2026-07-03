/**
 * Derive the web page URL for a commit from a git remote URL (#3350).
 *
 * Used as the fallback when a chat commit-hash click can't be served
 * from the local repository (commit not fetched, checkout behind, or
 * the agent committed from another machine) — the remote web page can
 * still show the source, since agents auto-push after every commit.
 *
 * Pure and vscode-free so the URL grammar is unit-testable. Returns
 * undefined when the remote URL or hash doesn't parse — callers treat
 * that as "no web fallback available".
 */

const RE_HASH = /^[a-f0-9]{7,40}$/;

/** `git@host:owner/repo(.git)` — the scp-like syntax git favors for SSH. */
const RE_SCP = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):([A-Za-z0-9._/-]+?)(?:\.git)?\/?$/;

export function commitWebUrl(remoteUrl: string, hash: string): string | undefined {
  if (!RE_HASH.test(hash)) { return undefined; }
  const parsed = parseRemote(remoteUrl.trim());
  if (!parsed) { return undefined; }
  const { host, path } = parsed;
  return `https://${host}/${path}/${commitSegment(host)}/${hash}`;
}

function parseRemote(remote: string): { host: string; path: string } | undefined {
  if (!remote) { return undefined; }

  // URL forms: https://, http://, ssh://, git:// — URL() handles them all
  // once given a parseable scheme. Drop user info, `.git`, trailing slash.
  if (/^(?:https?|ssh|git):\/\//.test(remote)) {
    try {
      const url = new URL(remote);
      const path = url.pathname.replace(/\.git$/, '').replace(/^\/+|\/+$/g, '');
      if (!url.hostname || !path.includes('/')) { return undefined; }
      return { host: url.hostname, path };
    } catch {
      return undefined;
    }
  }

  // scp-like form: git@github.com:owner/repo.git
  const m = remote.match(RE_SCP);
  if (m) {
    const path = m[2].replace(/^\/+/, '');
    if (!path.includes('/')) { return undefined; }
    return { host: m[1], path };
  }
  return undefined;
}

/**
 * Whether two git remote URLs point at the same repository (#3355),
 * regardless of transport form (scp-like vs https vs ssh://), `.git`
 * suffix, user info, or host casing. Used to decide when a chat's
 * commit hash cannot possibly resolve from the open workspace repo.
 * Unparseable inputs compare as NOT the same repo (fail open to the
 * local-first flow).
 */
export function sameRepo(remoteA: string, remoteB: string): boolean {
  const a = parseRemote(remoteA.trim());
  const b = parseRemote(remoteB.trim());
  if (!a || !b) { return false; }
  return a.host.toLowerCase() === b.host.toLowerCase()
    && a.path.toLowerCase() === b.path.toLowerCase();
}

/**
 * Commit-page path segment per host family. GitHub-style `/commit/` is
 * also what Gitea/Gogs/Forgejo use, so it's the default for unknown hosts.
 */
function commitSegment(host: string): string {
  if (host === 'bitbucket.org' || host.startsWith('bitbucket.')) { return 'commits'; }
  if (host.includes('gitlab')) { return '-/commit'; }
  return 'commit';
}
