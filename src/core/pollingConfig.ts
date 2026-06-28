import * as vscode from 'vscode';

/**
 * The two polling tiers, in milliseconds.
 *
 * Background views (trees, branch-review status, dashboard, compliance,
 * tickets) refresh on `vibeflow.polling.interval`; the live tier (Activity
 * Feed, open session chats, work-item panels, brainstorms) on the faster
 * `vibeflow.polling.liveInterval`. Both pause while the window is unfocused
 * (the PollingCoordinator handles that), and both are read at subscribe time —
 * like the trees always have — so a change takes effect on the next
 * (re)connect or panel reopen, not mid-session.
 */
export function backgroundIntervalMs(): number {
  return vscode.workspace.getConfiguration('vibeflow').get<number>('polling.interval', 30) * 1000;
}

export function liveIntervalMs(): number {
  return vscode.workspace.getConfiguration('vibeflow').get<number>('polling.liveInterval', 5) * 1000;
}
