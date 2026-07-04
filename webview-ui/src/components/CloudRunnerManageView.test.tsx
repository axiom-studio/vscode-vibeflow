import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CloudRunnerManageView } from './CloudRunnerManageView';
import { getVsCodeApi } from '../vscodeApi';
import type { CloudRunnerManageState } from '../../../src/core/webviewMessages';

function baseState(over: Partial<CloudRunnerManageState> = {}): CloudRunnerManageState {
  return {
    step: 'configure', runnerName: 'runner-a', agentType: 'claude', authMode: 'oauth',
    authenticated: false, configured: false, podStatus: '', podReady: false,
    needsPasteBack: true, repos: [], agentProjects: [], gitProviders: [],
    defaultProject: '', launching: false, busy: false, ...over,
  };
}

function pushState(s: CloudRunnerManageState) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'manageState', payload: s } }));
  });
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

  it('submits a pasted code for claude (needsPasteBack)', () => {
    const spy = vi.spyOn(getVsCodeApi(), 'postMessage');
    render(<CloudRunnerManageView />);
    pushState(baseState({ step: 'authenticate', podReady: true, oauthUrl: 'https://auth', oauthCode: 'WXYZ', needsPasteBack: true }));
    fireEvent.change(screen.getByPlaceholderText('verification code'), { target: { value: 'abc123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit code' }));
    expect(spy).toHaveBeenCalledWith({ type: 'manageSubmitOAuth', payload: { code: 'abc123' } });
    spy.mockRestore();
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
});
