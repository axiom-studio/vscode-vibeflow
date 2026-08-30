import * as vscode from 'vscode';
import * as path from 'path';
import { resolveBinaryPath } from '../utils/whichBinary.js';

/**
 * Process-owned terminals — the fix for issue #4995.
 *
 * Every VibeFlow terminal used to be created bare and handed its command
 * via `terminal.sendText(...)` on the next statement. That types the
 * command into whatever shell VS Code started, which races every OTHER
 * writer to the same PTY. The Python extension is the writer that made
 * this a customer-visible bug: with a workspace interpreter selected it
 * asynchronously (1–3s after terminal creation) both
 *
 *   1. types `source .venv/bin/activate` into the terminal — interleaving
 *      with (or after) our command, corrupting a running agent's stdin, and
 *   2. contributes to `EnvironmentVariableCollection`, which lets VS Code
 *      relaunch a not-yet-interacted terminal to apply the new environment
 *      — killing whatever was running (the "session dies after ~2s" report).
 *
 * `createProcessTerminal` removes the shell from the picture entirely:
 * the target binary IS the terminal process (`shellPath` + `shellArgs`).
 * No shell → no rc files, no activation hook, and arguments are argv
 * elements rather than a string parsed by a shell — so prompts containing
 * quotes/newlines need no escaping and have no injection surface.
 *
 * `strictEnv: true` is the other half: it tells VS Code to use exactly
 * the env we provide instead of composing one from the window env +
 * settings + extension environment contributions. A terminal that takes
 * no environment contributions has nothing to go stale when a collection
 * changes, which is what mechanism (2) needs to trigger a relaunch.
 * Because strict mode inherits nothing, we merge `process.env` in
 * ourselves (preserving the long-standing "spawned terminal inherits
 * parent-process env" behavior that `detectExternalAuth` documents) and
 * backfill TERM/COLORTERM, which a shell-owned terminal would otherwise
 * have picked up — TUIs render garbage without them.
 */
export interface ProcessTerminalOptions {
  name: string;
  /** Program to run as the terminal process — bare name or absolute path. */
  binary: string;
  /** Argv passed verbatim — no shell parsing, no escaping needed. */
  args: readonly string[];
  cwd?: string;
  /** Extra environment on top of the inherited process env. */
  env?: Record<string, string>;
  hideFromUser?: boolean;
  iconPath?: vscode.ThemeIcon;
  location?: vscode.TerminalOptions['location'];
}

/**
 * Pure builder — separated from the `createTerminal` call so the
 * platform/resolution/env logic is unit-testable without a VS Code host
 * (same injectable-platform pattern as `cliCommands.shellQuote`).
 */
export function buildProcessTerminalOptions(
  opts: ProcessTerminalOptions,
  platform: NodeJS.Platform = process.platform,
  resolve: (name: string) => string | undefined = resolveBinaryPath,
  baseEnv: NodeJS.ProcessEnv = process.env,
): vscode.TerminalOptions {
  // Absolute paths pass through; bare names resolve via which/where. When
  // resolution fails, fall through with the bare name — VS Code surfaces
  // "the terminal process failed to launch" visibly, which is no worse
  // than a shell's "command not found" and keeps this function total.
  const resolved = path.isAbsolute(opts.binary)
    ? opts.binary
    : (resolve(opts.binary) ?? opts.binary);

  // Windows npm shims are .cmd batch files; CreateProcess cannot exec
  // those directly, so route them through the command interpreter. Args
  // stay an argv array — node-pty quotes them for CreateProcess.
  const isCmdScript = platform === 'win32' && /\.(cmd|bat)$/i.test(resolved);
  const comSpec = baseEnv.ComSpec ?? 'cmd.exe';
  const shellPath = isCmdScript ? comSpec : resolved;
  const shellArgs = isCmdScript ? ['/c', resolved, ...opts.args] : [...opts.args];

  // strictEnv inherits nothing, so start from the full process env
  // (dropping undefined entries — TerminalOptions.env values must be
  // strings) and layer the caller's vars on top.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value === 'string') { env[key] = value; }
  }
  Object.assign(env, opts.env);
  env.TERM = env.TERM || 'xterm-256color';
  env.COLORTERM = env.COLORTERM || 'truecolor';

  return {
    name: opts.name,
    shellPath,
    shellArgs,
    cwd: opts.cwd,
    env,
    strictEnv: true,
    hideFromUser: opts.hideFromUser,
    iconPath: opts.iconPath,
    location: opts.location,
  };
}

/** Create a terminal whose process is `binary` itself — no shell. */
export function createProcessTerminal(opts: ProcessTerminalOptions): vscode.Terminal {
  return vscode.window.createTerminal(buildProcessTerminalOptions(opts));
}
