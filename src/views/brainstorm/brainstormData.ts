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
 * Pick the one brainstorm to show. There's at most one ACTIVE per project
 * (backend invariant), so prefer it; otherwise fall back to the most recent
 * (ISO `created_at` sorts lexicographically) so the panel can replay history.
 */
export function pickCurrentBrainstorm(list: VibeFlowBrainstormSession[]): VibeFlowBrainstormSession | undefined {
  const active = list.find(isActiveBrainstorm);
  if (active) { return active; }
  return [...list].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))[0];
}

export interface ComposeBrainstormInput {
  serverUrl: string;
  /** GET /brainstorms/{id} for the current brainstorm; absent → empty state. */
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
  const { serverUrl, detail, roundResponses, documentMarkdown, activePersonas = [], history } = input;

  if (!detail) {
    return { serverUrl, mode: 'empty', activePersonas, history };
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
    documentMarkdown,
    history,
  };
}
