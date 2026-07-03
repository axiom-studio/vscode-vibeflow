import * as fs from 'fs';
import * as path from 'path';
import type { VibeFlowSession } from '../api/types.js';

const SIDECAR_PREFIX = '.vibeflow-session-';

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
      const sidecar = path.join(session.working_directory, SIDECAR_PREFIX + session.persona_key);
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
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const sessionId = content.trim();
    return sessionId.startsWith('session-') ? sessionId : undefined;
  } catch {
    return undefined;
  }
}
