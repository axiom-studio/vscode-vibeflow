import * as vscode from 'vscode';

/**
 * Opt-in Cloud Runners trace log (#3396/#3398). Writes method/path/status/
 * response-SHAPE lines to a dedicated output channel to help diagnose API
 * behaviour.
 *
 * PERSISTENCE (#3398): the toggle is stored in `globalState`, NOT via
 * `config.update()` — VS Code rejects programmatic writes of configuration
 * keys that aren't registered ("not a registered configuration"), and
 * package.json `contributes.configuration` only registers on extension
 * reinstall, never on a JS rebuild+reload. globalState needs no registration.
 * The `vibeflow.cloudRunners.debug` config key is still honored as a
 * read-only fallback for users who add it to settings.json by hand (reads,
 * unlike writes, are not validated against registration).
 *
 * SECURITY: callers must pass shapes/messages only — never request bodies or
 * secret values (API keys, tokens, SSH keys).
 */

const STATE_KEY = 'vibeflow.cloudRunners.debug';

/** The slice of ExtensionContext this module needs — narrow for testability. */
type DebugStateHost = { globalState: vscode.Memento };

let host: DebugStateHost | undefined;
let debugEnabled = false;
let channel: vscode.LogOutputChannel | undefined;

/** Load the persisted toggle at activation. */
export function initCloudRunnerDebug(ctx: DebugStateHost): void {
  host = ctx;
  debugEnabled = ctx.globalState.get<boolean>(STATE_KEY, false);
}

/** Flip the toggle and persist it (globalState — no registration needed). */
export async function setCloudRunnerDebug(enabled: boolean): Promise<void> {
  debugEnabled = enabled;
  await host?.globalState.update(STATE_KEY, enabled);
}

/** Effective state: the persisted toggle, or the config key as a manual-edit fallback. */
export function isCloudRunnerDebugEnabled(): boolean {
  return debugEnabled
    || vscode.workspace.getConfiguration('vibeflow').get<boolean>('cloudRunners.debug', false);
}

function getChannel(): vscode.LogOutputChannel {
  if (!channel) {
    // { log: true } → a LogOutputChannel: the Output panel shows the
    // log-level gear (#3399) and stamps every line with time + level.
    channel = vscode.window.createOutputChannel('VibeFlow Cloud Runners', { log: true });
  }
  return channel;
}

/** Emit a trace line (with level) when Cloud Runners debug logging is enabled. */
export function cloudRunnerTrace(line: string, level: 'info' | 'error' = 'info'): void {
  if (!isCloudRunnerDebugEnabled()) { return; }
  const ch = getChannel();
  if (level === 'error') { ch.error(line); } else { ch.info(line); }
}
