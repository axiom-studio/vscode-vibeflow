import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CloudRunnerManageView } from './CloudRunnerManageView';
import { getVsCodeApi } from '../vscodeApi';
import type { CloudRunnerManageState } from '../../../src/core/webviewMessages';

function baseState(over: Partial<CloudRunnerManageState> = {}): CloudRunnerManageState {
  return {
    step: 'configure', runnerName: 'runner-a', agentType: 'claude', authMode: 'oauth',
    authenticated: false, configured: false, podStatus: '', podReady: false,
    needsPasteBack: true, repos: [], gitProviders: [],
    defaultProject: '', launching: false, busy: false, hydrated: true, ...over,
  };
}

function pushState(s: CloudRunnerManageState) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'manageState', payload: s } }));
  });
}

/**
 * The host's REAL hydrate sequence (#2885/#2886): `hydrate()` pushes `busy: true`
 * with the constructor defaults (agentType '', no savedConfig) BEFORE its REST
 * calls resolve, and only then pushes the loaded state. Tests that push the
 * loaded state alone can't see mount-ordering bugs — this helper reproduces the
 * sequence a real user hits.
 */
function hydrateSequence(loaded: Partial<CloudRunnerManageState>) {
  pushState(baseState({ step: 'configure', agentType: '', savedConfig: undefined, busy: true, hydrated: false }));
  pushState(baseState({ step: 'configure', ...loaded }));
}

describe('CloudRunnerManageView', () => {
  it('requests wizard state on mount', () => {
    const spy = vi.spyOn(getVsCodeApi(), 'postMessage');
    render(<CloudRunnerManageView />);
    expect(spy).toHaveBeenCalledWith({ type: 'manageLoad' });
    spy.mockRestore();
  });

  it('shows pod-starting on the Authenticate step until the pod is ready', () => {
    render(<CloudRunnerManageView />);
    pushState(baseState({ step: 'authenticate', podReady: false, podStatus: 'pending' }));
    expect(screen.getByText(/Pod is starting/)).toBeTruthy();
  });

  it('starts OAuth once the pod is ready', () => {
    const spy = vi.spyOn(getVsCodeApi(), 'postMessage');
    render(<CloudRunnerManageView />);
    pushState(baseState({ step: 'authenticate', podReady: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Start authentication' }));
    expect(spy).toHaveBeenCalledWith({ type: 'manageStartOAuth' });
    spy.mockRestore();
  });

  it('shows a loading state on Start authentication while the OAuth-start call is in flight (#3109)', () => {
    render(<CloudRunnerManageView />);
    pushState(baseState({ step: 'authenticate', podReady: true, busy: true }));
    const btn = screen.getByRole('button', { name: 'Starting…' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Start authentication' })).toBeNull();
  });

  it('marks the current wizard step with aria-current (#3110)', () => {
    render(<CloudRunnerManageView />);
    pushState(baseState({ step: 'configure', authMode: 'oauth' }));
    // Only the current step (Configure) carries aria-current=step; a passed step does not.
    expect(screen.getByText('Configure').closest('[aria-current="step"]')).toBeTruthy();
    expect(screen.getByText('Authenticate').closest('[aria-current="step"]')).toBeNull();
  });

  it('submits a pasted code for claude (needsPasteBack)', () => {
    const spy = vi.spyOn(getVsCodeApi(), 'postMessage');
    render(<CloudRunnerManageView />);
    pushState(baseState({ step: 'authenticate', podReady: true, oauthUrl: 'https://auth', oauthCode: 'WXYZ', needsPasteBack: true }));
    fireEvent.change(screen.getByPlaceholderText('verification code'), { target: { value: 'abc123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit code' }));
    expect(spy).toHaveBeenCalledWith({ type: 'manageSubmitOAuth', payload: { code: 'abc123' } });
    spy.mockRestore();
  });

  it('shows a clean sign-in link (not the raw URL) and copies URL + device code (#2905)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CloudRunnerManageView />);
    pushState(baseState({ step: 'authenticate', podReady: true, oauthUrl: 'https://auth.example/x?state=abc', oauthCode: 'WXYZ', needsPasteBack: true }));

    // The full URL is on the link href, not dumped as visible text.
    const link = screen.getByRole('link', { name: 'Open sign-in page ↗' }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://auth.example/x?state=abc');
    expect(screen.queryByText('https://auth.example/x?state=abc')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('https://auth.example/x?state=abc');
    expect(writeText).toHaveBeenCalledWith('WXYZ');
  });

  it('disables Launch until a working dir, project and persona are set', () => {
    render(<CloudRunnerManageView />);
    pushState(baseState({ step: 'configure' }));
    const launch = screen.getByRole('button', { name: 'Launch' }) as HTMLButtonElement;
    expect(launch.disabled).toBe(true);
  });

  it('enables Launch and posts the config once the form is valid', () => {
    const spy = vi.spyOn(getVsCodeApi(), 'postMessage');
    render(<CloudRunnerManageView />);
    pushState(baseState({ step: 'configure', repos: [{ path: '/workspace/repos/app', branch: 'main' }], defaultProject: 'proj-x' }));
    // working dir auto-selects the sole repo; project defaults to proj-x; pick a persona
    fireEvent.click(screen.getByLabelText('principal_engineer'));
    const launch = screen.getByRole('button', { name: 'Launch' }) as HTMLButtonElement;
    expect(launch.disabled).toBe(false);
    fireEvent.click(launch);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'manageLaunch',
      payload: expect.objectContaining({ workingDir: '/workspace/repos/app', project: 'proj-x', personas: ['principal_engineer'] }),
    }));
    spy.mockRestore();
  });

  it('enables Launch with only an advisory persona — no workspace agent required (#3111)', () => {
    render(<CloudRunnerManageView />);
    pushState(baseState({ step: 'configure', repos: [{ path: '/workspace/repos/app', branch: 'main' }], defaultProject: 'proj-x' }));
    fireEvent.click(screen.getByLabelText('qa_lead')); // advisory only, no workspace agent
    expect((screen.getByRole('button', { name: 'Launch' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('renders Project read-only (fixed to the current project, #3111)', () => {
    render(<CloudRunnerManageView />);
    pushState(baseState({ step: 'configure', defaultProject: 'proj-x' }));
    // The project name is shown, but there is no editable textbox for it.
    expect(screen.getByText('proj-x')).toBeTruthy();
    expect(screen.queryByPlaceholderText('vibeflow project name')).toBeNull();
  });

  it('shows a loading state on Submit code while busy (#3111)', () => {
    render(<CloudRunnerManageView />);
    pushState(baseState({ step: 'authenticate', podReady: true, oauthUrl: 'https://auth', needsPasteBack: true, busy: true }));
    // Type a code so the button is enabled-modulo-busy, then assert the busy label.
    fireEvent.change(screen.getByPlaceholderText('verification code'), { target: { value: 'ABCD' } });
    expect(screen.getByRole('button', { name: 'Submitting…' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Submit code' })).toBeNull();
  });

  it('holds Loading… on the busy-first hydrate push instead of mounting a step (#2885)', () => {
    render(<CloudRunnerManageView />);
    pushState(baseState({ step: 'configure', agentType: '', savedConfig: undefined, busy: true, hydrated: false }));
    // Mounting Configure here is what latched blanks into its state initializers.
    expect(screen.queryByRole('button', { name: 'Launch' })).toBeNull();
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('pre-fills Configure from the saved manifest across the host two-push hydrate (#2885)', () => {
    const spy = vi.spyOn(getVsCodeApi(), 'postMessage');
    render(<CloudRunnerManageView />);
    hydrateSequence({
      agentType: 'claude',
      defaultProject: 'proj-x',
      repos: [{ path: '/workspace/repos/app', branch: 'develop' }],
      savedConfig: {
        personas: ['developer'], sessionType: 'vanilla', branch: 'develop',
        worktree: true, worktreeName: 'wt-1', newBranch: true, llmGateway: true,
        skipPermissions: false, workingDir: '/workspace/repos/app', model: 'claude-opus-4.8',
      },
    });
    // An UNTOUCHED form must already be valid and must relaunch the saved config
    // verbatim — no field may fall back to a blank/default.
    const launch = screen.getByRole('button', { name: 'Launch' }) as HTMLButtonElement;
    expect(launch.disabled).toBe(false);
    fireEvent.click(launch);
    expect(spy).toHaveBeenCalledWith({
      type: 'manageLaunch',
      payload: {
        workingDir: '/workspace/repos/app', project: 'proj-x', personas: ['developer'],
        sessionType: 'vanilla', model: 'claude-opus-4.8', branch: 'develop',
        worktree: true, worktreeName: 'wt-1', newBranch: true, llmGateway: true, skipPermissions: false,
      },
    });
    spy.mockRestore();
  });

  it('reports a running session on the Launch step', () => {
    render(<CloudRunnerManageView />);
    pushState(baseState({ step: 'launch', launching: false, launchPhase: 'running' }));
    expect(screen.getByText(/Session is running/)).toBeTruthy();
  });

  it('opens the pod terminal from the header button', () => {
    const spy = vi.spyOn(getVsCodeApi(), 'postMessage');
    render(<CloudRunnerManageView />);
    pushState(baseState({ step: 'configure' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }));
    expect(spy).toHaveBeenCalledWith({ type: 'manageOpenTerminal' });
    spy.mockRestore();
  });

  it('reveals the clone form and posts manageClone with the provider id (credential re-injection path)', () => {
    const spy = vi.spyOn(getVsCodeApi(), 'postMessage');
    render(<CloudRunnerManageView />);
    pushState(baseState({ step: 'configure', gitProviders: [{ id: 7, name: 'gh-pat' }] }));
    fireEvent.click(screen.getByRole('button', { name: '+ Clone repository' }));
    fireEvent.change(screen.getByPlaceholderText('https://github.com/org/repo.git'), { target: { value: 'https://github.com/acme/app.git' } });
    fireEvent.change(screen.getByDisplayValue('None (public repos only)'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }));
    expect(spy).toHaveBeenCalledWith({
      type: 'manageClone',
      payload: { gitProviderId: 7, url: 'https://github.com/acme/app.git', branch: 'main' },
    });
    spy.mockRestore();
  });

  it('clones without a provider for public repos (gitProviderId omitted)', () => {
    const spy = vi.spyOn(getVsCodeApi(), 'postMessage');
    render(<CloudRunnerManageView />);
    pushState(baseState({ step: 'configure' }));
    fireEvent.click(screen.getByRole('button', { name: '+ Clone repository' }));
    fireEvent.change(screen.getByPlaceholderText('https://github.com/org/repo.git'), { target: { value: 'https://github.com/acme/pub.git' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }));
    expect(spy).toHaveBeenCalledWith({
      type: 'manageClone',
      payload: { gitProviderId: undefined, url: 'https://github.com/acme/pub.git', branch: 'main' },
    });
    spy.mockRestore();
  });

  it('keeps Clone disabled without a repository URL', () => {
    render(<CloudRunnerManageView />);
    pushState(baseState({ step: 'configure' }));
    fireEvent.click(screen.getByRole('button', { name: '+ Clone repository' }));
    const clone = screen.getByRole('button', { name: 'Clone' }) as HTMLButtonElement;
    expect(clone.disabled).toBe(true);
  });
});
