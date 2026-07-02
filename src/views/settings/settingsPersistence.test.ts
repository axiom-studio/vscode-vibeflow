import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';
import {
  maskingConfigTargets,
  persistEffectiveSetting,
  type ConfigOverrideInfo,
  type EffectiveConfig,
} from './settingsPersistence.js';

describe('maskingConfigTargets', () => {
  it('is empty when nothing overrides the global value', () => {
    expect(maskingConfigTargets(undefined)).toEqual([]);
    expect(maskingConfigTargets({})).toEqual([]);
    expect(maskingConfigTargets({ workspaceValue: undefined, workspaceFolderValue: undefined })).toEqual([]);
  });

  it('reports a workspace override — including falsy values like empty string', () => {
    expect(maskingConfigTargets({ workspaceValue: 'team-mcp' })).toEqual(['workspace']);
    expect(maskingConfigTargets({ workspaceValue: '' })).toEqual(['workspace']);
    expect(maskingConfigTargets({ workspaceValue: false })).toEqual(['workspace']);
  });

  it('reports a workspace-folder override and both together', () => {
    expect(maskingConfigTargets({ workspaceFolderValue: '/x' })).toEqual(['workspaceFolder']);
    expect(maskingConfigTargets({ workspaceValue: 'a', workspaceFolderValue: 'b' }))
      .toEqual(['workspace', 'workspaceFolder']);
  });
});

/**
 * In-memory semantic model of the three-target configuration store —
 * same DI-adapter pattern as PollingCoordinator's in-memory scheduler.
 * `effective()` mirrors VS Code's precedence: workspaceFolder > workspace > global.
 */
class InMemoryConfig implements EffectiveConfig {
  constructor(
    private global = new Map<string, unknown>(),
    private workspace = new Map<string, unknown>(),
    private workspaceFolder = new Map<string, unknown>(),
  ) {}

  async update(key: string, value: unknown, target: vscode.ConfigurationTarget): Promise<void> {
    const store = target === vscode.ConfigurationTarget.Global ? this.global
      : target === vscode.ConfigurationTarget.Workspace ? this.workspace
      : this.workspaceFolder;
    if (value === undefined) { store.delete(key); } else { store.set(key, value); }
  }

  inspect(key: string): ConfigOverrideInfo {
    return {
      workspaceValue: this.workspace.get(key),
      workspaceFolderValue: this.workspaceFolder.get(key),
    };
  }

  effective(key: string): unknown {
    if (this.workspaceFolder.has(key)) { return this.workspaceFolder.get(key); }
    if (this.workspace.has(key)) { return this.workspace.get(key); }
    return this.global.get(key);
  }
}

describe('persistEffectiveSetting', () => {
  it('writes the global value and reports nothing cleared when unmasked', async () => {
    const config = new InMemoryConfig();
    const cleared = await persistEffectiveSetting(config, 'cli.mcpName', 'team-mcp');
    expect(cleared).toEqual([]);
    expect(config.effective('cli.mcpName')).toBe('team-mcp');
  });

  it('removes a masking workspace override so the saved value is what reads back (#3343)', async () => {
    const config = new InMemoryConfig();
    await config.update('cli.mcpName', 'stale-workspace', vscode.ConfigurationTarget.Workspace);

    const cleared = await persistEffectiveSetting(config, 'cli.mcpName', 'team-mcp');

    expect(cleared).toEqual(['workspace']);
    expect(config.effective('cli.mcpName')).toBe('team-mcp');
  });

  it('clears both override levels and makes a Clear (empty-string save) effective', async () => {
    const config = new InMemoryConfig();
    await config.update('cli.rootPath', '/stale/ws', vscode.ConfigurationTarget.Workspace);
    await config.update('cli.rootPath', '/stale/folder', vscode.ConfigurationTarget.WorkspaceFolder);

    const cleared = await persistEffectiveSetting(config, 'cli.rootPath', '');

    expect(cleared).toEqual(['workspace', 'workspaceFolder']);
    expect(config.effective('cli.rootPath')).toBe('');
  });
});
