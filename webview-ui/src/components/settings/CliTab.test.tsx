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
    defaultProvider: 'claude',
    providers: [],
    worktreeBaseDir: '.claude/worktrees',
    worktreeAutoCreate: false,
    worktreeCleanupOnKill: 'ask',
    pollInterval: 30,
    liveInterval: 5,
    sessionTerminalMode: 'hybrid',
    sessionHeadlessBacking: 'auto',
    notifyAgentPrompts: true,
    notifyWorkComplete: true,
    chatDiffView: 'unified',
    cliEnabled: true,
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

// CliSettings now renders inside the Connection tab (#3113) — just the two
// kept cards: the Use VibeFlow CLI toggle and the Binary Path Override /
// install controls. The old MCP-name/root-path "Open CLI" card was removed.
describe('CliSettings', () => {
  it('toggles cli.enabled from the Use VibeFlow CLI switch', () => {
    const onUpdate = vi.fn();
    render(
      <CliSettings data={settingsData({ cliEnabled: false })} onUpdate={onUpdate} onCommand={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('switch'));
    expect(onUpdate).toHaveBeenCalledWith('cli.enabled', true);
  });

  it('offers a one-click install when enabled but the binary is missing', () => {
    const commands: SettingsCommand[] = [];
    render(
      <CliSettings
        data={settingsData({ cliEnabled: true, cliInstalled: false })}
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
