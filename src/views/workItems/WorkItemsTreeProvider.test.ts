import { describe, it, expect, vi, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { WorkItemsTreeProvider } from './WorkItemsTreeProvider.js';

/**
 * #3115 — the "Work Item Complete" toast used to fire on every !done → done
 * transition across the project-wide work-item list, so a teammate's (or
 * another user's agent's) item completing notified this window. It must be
 * scoped to the user's own sessions, mirroring the ActivityPoller gate (#3348).
 *
 * notifyCompletions only reads this.todos/this.issues + the ownership gate, so
 * the test drives it directly (the PollingCoordinator is unused on this path).
 */
describe('WorkItemsTreeProvider — completion toast ownership scope (#3115)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('toasts only completions claimed by the user\'s own sessions', () => {
    // notifications.workItemComplete defaults on.
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(
      { get: (_key: string, dflt: unknown) => dflt } as never,
    );
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);

    const p = new WorkItemsTreeProvider({} as never);
    p.setOwnership(id => id === 'session-mine');

    // Baseline poll — everything still implementing → seeds silently.
    (p as unknown as { todos: unknown[] }).todos = [
      { id: 1, status: 'implementing', title: 'Mine', claimed_by: 'session-mine' },
      { id: 2, status: 'implementing', title: 'Theirs', claimed_by: 'session-other' },
      { id: 3, status: 'implementing', title: 'Unclaimed' },
    ];
    (p as unknown as { issues: unknown[] }).issues = [];
    (p as unknown as { notifyCompletions(): void }).notifyCompletions();
    expect(info).not.toHaveBeenCalled();

    // Next poll — all three flip to done.
    (p as unknown as { todos: unknown[] }).todos = [
      { id: 1, status: 'done', title: 'Mine', claimed_by: 'session-mine' },
      { id: 2, status: 'done', title: 'Theirs', claimed_by: 'session-other' },
      { id: 3, status: 'done', title: 'Unclaimed' },
    ];
    (p as unknown as { notifyCompletions(): void }).notifyCompletions();

    // Only the item claimed by our own session notifies — not the teammate's,
    // not the unclaimed one.
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toContain('#1');
  });
});
