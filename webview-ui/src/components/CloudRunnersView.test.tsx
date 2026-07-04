import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CloudRunnersView, statusColor, formatCreatedAt } from './CloudRunnersView';
import { getVsCodeApi } from '../vscodeApi';
import type { GlobalCloudRunnerView } from '../../../src/api/types';

function runner(overrides: Partial<GlobalCloudRunnerView> = {}): GlobalCloudRunnerView {
  return {
    id: 1, name: 'runner-a', status: 'active', podName: 'pod-0', podStatus: 'Running',
    lastStatusAt: '2026-07-04T10:00:00Z', studioRunnerId: 42, userId: 1, projectId: 28,
    createdAt: '2026-07-04T09:00:00Z', projectName: 'vscode-vibeflow', ...overrides,
  };
}

function pushData(runners: GlobalCloudRunnerView[]) {
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

  it('renders runner rows from a data message', () => {
    render(<CloudRunnersView />);
    pushData([runner({ id: 1, name: 'alpha', status: 'active', podStatus: 'Running', projectName: 'proj-x' })]);
    expect(screen.getByText('alpha')).toBeTruthy();
    expect(screen.getByText('active')).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByText('proj-x')).toBeTruthy();
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
});
