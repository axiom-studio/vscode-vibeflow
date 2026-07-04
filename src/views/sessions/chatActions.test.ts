import { describe, it, expect, vi, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { confirmAndOpenExternal } from './chatActions.js';

/**
 * #3386 (CWE-601) — a session's `git_remote_url` is cross-user-controllable on
 * a shared project, so a commit URL derived from it can point at an
 * attacker-chosen host. `confirmAndOpenExternal` must never auto-open: it
 * surfaces the destination host and requires an explicit "Open" click.
 */
describe('confirmAndOpenExternal (#3386)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does NOT open externally without confirmation, and surfaces the host', async () => {
    // The stub's showInformationMessage resolves undefined (no pick).
    const info = vi.spyOn(vscode.window, 'showInformationMessage');
    const open = vi.spyOn(vscode.env, 'openExternal');

    await confirmAndOpenExternal('https://evil.com/x/y/commit/abc1234');

    expect(open).not.toHaveBeenCalled();
    expect(String(info.mock.calls[0][0])).toContain('evil.com');
  });

  it('opens externally only after the user picks "Open"', async () => {
    vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((() => Promise.resolve('Open')) as never);
    const open = vi.spyOn(vscode.env, 'openExternal').mockImplementation((() => Promise.resolve(true)) as never);

    await confirmAndOpenExternal('https://good.example.com/acme/app/commit/abc1234');

    expect(open).toHaveBeenCalledTimes(1);
  });
});
