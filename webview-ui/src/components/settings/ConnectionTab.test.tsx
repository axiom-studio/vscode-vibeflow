import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConnectionTab } from './ConnectionTab';
import type { SettingsData } from './settingsTypes';

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

// #3113 — the CLI setup cards moved OUT of a standalone "CLI Interface" tab
// and now render inline within ConnectionTab (via <CliSettings/>). This pins
// that integration point: CliTab.test.tsx only renders <CliSettings/> in
// isolation, so without this a future accidental removal of the <CliSettings/>
// line inside ConnectionTab would be caught by nothing. "Binary Path
// Override" is a CliSettings card heading that nothing else renders.
describe('ConnectionTab — CLI setup is folded in (#3113)', () => {
  it('renders the CLI settings cards inline', () => {
    render(<ConnectionTab data={settingsData()} onUpdate={vi.fn()} onCommand={vi.fn()} />);
    expect(screen.getByText('Binary Path Override')).toBeTruthy();
  });
});
