import { describe, expect, it } from 'vitest';
import type { VibeFlowClient } from '../../api/client.js';
import type { ProjectDetector } from '../../project/ProjectDetector.js';
import { ProjectSelectorView, type ProjectSelectorState } from './ProjectSelectorView.js';

/** A resolved pane over a fake webview, recording every state it posts. */
function pane(opts: { authed?: boolean; projects?: { id: number; name: string }[]; fail?: string } = {}) {
  const posted: ProjectSelectorState[] = [];
  let send: (m: unknown) => Promise<void> = async () => {};
  const client = {
    isAuthenticated: () => opts.authed ?? true,
    listProjects: async () => {
      if (opts.fail) { throw new Error(opts.fail); }
      return opts.projects ?? [{ id: 2, name: 'zeta' }, { id: 1, name: 'alpha' }];
    },
  } as unknown as VibeFlowClient;
  const detector = { getCachedProject: () => undefined } as unknown as ProjectDetector;
  const view = new ProjectSelectorView({ client, detector, onSwitched: () => {} });
  view.resolveWebviewView({
    webview: {
      options: {}, html: '',
      postMessage: async (s: ProjectSelectorState) => { posted.push(s); return true; },
      onDidReceiveMessage: (cb: (m: unknown) => Promise<void>) => { send = cb; },
    },
    visible: true,
    onDidChangeVisibility: () => {},
    onDidDispose: () => {},
  } as never);
  return { view, posted, send: (m: unknown) => send(m) };
}

describe('ProjectSelectorView', () => {
  it('lists projects by name with the active one selected', async () => {
    const p = pane();
    p.view.setProject({ projectId: 2, projectName: 'zeta', gitRemoteUrl: '', gitBranch: 'main' });
    await new Promise(r => setTimeout(r, 0));
    expect(p.posted.at(-1)).toEqual({ kind: 'ready', projects: [{ id: 1, name: 'alpha' }, { id: 2, name: 'zeta' }], activeId: 2, branch: 'main' });
  });

  it('asks a signed-out user to sign in instead of listing projects', async () => {
    const p = pane({ authed: false });
    await p.send({ type: 'ready' });
    expect(p.posted.at(-1)).toEqual({ kind: 'signedOut' });
  });

  it('shows a load failure so the user can retry', async () => {
    const p = pane({ fail: 'offline' });
    await p.send({ type: 'ready' });
    expect(p.posted.at(-1)).toEqual({ kind: 'error', message: 'offline' });
  });
});
