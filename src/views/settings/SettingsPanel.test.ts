import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from './SettingsPanel.js';

// Boundary stubs only: the VS Code runtime (panel, configuration store) and
// the CLI config file writer. SettingsPanel's own handler is the unit.
const store: Record<string, unknown> = { serverUrl: 'https://old.example' };
let releaseSave: () => void = () => {};
let handler: (msg: unknown) => Promise<void> = async () => {};
const cliWrites: { serverUrl?: string }[] = [];

vi.mock('vscode', async (orig) => ({
  ...(await orig<typeof import('vscode')>()),
  ViewColumn: { One: 1 },
  Uri: { joinPath: () => ({}) },
  extensions: { getExtension: () => undefined },
  env: { remoteName: undefined },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({
      get: (key: string, fallback?: unknown) => store[key] ?? fallback,
      inspect: () => ({}),
      // A slow save: the value lands only when the test releases it.
      update: (key: string, value: unknown) => new Promise<void>(resolve => {
        releaseSave = () => { store[key] = value; resolve(); };
      }),
    }),
  },
  window: {
    showInformationMessage: () => undefined,
    showWarningMessage: () => undefined,
    showErrorMessage: () => undefined,
    createWebviewPanel: () => ({
      webview: {
        html: '', cspSource: '',
        asWebviewUri: () => '',
        postMessage: async () => true,
        onDidReceiveMessage: (cb: (m: unknown) => Promise<void>) => { handler = cb; },
      },
      onDidDispose: () => undefined,
    }),
  },
}));
vi.mock('../../auth/cliConfig.js', () => ({
  writeCliConfig: (_path: string, fields: { serverUrl?: string }) => { cliWrites.push(fields); },
}));

afterEach(() => { vi.unstubAllGlobals(); });

describe('SettingsPanel Test Connection', () => {
  it('saves the typed URL before probing, so a fast server still updates the CLI (#5772)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
    SettingsPanel.open({} as never, { authService: { getToken: () => 'token' } as never });

    const test = handler({ type: 'validateServerUrl', payload: 'https://new.example' });
    await new Promise(r => setTimeout(r, 0));
    // The probe waits for the save: nothing is fetched or mirrored yet.
    expect(fetch).not.toHaveBeenCalled();
    releaseSave();
    await test;

    expect(store.serverUrl).toBe('https://new.example');
    expect(cliWrites.at(-1)?.serverUrl).toBe('https://new.example');
  });
});
