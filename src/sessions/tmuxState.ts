import { execSync } from 'child_process';

/**
 * Local-tmux probe for the vibeflow CLI's session state.
 *
 * The CLI runs every agent in a tmux session under a custom socket
 * (`-L vibeflow`) — see vibeflow-cli/internal/vibeflowcli/tmux.go. Its
 * own status logic is purely local: pane alive → "running"; pane
 * exited → "exited". The backend's `session.active` flag, by contrast,
 * tracks Redis heartbeats from the agent's wait_for_work polls.
 *
 * The two can disagree:
 *   - Pane alive + heartbeat fresh → genuinely running
 *   - Pane alive + heartbeat stale → "stalled" (agent left wait_for_work
 *     without re-entering it — a polling-contract violation)
 *   - Pane dead + heartbeat fresh → "ghost" (rare; backend cache stale)
 *   - Pane dead + heartbeat stale → exited
 *
 * SessionsTreeProvider consults this probe when CLI mode is on so the
 * Agent Fleet can show all four cases instead of just collapsing on
 * the backend view. Outside CLI mode, the extension owns terminals
 * directly via TerminalRegistry — there's no tmux involvement.
 */

const TMUX_SOCKET = 'vibeflow';

/**
 * Returns the set of live VibeFlow tmux session names. Names follow
 * the CLI's FullSessionName convention `vibeflow_{provider}-{session_id}`
 * (or `vibeflow_{session_id}` when no provider was set).
 *
 * Returns an empty set when:
 *   - tmux isn't installed
 *   - the vibeflow socket has no server (no sessions ever launched)
 *   - the command times out or errors
 *
 * Never throws — callers treat absent-from-set as "tmux dead" and the
 * UI degrades gracefully when tmux isn't available at all.
 */
export function getLiveTmuxSessions(): Set<string> {
  try {
    const out = execSync(
      `tmux -L ${TMUX_SOCKET} list-sessions -F '#{session_name}'`,
      {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      },
    ).toString();
    return new Set(
      out.split('\n').map(s => s.trim()).filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

/**
 * Build the tmux session name a CLI launch would have used for the
 * given provider + session_id. Mirrors
 * vibeflow-cli/internal/vibeflowcli/tmux.go FullSessionName.
 */
export function buildTmuxName(provider: string, sessionId: string): string {
  if (provider) { return `vibeflow_${provider}-${sessionId}`; }
  return `vibeflow_${sessionId}`;
}
