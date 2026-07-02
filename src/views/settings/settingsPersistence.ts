import * as vscode from 'vscode';

/**
 * The override slots of `WorkspaceConfiguration.inspect()` that can mask a
 * user-level (Global) write. Structural subset so the pure helper below is
 * unit-testable without the VS Code runtime.
 */
export interface ConfigOverrideInfo {
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}

/** The 3-method surface persistEffectiveSetting actually needs. The real
 *  `vscode.WorkspaceConfiguration` satisfies it structurally. */
export interface EffectiveConfig {
  update(key: string, value: unknown, target: vscode.ConfigurationTarget): Thenable<void>;
  inspect(key: string): ConfigOverrideInfo | undefined;
}

export type MaskingTarget = 'workspace' | 'workspaceFolder';

/**
 * Which higher-precedence targets currently hold a value that would mask a
 * Global write. Note `''` and `false` DO mask (only `undefined` means unset).
 */
export function maskingConfigTargets(info: ConfigOverrideInfo | undefined): MaskingTarget[] {
  const targets: MaskingTarget[] = [];
  if (info?.workspaceValue !== undefined) { targets.push('workspace'); }
  if (info?.workspaceFolderValue !== undefined) { targets.push('workspaceFolder'); }
  return targets;
}

/**
 * Persist a setting so the write is actually EFFECTIVE, not just stored.
 *
 * `config.update(key, value, Global)` writes user settings, but
 * `config.get()` resolves workspace / workspace-folder values first — a
 * leftover override there makes every save from the Settings panel look
 * ignored: the panel rehydrates the stale override on reopen and Clear
 * appears dead (#3343). After the Global write, any masking overrides are
 * removed so the value read back is the value just saved.
 *
 * Returns the override targets that were cleared, for caller logging.
 */
export async function persistEffectiveSetting(
  config: EffectiveConfig,
  key: string,
  value: unknown,
): Promise<MaskingTarget[]> {
  await config.update(key, value, vscode.ConfigurationTarget.Global);
  const cleared = maskingConfigTargets(config.inspect(key));
  for (const target of cleared) {
    await config.update(
      key,
      undefined,
      target === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.WorkspaceFolder,
    );
  }
  return cleared;
}
