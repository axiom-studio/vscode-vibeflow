import type { VibeFlowPrompt } from '../../api/types.js';

/**
 * Update the set of chat rows still awaiting a response with a fresh page of
 * messages: any row seen as `pending` joins the set; any row seen in a
 * settled state (responded / expired / activity) leaves it. Returns a NEW
 * set so callers can keep their cursor state immutable. Pure and
 * vscode-free so both trackers below are unit-testable.
 */
export function nextPendingIds(prev: Set<number>, messages: VibeFlowPrompt[]): Set<number> {
  if (messages.length === 0) { return prev; }
  const next = new Set(prev);
  for (const m of messages) {
    if (m.status === 'pending') {
      next.add(m.id);
    } else {
      next.delete(m.id);
    }
  }
  return next;
}

/**
 * Same tracking, but only AGENT-authored pending prompts — the ones that
 * block on the human. Drives the panel-tab "❓ needs input" indicator
 * (#2774): non-agent rows and settled rows always leave the set, so the
 * indicator clears the moment the user answers or the prompt expires.
 */
export function nextAgentPendingIds(prev: Set<number>, messages: VibeFlowPrompt[]): Set<number> {
  if (messages.length === 0) { return prev; }
  const next = new Set(prev);
  for (const m of messages) {
    if (m.source === 'agent' && m.status === 'pending') {
      next.add(m.id);
    } else {
      next.delete(m.id);
    }
  }
  return next;
}
