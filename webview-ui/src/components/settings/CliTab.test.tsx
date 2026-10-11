import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CliSettings } from './CliTab';
import type { SettingsCommand, SettingsData } from './settingsTypes';

function settingsData(overrides: Partial<SettingsData> = {}): SettingsData {
  return {
    serverUrl: 'https://cloud.axiomstudio.ai',
    serverReachable: null,
    apiKeySet: true,
    apiKeyValid: true,
    projectId: 28,
    projectName: 'vscode-vibeflow',
    projects: [{ id: 28, name: 'vscode-vibeflow' }],
    pollInterval: 30,
    liveInterval: 5,
    notifyAgentPrompts: true,
    notifyWorkComplete: true,
    chatDiffView: 'unified',
    cliBinaryPath: '',
    cliMcpName: '',
    cliRootPath: '',
    cliInstalled: true,
    mcpAgents: [],
    cliVersion: '1.0.0',
    cliBinaryPathStale: null,
    version: '1.1.4',
    ...overrides,
  };
}

// CliSettings renders inside the Connection tab (#3113): the VibeFlow CLI
// card (install / WSL guidance) and the Binary Path Override controls.
describe('CliSettings', () => {
  // #4034: the CLI is the only launch path, so there is no on/off toggle.
  it('has no CLI on/off toggle', () => {
    render(<CliSettings data={settingsData()} onUpdate={vi.fn()} onCommand={vi.fn()} />);
    expect(screen.queryByRole('switch')).toBeNull();
  });

  // #4035: on native Windows the CLI cannot run, so guide to WSL instead of
  // offering an install that would fail.
  it('replaces the install offer with WSL guidance on native Windows', () => {
    render(
      <CliSettings
        data={settingsData({ cliInstalled: false, cliNeedsWsl: true })}
        onUpdate={vi.fn()}
        onCommand={vi.fn()}
      />,
    );
    expect(screen.getByText(/needs WSL on Windows/)).toBeTruthy();
    expect(screen.getByText('How to Set Up WSL')).toBeTruthy();
    expect(screen.queryByText(/vibeflow binary not found/)).toBeNull();
  });

  it('offers a one-click install when the binary is missing', () => {
    const commands: SettingsCommand[] = [];
    render(
      <CliSettings
        data={settingsData({ cliInstalled: false })}
        onUpdate={vi.fn()}
        onCommand={(cmd) => { commands.push(cmd); }}
      />,
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Install Latest' })[0]);
    expect(commands).toContainEqual({ type: 'runCommand', payload: 'vibeflow.installCli' });
  });

  it('shows the detected binary version and wires Browse / Check for Updates', () => {
    const commands: SettingsCommand[] = [];
    render(
      <CliSettings
        data={settingsData({ cliInstalled: true, cliVersion: '1.0.19' })}
        onUpdate={vi.fn()}
        onCommand={(cmd) => { commands.push(cmd); }}
      />,
    );
    expect(screen.getByText(/binary detected · v1\.0\.19/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Browse…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Check for Updates' }));
    expect(commands).toContainEqual({ type: 'runCommand', payload: 'vibeflow.browseCliBinary' });
    expect(commands).toContainEqual({ type: 'runCommand', payload: 'vibeflow.checkCliUpdate' });
  });
});
