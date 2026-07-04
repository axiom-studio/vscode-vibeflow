import * as vscode from 'vscode';

/**
 * Opt-in Cloud Runners trace log (#3396). No-op unless
 * `vibeflow.cloudRunners.debug` is enabled. Writes method/path/status/response-
 * SHAPE lines to a dedicated output channel to help diagnose API behaviour.
 *
 * SECURITY: callers must pass shapes/messages only — never request bodies or
 * secret values (API keys, tokens, SSH keys).
 */
let channel: vscode.OutputChannel | undefined;

function isEnabled(): boolean {
  return vscode.workspace.getConfiguration('vibeflow').get<boolean>('cloudRunners.debug', false);
}

function getChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('VibeFlow Cloud Runners');
  }
  return channel;
}

/** Append a timestamped trace line when Cloud Runners debug logging is enabled. */
export function cloudRunnerTrace(line: string): void {
  if (!isEnabled()) { return; }
  getChannel().appendLine(`[${new Date().toISOString()}] ${line}`);
}
