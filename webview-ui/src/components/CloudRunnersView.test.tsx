import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CloudRunnersView, statusColor, formatCreatedAt } from './CloudRunnersView';
import { getVsCodeApi } from '../vscodeApi';
import type { CloudRunnerListRow } from '../../../src/core/webviewMessages';

function runner(overrides: Partial<CloudRunnerListRow> = {}): CloudRunnerListRow {
  return {
    id: 1, name: 'runner-a', status: 'active', podName: 'pod-0', podStatus: 'Running',
    lastStatusAt: '2026-07-04T10:00:00Z', studioRunnerId: 42, userId: 1, projectId: 28,
    createdAt: '2026-07-04T09:00:00Z', ...overrides,
  };
}

function pushData(runners: CloudRunnerListRow[]) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'cloudRunnersData', payload: { runners, generatedAt: '2026-07-04T12:00:00Z' } },
    }));
  });
}

function pushError(message: string) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'cloudRunnersError', payload: { message } },
    }));
  });
}

describe('statusColor', () => {
  it('maps known runner statuses and falls back to muted for unknown', () => {
    expect(statusColor('active')).toContain('feed-success');
    expect(statusColor('running')).toContain('feed-success'); // #3106 — was gray (no 'running' key)
    expect(statusColor('failed')).toContain('feed-error');
    expect(statusColor('starting')).toBe('#d29922');
    expect(statusColor('whatever')).toContain('feed-muted');
  });
});

describe('formatCreatedAt', () => {
  it('renders an em dash for empty and echoes an unparseable stamp', () => {
    expect(formatCreatedAt('')).toBe('—');
    expect(formatCreatedAt('not-a-date')).toBe('not-a-date');
  });

  it('formats a valid RFC3339 timestamp into something else', () => {
    const out = formatCreatedAt('2026-07-04T09:00:00Z');
    expect(out).not.toBe('—');
    expect(out).not.toBe('2026-07-04T09:00:00Z');
  });
});

describe('CloudRunnersView', () => {
  it('requests the runner list on mount', () => {
    const spy = vi.spyOn(getVsCodeApi(), 'postMessage');
    render(<CloudRunnersView />);
    expect(spy).toHaveBeenCalledWith({ type: 'cloudRunnersLoad' });
    spy.mockRestore();
  });

  it('shows the loading state before data arrives', () => {
    render(<CloudRunnersView />);
    expect(screen.getByText('Loading runners…')).toBeTruthy();
  });

  it('renders runner rows with user, repository, and branch details (#2825)', () => {
    render(<CloudRunnersView />);
    pushData([runner({
      id: 1, name: 'alpha', status: 'active', podStatus: 'Running', userId: 7,
      repos: [{ name: 'vscode-vibeflow', isGitRepo: true, branch: 'main' }],
    })]);
    expect(screen.getByText('alpha')).toBeTruthy();
    expect(screen.getByText('active')).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByText('#7')).toBeTruthy();
    expect(screen.getByText('vscode-vibeflow')).toBeTruthy();
    expect(screen.getByText('main')).toBeTruthy();
  });

  it('posts cloudRunnersCreate from the New Runner header button (#2894)', () => {
    const spy = vi.spyOn(getVsCodeApi(), 'postMessage');
    render(<CloudRunnersView />);
    pushData([runner({ id: 1, name: 'a' })]);
    fireEvent.click(screen.getByRole('button', { name: 'New Runner' }));
    expect(spy).toHaveBeenCalledWith({ type: 'cloudRunnersCreate' });
    spy.mockRestore();
  });

  it('selects runners and fans out a bulk stop over the eligible rows (#2893)', () => {
    const spy = vi.spyOn(getVsCodeApi(), 'postMessage');
    render(<CloudRunnersView />);
    pushData([
      runner({ id: 1, name: 'a', status: 'active' }),
      runner({ id: 2, name: 'b', status: 'stopped' }),
    ]);
    fireEvent.click(screen.getByLabelText('Select a'));
    fireEvent.click(screen.getByLabelText('Select b'));
    expect(screen.getByText('2 selected')).toBeTruthy();
    // Stop is eligible for the running runner only.
    fireEvent.click(screen.getByRole('button', { name: 'Stop 1' }));
    expect(spy).toHaveBeenCalledWith({
      type: 'cloudRunnerBulkStop',
      payload: { runners: [{ projectId: 28, id: 1 }] },
    });
    spy.mockRestore();
  });

  it('bulk-delete sends every selected runner with its name (#2893)', () => {
    const spy = vi.spyOn(getVsCodeApi(), 'postMessage');
    render(<CloudRunnersView />);
    pushData([runner({ id: 1, name: 'a', status: 'active' }), runner({ id: 2, name: 'b', status: 'stopped' })]);
    fireEvent.click(screen.getByLabelText('Select all runners'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete 2' }));
    expect(spy).toHaveBeenCalledWith({
      type: 'cloudRunnerBulkDelete',
      payload: { runners: [{ projectId: 28, id: 1, name: 'a' }, { projectId: 28, id: 2, name: 'b' }] },
    });
    spy.mockRestore();
  });

  it('renders the owner email when the server provides it, falling back to #userId (#2889)', () => {
    render(<CloudRunnersView />);
    pushData([
      runner({ id: 1, name: 'alpha', userId: 7, ownerEmail: 'vish@axiomstudio.ai' }),
      runner({ id: 2, name: 'beta', userId: 9 }),
    ]);
    expect(screen.getByText('vish@axiomstudio.ai')).toBeTruthy();
    expect(screen.queryByText('#7')).toBeNull();
    expect(screen.getByText('#9')).toBeTruthy();
  });

  it('renders dashes for repository/branch when the pod has no repos yet', () => {
    render(<CloudRunnersView />);
    pushData([runner({ id: 2, name: 'beta', repos: undefined })]);
    expect(screen.getByText('beta')).toBeTruthy();
    // Repo + Branch columns both fall back to an em dash.
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  it('shows an empty state when there are no runners', () => {
    render(<CloudRunnersView />);
    pushData([]);
    expect(screen.getByText('No cloud runners yet.')).toBeTruthy();
  });

  it('renders an error message from the host', () => {
    render(<CloudRunnersView />);
    pushError('Studio unreachable');
    expect(screen.getByText('Studio unreachable')).toBeTruthy();
  });

  it('re-requests on Refresh and returns to the loading state', () => {
    const spy = vi.spyOn(getVsCodeApi(), 'postMessage');
    render(<CloudRunnersView />);
    pushData([runner()]);
    expect(screen.queryByText('Loading runners…')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(spy).toHaveBeenCalledWith({ type: 'cloudRunnersRefresh' });
    expect(screen.getByText('Loading runners…')).toBeTruthy();
    spy.mockRestore();
  });
});

describe('CloudRunnersView — row actions (#2816)', () => {
  it('shows Stop for a running runner and posts cloudRunnerStop', () => {
    const spy = vi.spyOn(getVsCodeApi(), 'postMessage');
    render(<CloudRunnersView />);
    pushData([runner({ id: 5, projectId: 28, status: 'active' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(spy).toHaveBeenCalledWith({ type: 'cloudRunnerStop', payload: { projectId: 28, id: 5 } });
    spy.mockRestore();
  });

  it('shows Start for a stopped runner and posts cloudRunnerStart', () => {
    const spy = vi.spyOn(getVsCodeApi(), 'postMessage');
    render(<CloudRunnersView />);
    pushData([runner({ id: 6, projectId: 28, status: 'stopped' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(spy).toHaveBeenCalledWith({ type: 'cloudRunnerStart', payload: { projectId: 28, id: 6 } });
    spy.mockRestore();
  });

  it('shows a spinner (no Start/Stop) while transitioning', () => {
    render(<CloudRunnersView />);
    pushData([runner({ id: 7, status: 'starting' })]);
    expect(screen.getByText('Starting…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('posts cloudRunnerDelete with id + name', () => {
    const spy = vi.spyOn(getVsCodeApi(), 'postMessage');
    render(<CloudRunnersView />);
    pushData([runner({ id: 8, projectId: 28, name: 'gamma', status: 'active' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(spy).toHaveBeenCalledWith({ type: 'cloudRunnerDelete', payload: { projectId: 28, id: 8, name: 'gamma' } });
    spy.mockRestore();
  });

  it('shows Manage for a manageable runner and posts cloudRunnerManage', () => {
    const spy = vi.spyOn(getVsCodeApi(), 'postMessage');
    render(<CloudRunnersView />);
    pushData([runner({ id: 9, projectId: 28, name: 'delta', status: 'active' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
    expect(spy).toHaveBeenCalledWith({ type: 'cloudRunnerManage', payload: { projectId: 28, id: 9, name: 'delta' } });
    spy.mockRestore();
  });

  it('hides Manage for a stopped runner (not manageable)', () => {
    render(<CloudRunnersView />);
    pushData([runner({ id: 10, status: 'stopped' })]);
    expect(screen.queryByRole('button', { name: 'Manage' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Start' })).toBeTruthy();
  });

  it('does not render a second action button in the Status cell for a healthy runner', () => {
    // Regression: a healthy/running row used to render a "Manage Agents" button
    // inside the narrow Status column, which clipped to "Ma". The Status cell now
    // carries only the status text; the single primary action lives in Actions.
    render(<CloudRunnersView />);
    pushData([runner({ id: 11, projectId: 28, name: 'eps', status: 'running', podStatus: 'Healthy' })]);
    expect(screen.queryByRole('button', { name: 'Manage Agents' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Manage' })).toBeTruthy();
  });

  it('flips the primary action to Authenticate for an authenticating runner (web parity)', () => {
    const spy = vi.spyOn(getVsCodeApi(), 'postMessage');
    render(<CloudRunnersView />);
    pushData([runner({ id: 12, projectId: 28, name: 'zeta', status: 'authenticating', podStatus: 'Healthy' })]);
    // The one primary button reads Authenticate, not Manage, and still opens the wizard.
    expect(screen.queryByRole('button', { name: 'Manage' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Authenticate' }));
    expect(spy).toHaveBeenCalledWith({ type: 'cloudRunnerManage', payload: { projectId: 28, id: 12, name: 'zeta' } });
    spy.mockRestore();
  });
});
