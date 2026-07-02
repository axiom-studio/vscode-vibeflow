import type { VibeFlowSession } from '../api/types.js';
import { buildTmuxName } from './tmuxState.js';

/**
 * One source of truth for "is this session alive, and how?" — the predicate
 * the Agent Fleet tree, the activity poller, and the chat participant all
 * need. Pure + vscode-free so the tmux cross-check matrix is tested at a
 * single interface instead of re-derived per consumer.
 */
export type SessionStatus = 'active' | 'stale' | 'inactive' | 'stalled' | 'ghost';

/**
 * Derive a display status from server-side `active`/`stale` flags PLUS the
 * optional local tmux probe.
 *
 * Backend-only states (used always):
 *   - `active: true, stale: false` → 'active'   (green, full heartbeat)
 *   - `active: true, stale: true`  → 'stale'    (yellow, heartbeat expired)
 *   - `active: false`              → 'inactive' (gray, no record on server)
 *
 * Cross-check states (used when CLI mode is on and we have a tmux probe):
 *   - tmux pane alive + backend inactive → 'stalled' — pane is up but the
 *     agent has stopped polling wait_for_work; the polling-contract violation
 *     where the user sees "running per CLI but not in fleet"
 *
 * Absence from the local tmux probe is advisory, not authoritative: Agent Fleet
 * shows all project sessions, including sessions launched outside this VS Code
 * window. A missing local pane must not downgrade a fresh backend heartbeat.
 */
export function deriveSessionStatus(
  s: VibeFlowSession,
  liveTmuxSessions?: Set<string>,
): SessionStatus {
  // Decide the backend's view first.
  const backendActive = !!s.active;
  const backendStale = !!s.stale;

  // Without a tmux probe (CLI mode off, or tmux not available), fall back to
  // the legacy 3-state derivation.
  if (!liveTmuxSessions) {
    if (!backendActive) { return 'inactive'; }
    if (backendStale) { return 'stale'; }
    return 'active';
  }

  // Cross-check local tmux presence against the backend view. Only the positive
  // local signal is authoritative: a pane that exists while the backend is
  // inactive is definitely stalled. A missing pane is ambiguous because the
  // session may have been launched from another window, machine, or runtime.
  const tmuxAlive = liveTmuxSessions.has(buildTmuxName(s.agent_type ?? '', s.session_id));

  if (tmuxAlive && backendActive && !backendStale) { return 'active'; }
  if (tmuxAlive && backendActive && backendStale)  { return 'stale'; }
  if (tmuxAlive && !backendActive)                  { return 'stalled'; }
  if (backendActive && backendStale)                { return 'stale'; }
  if (backendActive)                                { return 'active'; }
  return 'inactive';
}

/**
 * Shallow "has a live backend heartbeat" predicate — `active && !stale`. The
 * activity poller and chat participant only care about this, independent of
 * any local tmux probe.
 */
export function isActiveSession(s: VibeFlowSession): boolean {
  return !!s.active && !s.stale;
}

/**
 * Whether a derived status counts as a live presence (backend OR a local
 * tmux pane). Drives the fleet's "N agents" count — `ghost`/`inactive`
 * don't count, but a `stalled` pane does.
 */
export function isLiveStatus(status: SessionStatus): boolean {
  return status === 'active' || status === 'stale' || status === 'stalled';
}
