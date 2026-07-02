import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CliTab } from './CliTab';
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
    stickyModels: {},
    knownModels: {},
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

describe('CliTab', () => {
  it('sends the latest MCP and root values when Open CLI is clicked before blur', () => {
    const onUpdate = vi.fn();
    const commands: SettingsCommand[] = [];
    render(
      <CliTab
        data={settingsData()}
        onUpdate={onUpdate}
        onCommand={(cmd) => { commands.push(cmd); }}
      />,
    );

    fireEvent.change(screen.getByLabelText('MCP name'), {
      target: { value: 'team-mcp' },
    });
    fireEvent.change(screen.getByLabelText('Root path'), {
      target: { value: "/Users/rp/O'Hara Project" },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open CLI' }));

    expect(commands).toEqual([{
      type: 'openCli',
      payload: {
        mcpName: 'team-mcp',
        rootPath: "/Users/rp/O'Hara Project",
      },
    }]);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('still persists buffered CLI values on blur', () => {
    const onUpdate = vi.fn();
    render(
      <CliTab
        data={settingsData()}
        onUpdate={onUpdate}
        onCommand={vi.fn()}
      />,
    );

    const mcpName = screen.getByLabelText('MCP name');
    const rootPath = screen.getByLabelText('Root path');

    fireEvent.change(mcpName, { target: { value: 'team-mcp' } });
    fireEvent.blur(mcpName);
    fireEvent.change(rootPath, { target: { value: '/tmp/vibeflow-root' } });
    fireEvent.blur(rootPath);

    expect(onUpdate).toHaveBeenCalledWith('cli.mcpName', 'team-mcp');
    expect(onUpdate).toHaveBeenCalledWith('cli.rootPath', '/tmp/vibeflow-root');
  });

  it('clears optional CLI launch values and opens with blank options afterward', () => {
    const onUpdate = vi.fn();
    const commands: SettingsCommand[] = [];
    render(
      <CliTab
        data={settingsData({
          cliMcpName: 'team-mcp',
          cliRootPath: '/tmp/vibeflow-root',
        })}
        onUpdate={onUpdate}
        onCommand={(cmd) => { commands.push(cmd); }}
      />,
    );

    const mcpName = screen.getByLabelText('MCP name') as HTMLInputElement;
    const rootPath = screen.getByLabelText('Root path') as HTMLInputElement;
    expect(mcpName.value).toBe('team-mcp');
    expect(rootPath.value).toBe('/tmp/vibeflow-root');

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(mcpName.value).toBe('');
    expect(rootPath.value).toBe('');
    expect(onUpdate).toHaveBeenCalledWith('cli.mcpName', '');
    expect(onUpdate).toHaveBeenCalledWith('cli.rootPath', '');

    fireEvent.click(screen.getByRole('button', { name: 'Open CLI' }));
    expect(commands).toEqual([{
      type: 'openCli',
      payload: {
        mcpName: '',
        rootPath: '',
      },
    }]);
  });
});
