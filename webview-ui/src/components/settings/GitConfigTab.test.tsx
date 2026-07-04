import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { GitConfigTab } from './GitConfigTab';
import type { SettingsCommand, GitProviderView } from './settingsTypes';

/** Simulate the host pushing a gitProvidersData message to the tab. */
function pushProviders(providers: GitProviderView[], error?: string) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'gitProvidersData', payload: { providers, error } },
    }));
  });
}

describe('GitConfigTab', () => {
  it('requests the git provider list on mount', () => {
    const commands: SettingsCommand[] = [];
    render(<GitConfigTab onCommand={c => commands.push(c)} />);
    expect(commands).toContainEqual({ type: 'gitProvidersList' });
  });

  it('renders providers pushed from the host', () => {
    render(<GitConfigTab onCommand={vi.fn()} />);
    pushProviders([{ id: 1, name: 'GitHub (work)', gitUrl: 'https://github.com', authMode: 'pat' }]);
    expect(screen.getByText('GitHub (work)')).toBeTruthy();
    expect(screen.getByText('https://github.com')).toBeTruthy();
  });

  it('renders an error message from the host', () => {
    render(<GitConfigTab onCommand={vi.fn()} />);
    pushProviders([], 'Not connected — sign in first.');
    expect(screen.getByText('Not connected — sign in first.')).toBeTruthy();
  });

  it('enables Add only with a name and a valid https URL, and posts create with NO secret', () => {
    const commands: SettingsCommand[] = [];
    render(<GitConfigTab onCommand={c => commands.push(c)} />);
    const addBtn = screen.getByRole('button', { name: 'Add configuration' }) as HTMLButtonElement;
    expect(addBtn.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Configuration name'), { target: { value: 'GitHub' } });
    fireEvent.change(screen.getByLabelText('Git host URL'), { target: { value: 'http://github.com' } });
    expect(addBtn.disabled).toBe(true); // http is rejected — only https

    fireEvent.change(screen.getByLabelText('Git host URL'), { target: { value: 'https://github.com' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'octocat' } });
    expect(addBtn.disabled).toBe(false);

    fireEvent.click(addBtn);
    const created = commands.filter(c => c.type === 'gitProviderCreate');
    expect(created).toEqual([{
      type: 'gitProviderCreate',
      payload: { name: 'GitHub', gitUrl: 'https://github.com', authType: 'pat', userName: 'octocat' },
    }]);
    // Security invariant: the wire payload must never carry a token/key.
    const payload = (created[0] as { payload: Record<string, unknown> }).payload;
    expect('accessToken' in payload).toBe(false);
    expect('sshPrivateKey' in payload).toBe(false);
  });

  it('omits an empty username from the PAT create payload', () => {
    const commands: SettingsCommand[] = [];
    render(<GitConfigTab onCommand={c => commands.push(c)} />);
    fireEvent.change(screen.getByLabelText('Configuration name'), { target: { value: 'GH' } });
    fireEvent.change(screen.getByLabelText('Git host URL'), { target: { value: 'https://github.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add configuration' }));
    expect(commands).toContainEqual({
      type: 'gitProviderCreate',
      payload: { name: 'GH', gitUrl: 'https://github.com', authType: 'pat' },
    });
  });

  it('hides Username for SSH and posts authType ssh with no userName', () => {
    const commands: SettingsCommand[] = [];
    render(<GitConfigTab onCommand={c => commands.push(c)} />);
    fireEvent.click(screen.getByLabelText('SSH key'));
    expect(screen.queryByLabelText('Username')).toBeNull();

    fireEvent.change(screen.getByLabelText('Configuration name'), { target: { value: 'work-ssh' } });
    fireEvent.change(screen.getByLabelText('Git host URL'), { target: { value: 'https://github.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add configuration' }));
    expect(commands).toContainEqual({
      type: 'gitProviderCreate',
      payload: { name: 'work-ssh', gitUrl: 'https://github.com', authType: 'ssh' },
    });
  });

  it('posts a delete command carrying id and name (host confirms)', () => {
    const commands: SettingsCommand[] = [];
    render(<GitConfigTab onCommand={c => commands.push(c)} />);
    pushProviders([{ id: 7, name: 'GitLab', gitUrl: 'https://gitlab.com', authMode: 'ssh' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(commands).toContainEqual({ type: 'gitProviderDelete', payload: { id: 7, name: 'GitLab' } });
  });

  it('posts a rename command after editing the name inline', () => {
    const commands: SettingsCommand[] = [];
    render(<GitConfigTab onCommand={c => commands.push(c)} />);
    pushProviders([{ id: 3, name: 'old', gitUrl: 'https://github.com', authMode: 'pat' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('Rename old'), { target: { value: 'new-name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(commands).toContainEqual({ type: 'gitProviderRename', payload: { id: 3, name: 'new-name' } });
  });
});
