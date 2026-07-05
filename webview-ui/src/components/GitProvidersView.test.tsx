import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { GitProvidersView } from './GitProvidersView';
import { getVsCodeApi } from '../vscodeApi';
import type { GitProviderView } from '../../../src/api/types';

/**
 * #2822 — the Browse-nav Git Providers page. `GitProviderView` is secret-free
 * by API design; these tests pin the list rendering, the delete intent
 * (id+name → host-side confirm), and the empty/error states.
 */

function provider(overrides: Partial<GitProviderView> = {}): GitProviderView {
  return { id: 1, name: 'my-github', gitUrl: 'https://github.com', authMode: 'pat', ...overrides };
}

function pushData(providers: GitProviderView[]) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'gitProvidersPageData', payload: { providers, generatedAt: '2026-07-05T12:00:00Z' } },
    }));
  });
}

function pushError(message: string) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'gitProvidersPageError', payload: { message } },
    }));
  });
}

describe('GitProvidersView', () => {
  it('requests the provider list on mount', () => {
    const spy = vi.spyOn(getVsCodeApi(), 'postMessage');
    render(<GitProvidersView />);
    expect(spy).toHaveBeenCalledWith({ type: 'gitProvidersPageLoad' });
    spy.mockRestore();
  });

  it('renders provider rows — name, host, auth badge — and no credential inputs', () => {
    const { container } = render(<GitProvidersView />);
    pushData([provider({ id: 1, name: 'work-gh', gitUrl: 'https://ghe.example.com', authMode: 'ssh' })]);
    expect(screen.getByText('work-gh')).toBeTruthy();
    expect(screen.getByText('https://ghe.example.com')).toBeTruthy();
    expect(screen.getByText('ssh')).toBeTruthy();
    // Read-only page: no input/textarea anywhere — a credential can neither
    // be entered nor displayed (the wire type carries none to begin with).
    expect(container.querySelectorAll('input, textarea').length).toBe(0);
  });

  it('shows an empty state pointing at Settings', () => {
    render(<GitProvidersView />);
    pushData([]);
    expect(screen.getByText(/No git providers yet/)).toBeTruthy();
  });

  it('renders an error message from the host', () => {
    render(<GitProvidersView />);
    pushError('Not connected — sign in first.');
    expect(screen.getByText('Not connected — sign in first.')).toBeTruthy();
  });

  it('posts gitProvidersPageDelete with id + name (host confirms)', () => {
    const spy = vi.spyOn(getVsCodeApi(), 'postMessage');
    render(<GitProvidersView />);
    pushData([provider({ id: 7, name: 'gitlab-main' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(spy).toHaveBeenCalledWith({ type: 'gitProvidersPageDelete', payload: { id: 7, name: 'gitlab-main' } });
    spy.mockRestore();
  });

  it('re-requests on Refresh and returns to the loading state', () => {
    const spy = vi.spyOn(getVsCodeApi(), 'postMessage');
    render(<GitProvidersView />);
    pushData([provider()]);
    expect(screen.queryByText('Loading git providers…')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(spy).toHaveBeenCalledWith({ type: 'gitProvidersPageRefresh' });
    expect(screen.getByText('Loading git providers…')).toBeTruthy();
    spy.mockRestore();
  });
});
