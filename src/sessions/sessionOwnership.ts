import * as fs from 'fs';
import * as path from 'path';
import type { VibeFlowSession } from '../api/types.js';

const SIDECAR_PREFIX = '.vibeflow-session-';

const PERSONA_KEY_RE = /^[a-z0-9_]+$/;

/**
 * Whether `persona_key` is safe to interpolate into a sidecar filename
 * (CWE-22, #3383). Both `persona_key` and `working_directory` on a session
 * come from the PROJECT-WIDE session list, which — by this feature's own
 * threat model — includes sessions registered by other org members. The
 * backend accepts them as free-form strings, so a malicious peer could set
 * `persona_key = "x/../../../etc/passwd"` to make this window read an
 * arbitrary local path (and hang on a blocking special file like /dev/zero).
 * A single lowercase token cannot contain a path separator or `..`, so the
 * `path.join` stays a single segment inside `working_directory`.
 */
export function isSafePersonaKey(personaKey: string): boolean {
  return PERSONA_KEY_RE.test(personaKey);
}

/**
 * Tracks which VibeFlow sessions run "on behalf of the user" of this
 * VS Code window, so notification surfaces (prompt toasts, activity feed,
 * Working indicator) can drop org-wide noise from other users' agents.
 *
 * Ownership proof is the sidecar contract: every agent writes its
 * session_id to `.vibeflow-session-{persona}` inside the directory it runs
 * in (workspace root or a git worktree). A session is owned iff that
 * sidecar exists on THIS machine and carries the session's exact id —
 * session ids are unique per session, so a matching sidecar cannot belong
 * to another user's agent. The backend exposes no user identity on
 * sessions or prompts, so this local proof is the only reliable signal.
 *
 * The owned set only grows for the lifetime of this tracker (session ids
 * are never recycled), which keeps pending prompts from recently-ended
 * owned sessions notifying until they are resolved.
 */
export class SessionOwnershipTracker {
  private readonly owned = new Set<string>();

  constructor(private readonly workspaceRoot: string | undefined) {}

  /**
   * Refresh the owned set: pick up every sidecar in the workspace root
   * (covers sessions whose backend record is already gone, e.g. a pending
   * prompt from an agent that just exited), then verify each unowned
   * session against the sidecar in its own working_directory (covers
   * worktree sessions whose cwd is not the workspace root).
   *
   * O(sessions) with at most one file read per unowned session — cheap at
   * the live poll cadence because owned results are cached forever.
   */
  async refresh(sessions: readonly VibeFlowSession[]): Promise<void> {
    await this.scanRootSidecars();

    for (const session of sessions) {
      if (this.owned.has(session.session_id)) { continue; }
      if (!session.working_directory || !session.persona_key) { continue; }
      // #3383: persona_key/working_directory are attacker-controllable (see
      // isSafePersonaKey). Reject a persona_key that isn't a single token, then
      // require the resolved sidecar to sit DIRECTLY inside working_directory —
      // belt-and-suspenders against traversal via either field.
      if (!isSafePersonaKey(session.persona_key)) { continue; }
      const sidecar = path.join(session.working_directory, SIDECAR_PREFIX + session.persona_key);
      if (path.dirname(path.resolve(sidecar)) !== path.resolve(session.working_directory)) { continue; }
      if (await readSessionId(sidecar) === session.session_id) {
        this.owned.add(session.session_id);
      }
    }
  }

  isOwned(sessionId: string | undefined): boolean {
    return !!sessionId && this.owned.has(sessionId);
  }

  private async scanRootSidecars(): Promise<void> {
    if (!this.workspaceRoot) { return; }
    let files: string[];
    try {
      files = await fs.promises.readdir(this.workspaceRoot);
    } catch {
      return;
    }
    for (const file of files) {
      if (!file.startsWith(SIDECAR_PREFIX)) { continue; }
      const sessionId = await readSessionId(path.join(this.workspaceRoot, file));
      if (sessionId) { this.owned.add(sessionId); }
    }
  }
}

/** Read a sidecar file's session id; undefined when missing or malformed. */
async function readSessionId(filePath: string): Promise<string | undefined> {
  try {
    // #3383 defense-in-depth: only read REGULAR files. A blocking special
    // file (FIFO, /dev/zero) at the sidecar path would hang readFile and
    // stall the poll loop; stat resolves symlinks, so a symlink to a device
    // is skipped too. Regular sidecar files are unaffected.
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile()) { return undefined; }
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const sessionId = content.trim();
    return sessionId.startsWith('session-') ? sessionId : undefined;
  } catch {
    return undefined;
  }
}
