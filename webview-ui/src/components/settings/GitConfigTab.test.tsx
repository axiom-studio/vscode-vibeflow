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

/** Simulate the host reporting the outcome of an add-provider attempt (#3393). */
function pushCreateResult(ok: boolean, error?: string) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'gitProviderCreateResult', payload: { ok, error } },
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

  it('enables Add only with a name + valid host + token, and posts create with the inline PAT (blank host → github.com)', () => {
    const commands: SettingsCommand[] = [];
    render(<GitConfigTab onCommand={c => commands.push(c)} />);
    const addBtn = screen.getByRole('button', { name: 'Add provider' }) as HTMLButtonElement;
    expect(addBtn.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'GitHub' } });
    expect(addBtn.disabled).toBe(true); // no secret yet

    fireEvent.change(screen.getByLabelText('Git host'), { target: { value: 'http://github.com' } });
    fireEvent.change(screen.getByLabelText('Access token'), { target: { value: 'ghp_123' } });
    expect(addBtn.disabled).toBe(true); // http host rejected

    // Blank host is allowed (defaults to github.com).
    fireEvent.change(screen.getByLabelText('Git host'), { target: { value: '' } });
    expect(addBtn.disabled).toBe(false);

    fireEvent.click(addBtn);
    expect(commands).toContainEqual({
      type: 'gitProviderCreate',
      payload: { name: 'GitHub', gitUrl: 'https://github.com', authType: 'pat', accessToken: 'ghp_123' },
    });
  });

  it('includes an optional username and clears the secret field after submit', () => {
    const commands: SettingsCommand[] = [];
    render(<GitConfigTab onCommand={c => commands.push(c)} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'GH' } });
    fireEvent.change(screen.getByLabelText('Git host'), { target: { value: 'https://ghe.example.com' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'octocat' } });
    const token = screen.getByLabelText('Access token') as HTMLInputElement;
    fireEvent.change(token, { target: { value: 'ghp_secret' } });

    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));
    expect(commands).toContainEqual({
      type: 'gitProviderCreate',
      payload: { name: 'GH', gitUrl: 'https://ghe.example.com', authType: 'pat', userName: 'octocat', accessToken: 'ghp_secret' },
    });
    // The secret must not linger in the form after submit.
    expect((screen.getByLabelText('Access token') as HTMLInputElement).value).toBe('');
  });

  it('masks the access token field', () => {
    render(<GitConfigTab onCommand={vi.fn()} />);
    expect((screen.getByLabelText('Access token') as HTMLInputElement).type).toBe('password');
  });

  it('switches to the SSH key textarea and posts sshPrivateKey', () => {
    const commands: SettingsCommand[] = [];
    render(<GitConfigTab onCommand={c => commands.push(c)} />);

    fireEvent.change(screen.getByLabelText('Authentication'), { target: { value: 'ssh' } });
    expect(screen.queryByLabelText('Access token')).toBeNull();
    expect(screen.queryByLabelText('Username')).toBeNull();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'work-ssh' } });
    fireEvent.change(screen.getByLabelText('SSH private key'), { target: { value: '-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END-----' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));

    expect(commands).toContainEqual({
      type: 'gitProviderCreate',
      payload: { name: 'work-ssh', gitUrl: 'https://github.com', authType: 'ssh', sshPrivateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END-----' },
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

  it('shows the failure inline and keeps the non-secret fields for retry (#3393)', () => {
    render(<GitConfigTab onCommand={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'GH' } });
    fireEvent.change(screen.getByLabelText('Access token'), { target: { value: 'ghp_x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));
    // The secret is cleared on submit; the name is retained.
    expect((screen.getByLabelText('Access token') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('GH');

    pushCreateResult(false, 'token rejected');
    expect(screen.getByText('token rejected')).toBeTruthy();
    // Name stays so the user only re-enters the secret.
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('GH');
  });

  it('renders the Diagnostics toggle and persists cloudRunners.debug via onUpdate (#3397)', () => {
    const updates: Array<[string, unknown]> = [];
    render(<GitConfigTab onCommand={vi.fn()} cloudRunnersDebug={false} onUpdate={(k, v) => updates.push([k, v])} />);
    const toggle = screen.getByLabelText('Cloud Runners debug logging') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(updates).toContainEqual(['cloudRunners.debug', true]);
  });

  it('reflects an enabled debug toggle and hides the section without onUpdate (#3397)', () => {
    const { unmount } = render(<GitConfigTab onCommand={vi.fn()} cloudRunnersDebug={true} onUpdate={vi.fn()} />);
    expect((screen.getByLabelText('Cloud Runners debug logging') as HTMLInputElement).checked).toBe(true);
    unmount();
    // Without the updateSetting plumbing the section is omitted entirely.
    render(<GitConfigTab onCommand={vi.fn()} />);
    expect(screen.queryByLabelText('Cloud Runners debug logging')).toBeNull();
  });

  it('confirms success inline and clears the form on a successful add (#3393)', () => {
    render(<GitConfigTab onCommand={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'GH' } });
    fireEvent.change(screen.getByLabelText('Access token'), { target: { value: 'ghp_x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));

    pushCreateResult(true);
    expect(screen.getByText('Provider added.')).toBeTruthy();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('');
  });
});
