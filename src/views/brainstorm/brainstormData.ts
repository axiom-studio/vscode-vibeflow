import type {
  VibeFlowBrainstormSession,
  VibeFlowBrainstormResponse,
  BrainstormDetailResponse,
} from '../../api/types.js';
import type { BrainstormSnapshot } from '../../core/webviewMessages.js';

/**
 * Brainstorm snapshot composer (feature 473, design doc #361). Pure + vitest-
 * testable (no vscode import) — mirrors `kanbanData.ts`. The host fetches the
 * REST pieces (list + get + per-round responses + the working doc) and folds
 * them into the single `BrainstormSnapshot` the webview renders, so the webview
 * never touches the network.
 */

/** Statuses where a brainstorm is no longer running. */
export const TERMINAL_BRAINSTORM_STATUSES = new Set(['done', 'cancelled']);

/**
 * A brainstorm is "active" while it isn't done/cancelled — matches the backend's
 * own definition of an active session (axiomcloud vibeflow_brainstorms.go:168).
 */
export function isActiveBrainstorm(session: { status: string }): boolean {
  return !TERMINAL_BRAINSTORM_STATUSES.has(session.status);
}

/**
 * The one brainstorm to AUTO-OPEN on panel load — only an active one. We
 * deliberately do NOT fall back to the most-recent finished brainstorm here:
 * when nothing is active the panel should land on the LIST (so the user can
 * start a new one), not get stuck showing a done session (#2416).
 */
export function pickActiveBrainstorm(list: VibeFlowBrainstormSession[]): VibeFlowBrainstormSession | undefined {
  return list.find(isActiveBrainstorm);
}

/**
 * Convergence 0..1 for the detail view. The backend's `convergence_score` is
 * currently always 0 (CheckConvergence + UpdateBrainstormRoundSnapshot are
 * unwired in axiomcloud), so we compute the proxy the backend WOULD compute —
 * the fraction of actionable responses that are resolved — but prefer a real
 * backend value if any round ever reports one (> 0). (#2416)
 */
export function computeConvergence(
  rounds: { convergence_score?: number; responses: VibeFlowBrainstormResponse[] }[],
): number {
  const backendMax = rounds.reduce((m, r) => Math.max(m, r.convergence_score ?? 0), 0);
  if (backendMax > 0) { return Math.min(1, backendMax); }

  let actionable = 0, open = 0, total = 0;
  for (const r of rounds) {
    for (const resp of r.responses) {
      total++;
      if (resp.response_type === 'approved' || resp.response_type === 'followup_answer') { continue; }
      actionable++;
      if ((resp.resolution_status ?? 'open') === 'open') { open++; }
    }
  }
  if (total === 0) { return 0; }                 // nothing said yet → 0%
  if (actionable === 0) { return 1; }            // everything was approval/answer → fully converged
  return (actionable - open) / actionable;       // resolved fraction of actionable items
}

export interface ComposeBrainstormInput {
  serverUrl: string;
  /** Force the landing list (user backed out of a detail view). */
  listMode?: boolean;
  /** GET /brainstorms/{id} for the selected/active brainstorm; absent → list. */
  detail?: BrainstormDetailResponse;
  /** round_number → that round's responses (GET /brainstorms/{id}/rounds/{n}). */
  roundResponses?: Record<number, VibeFlowBrainstormResponse[]>;
  /** Rendered working-draft markdown. */
  documentMarkdown?: string;
  /** Personas with a live (heartbeating) session — powers the start-flow gate. */
  activePersonas?: { key: string; sessionId: string }[];
  /** All sessions for the project (history dropdown). */
  history?: VibeFlowBrainstormSession[];
}

/** Fold the fetched REST pieces into one snapshot for the webview. */
export function composeBrainstormSnapshot(input: ComposeBrainstormInput): BrainstormSnapshot {
  const { serverUrl, listMode, detail, roundResponses, documentMarkdown, activePersonas = [], history } = input;

  // No detail (or explicitly backed out) → the landing list. The list view
  // renders the history + a "New brainstorm" entry (and its own empty state).
  if (listMode || !detail) {
    return { serverUrl, mode: 'list', activePersonas, history };
  }

  const mode: BrainstormSnapshot['mode'] = isActiveBrainstorm(detail.session) ? 'live' : 'closed';

  // Merge per-round metadata (convergence) with each round's responses, oldest first.
  const rounds = (detail.rounds ?? [])
    .slice()
    .sort((a, b) => a.round_number - b.round_number)
    .map(r => ({
      round_number: r.round_number,
      convergence_score: r.convergence_score,
      responses: roundResponses?.[r.round_number] ?? [],
    }));

  return {
    serverUrl,
    mode,
    activePersonas,
    session: detail.session,
    progress: detail.progress,
    rounds,
    convergence: computeConvergence(rounds),
    documentMarkdown,
    history,
  };
}
