import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ConnectionTab } from './ConnectionTab';
import type { SettingsCommand, SettingsData } from './settingsTypes';

function settingsData(overrides: Partial<SettingsData> = {}): SettingsData {
  return {
    serverUrl: 'https://cloud.axiomstudio.ai',
    apiKeySet: true,
    pollInterval: 30,
    liveInterval: 5,
    notifyAgentPrompts: true,
    notifyWorkComplete: true,
    chatDiffView: 'unified',
    cliBinaryPath: '',
    cliInstalled: true,
    mcpAgents: [],
    cliVersion: '1.0.0',
    cliBinaryPathStale: null,
    version: '1.1.4',
    ...overrides,
  };
}

// #4045: the Connection tab is Account, VibeFlow CLI and MCP, in that order;
// project switching lives in the sidebar dropdown.
describe('ConnectionTab', () => {
  it('shows the three setup cards in order and no project switcher', () => {
    render(<ConnectionTab data={settingsData()} checks={{}} onUpdate={vi.fn()} onCommand={vi.fn()} />);
    const headings = screen.getAllByRole('heading').map(h => h.textContent);
    expect(headings).toEqual(['Account', 'VibeFlow CLI', 'MCP for coding agents']);
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('saves the server URL only on Enter, then tests the URL that was typed', () => {
    const onUpdate = vi.fn();
    const commands: SettingsCommand[] = [];
    render(<ConnectionTab data={settingsData()} checks={{}} onUpdate={onUpdate} onCommand={c => { commands.push(c); }} />);
    const input = screen.getByLabelText('Server URL');
    fireEvent.change(input, { target: { value: 'https://vf.example.com' } });
    expect(onUpdate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }));
    expect(onUpdate).toHaveBeenCalledWith('serverUrl', 'https://vf.example.com');
    expect(commands).toContainEqual({ type: 'validateServerUrl', payload: 'https://vf.example.com' });
  });

  it('shows the Test Connection result for the URL in the field', () => {
    const data = settingsData();
    const { rerender } = render(<ConnectionTab data={data} checks={{ serverUrl: { url: data.serverUrl, valid: false, message: 'Server unreachable' } }} onUpdate={vi.fn()} onCommand={vi.fn()} />);
    expect(screen.getByText('Server unreachable')).toBeTruthy();
    // A result for a different URL is not shown against this one.
    rerender(<ConnectionTab data={data} checks={{ serverUrl: { url: 'https://other.example', valid: true } }} onUpdate={vi.fn()} onCommand={vi.fn()} />);
    expect(screen.queryByText('Reachable')).toBeNull();
  });
});
