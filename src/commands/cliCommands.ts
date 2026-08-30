import * as vscode from 'vscode';
import { execSync, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createProcessTerminal } from '../sessions/terminalLaunch.js';

const TERMINAL_NAME = 'VibeFlow CLI';

// Lazily-created output channel mirroring every openCli outcome — most
// importantly the exact command line sent to the terminal — so "why didn't
// my --mcp/--root apply?" is answerable from Output → VibeFlow CLI without
// attaching a debugger (#3342). Values logged are user-entered names/paths
// and the resolved binary path; no secrets travel through this surface.
let cliChannel: vscode.OutputChannel | undefined;

export function logCli(line: string): void {
  if (!cliChannel) {
    cliChannel = vscode.window.createOutputChannel(TERMINAL_NAME);
  }
  cliChannel.appendLine(`[${new Date().toISOString()}] ${line}`);
  console.log(`[${TERMINAL_NAME}] ${line}`);
}

/**
 * Read the CLI's PID lock file and return the live PID, or null if no
 * vibeflow-cli instance is running. Mirrors the Go-side helpers in
 * `vibeflow-cli/internal/vibeflowcli/pidlock.go` —
 * `PIDLockPath()` writes `~/.vibeflow-cli/vibeflow.pid` and
 * `readPIDLock` parses + liveness-probes the PID.
 *
 * `process.kill(pid, 0)` is the standard Node existence probe: no signal
 * is sent, but the call throws ESRCH if no process owns the PID, or
 * EPERM if it exists but is owned by another user. Both alive-cases
 * (ours or theirs) mean "the CLI is running" for our purposes.
 */
function getRunningCliPid(): number | null {
  const lockPath = path.join(os.homedir(), '.vibeflow-cli', 'vibeflow.pid');
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, 'utf-8');
  } catch {
    return null; // no lock file → not running
  }
  const pid = parseInt(raw.trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) { return null; }
  try {
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') { return pid; } // exists but owned by another user
    return null; // ESRCH or other → stale lock, process dead
  }
}
const RELEASES_URL = 'https://github.com/axiom-studio/vibeflow-cli/releases/latest';
const INSTALL_DOCS_URL = 'https://github.com/axiom-studio/vibeflow-cli#installation';

/**
 * Resolve the vibeflow binary, honoring the optional config override.
 *
 * Resolution order:
 *   1. `vibeflow.cli.binaryPath` config (absolute path) — if set and exists.
 *   2. `which vibeflow` / `where vibeflow` on PATH.
 *   3. undefined — caller surfaces the install toast.
 *
 * We resolve eagerly (not lazy via shell) so the spawn command can use a
 * stable path; the workspace's PATH inside a VS Code terminal can drift
 * from the launching shell's PATH.
 */
export function resolveBinary(): string | undefined {
  const config = vscode.workspace.getConfiguration('vibeflow');
  const override = config.get<string>('cli.binaryPath', '').trim();
  if (override) {
    try {
      if (fs.existsSync(override)) { return override; }
    } catch { /* fall through to PATH */ }
  }

  try {
    const cmd = process.platform === 'win32' ? 'where vibeflow' : 'which vibeflow';
    const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    // `where` on Windows can return multiple lines; take the first.
    const first = out.split(/\r?\n/)[0]?.trim();
    return first || undefined;
  } catch {
    return undefined;
  }
}

/**
 * When `cli.binaryPath` is set but the file doesn't exist, returns that stale
 * path so the UI/error can say "configured path not found" instead of the
 * generic "not installed". Returns undefined when no override is set or the
 * configured file exists. (resolveBinary still falls through to PATH, so a
 * stale override plus an on-PATH binary resolves fine — this only flags the
 * override-points-nowhere case.)
 */
export function staleCliBinaryPath(): string | undefined {
  const override = vscode.workspace.getConfiguration('vibeflow').get<string>('cli.binaryPath', '').trim();
  if (!override) { return undefined; }
  try {
    return fs.existsSync(override) ? undefined : override;
  } catch {
    return override;
  }
}

/**
 * The installed CLI's version string (e.g. "1.0.10"), or undefined when the
 * binary isn't found or doesn't respond. Runs `vibeflow version` (whose first
 * line is `vibeflow <version>` — there is no --version flag) and parses the
 * version token.
 */
export function getCliVersion(): string | undefined {
  const binary = resolveBinary();
  if (!binary) { return undefined; }
  try {
    const out = execFileSync(binary, ['version'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString();
    return parseCliVersion(out);
  } catch {
    return undefined;
  }
}

/**
 * Extract the version token from `vibeflow version` output, whose first line
 * is `vibeflow <version>`. Pure (no process) so it's unit-testable.
 */
export function parseCliVersion(versionOutput: string): string | undefined {
  const first = versionOutput.split(/\r?\n/)[0]?.trim() ?? '';
  const m = first.match(/^vibeflow\s+(\S+)/i);
  return m ? m[1] : undefined;
}

export interface CliLaunchOptions {
  mcpName?: string;
  rootPath?: string;
}

function readCliLaunchOptions(): CliLaunchOptions {
  const config = vscode.workspace.getConfiguration('vibeflow');
  return {
    mcpName: config.get<string>('cli.mcpName', '').trim(),
    rootPath: config.get<string>('cli.rootPath', '').trim(),
  };
}

/** True when either optional launch flag would actually be emitted. */
export function hasCliLaunchOptions(options?: CliLaunchOptions): boolean {
  return Boolean(options?.mcpName?.trim() || options?.rootPath?.trim());
}

/**
 * Launch flags as argv — the executed form since #4995 (the TUI binary is
 * spawned directly as the terminal process; no shell parses these).
 */
export function buildCliLaunchArgs(options: CliLaunchOptions = {}): string[] {
  const args: string[] = [];
  const mcpName = options.mcpName?.trim();
  const rootPath = options.rootPath?.trim();
  if (mcpName) {
    args.push('--mcp', mcpName);
  }
  if (rootPath) {
    args.push('--root', rootPath);
  }
  return args;
}

/**
 * Shell-quoted display form, derived from `buildCliLaunchArgs` so it
 * cannot diverge from what executes (#3342's logging invariant — the
 * launch log and the spawn share one args source).
 */
export function buildCliLaunchCommand(
  binary: string,
  options: CliLaunchOptions = {},
  platform: NodeJS.Platform = process.platform,
): string {
  return [binary, ...buildCliLaunchArgs(options)]
    .map(arg => shellQuote(arg, platform))
    .join(' ');
}

/**
 * Open the VibeFlow CLI (TUI) in a fullscreen editor-area terminal.
 *
 * The CLI manages its own multi-session state via tmux under a custom
 * socket — see vibeflow-cli/internal/vibeflowcli/tmux.go. This command
 * is the IDE-side "launcher": find the binary, surface install help if
 * missing, and spawn it where the user expects (editor area, not the
 * bottom panel) so it occupies the main area while the left sidebar
 * keeps showing live agent state via the existing TreeViews.
 *
 * Re-running this command focuses the existing terminal if one is still
 * open (matches OpenCode's openTerminal pattern). Closing the terminal
 * exits the TUI; the PID lock at ~/.vibeflow-cli/<lock> releases on
 * exit so the next run starts fresh.
 */
export async function openCli(workspaceRoot: string | undefined, launchOptions?: CliLaunchOptions): Promise<void> {
  const existing = vscode.window.terminals.find(t => t.name === TERMINAL_NAME);
  if (existing) {
    existing.show(false); // take focus
    // The TUI enforces one instance via its own PID lock, so we cannot
    // re-launch with fresh flags while the old terminal lives. Reusing it
    // SILENTLY was the #3342 symptom: freshly entered MCP name / Root path
    // appeared to do nothing. Say so instead.
    const requested = launchOptions ?? readCliLaunchOptions();
    if (hasCliLaunchOptions(requested)) {
      logCli(
        `reused existing "${TERMINAL_NAME}" terminal — requested launch options were NOT applied ` +
        `(mcp=${requested.mcpName?.trim() || '<blank>'}, root=${requested.rootPath?.trim() || '<blank>'}). ` +
        'Close that terminal and reopen to apply them.',
      );
      vscode.window.showWarningMessage(
        'VibeFlow CLI is already open — close that terminal and click Open CLI again to apply MCP name / Root path.',
      );
    } else {
      logCli(`reused existing "${TERMINAL_NAME}" terminal (no launch options requested).`);
    }
    return;
  }

  // External CLI guard: another vibeflow-cli (likely a Terminal.app
  // session the user kicked off before opening VS Code) holds the PID
  // lock at ~/.vibeflow-cli/vibeflow.pid. Spawning a new instance would
  // hit `AcquirePIDLock` and bail to a bare shell prompt — confusing
  // because the user clicked "Launch Session" and expected a wizard.
  // Front-run that failure with a modal explaining how to recover.
  const externalPid = getRunningCliPid();
  if (externalPid !== null) {
    logCli(`blocked: an external vibeflow-cli holds the PID lock (pid ${externalPid}) — no command sent.`);
    const choice = await vscode.window.showWarningMessage(
      `VibeFlow CLI is already running externally (PID ${externalPid}).`,
      {
        modal: true,
        detail:
          'Quit your existing vibeflow-cli and rerun the step. You do not need to kill the running coding agents — just exit from the VibeFlow CLI. We\'ll resume those sessions inside VS Code.',
      },
      'Retry',
    );
    if (choice === 'Retry') {
      return openCli(workspaceRoot, launchOptions); // re-checks the lock
    }
    return;
  }

  const binary = resolveBinary();
  if (!binary) {
    logCli('vibeflow binary not found (cli.binaryPath override + PATH lookup both failed) — no command sent.');
    const choice = await vscode.window.showWarningMessage(
      'VibeFlow CLI is not installed or not on PATH.',
      'Install Latest',
      'Download Release',
      'View Install Instructions',
      'Cancel',
    );
    if (choice === 'Install Latest') {
      await vscode.commands.executeCommand('vibeflow.installCli');
    } else if (choice === 'Download Release') {
      vscode.env.openExternal(vscode.Uri.parse(RELEASES_URL));
    } else if (choice === 'View Install Instructions') {
      vscode.env.openExternal(vscode.Uri.parse(INSTALL_DOCS_URL));
    }
    return;
  }

  // Spawn in the editor area so it occupies the main pane. The left
  // sidebar (Agent Fleet, Work Items, Documents) stays visible — that's
  // the deliberate "CLI mode" layout: TUI as the workhorse, panels as
  // the live status board.
  const cwd = workspaceRoot && fs.existsSync(workspaceRoot)
    ? workspaceRoot
    : undefined;

  const options = launchOptions ?? readCliLaunchOptions();
  // Log and execution derive from the same buildCliLaunchArgs result
  // (#3342 invariant) — the display string is the argv, shell-quoted for
  // readability; the spawn takes the argv itself. Since #4995 the TUI is
  // the terminal process (no shell), so nothing can interleave with it.
  logCli(`launching in editor terminal (argv spawn, no shell; cwd: ${cwd ?? '<none>'}): ${buildCliLaunchCommand(binary, options)}`);

  const terminal = createProcessTerminal({
    name: TERMINAL_NAME,
    binary,
    args: buildCliLaunchArgs(options),
    cwd,
    location: vscode.TerminalLocation.Editor,
    iconPath: new vscode.ThemeIcon('terminal'),
  });
  terminal.show(false);
}

function shellQuote(arg: string, platform: NodeJS.Platform): string {
  if (!arg) { return "''"; }
  if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(arg)) {
    return arg;
  }
  if (platform === 'win32') {
    return `"${arg.replace(/(["^&|<>%])/g, '^$1')}"`;
  }
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

// Helper for callers that want to detect-and-warn early (e.g. when the
// user toggles `vibeflow.cli.enabled` to true). Exported separately so
// settings UI can pre-validate before the user hits "Open CLI".
export function isVibeflowInstalled(): boolean {
  return resolveBinary() !== undefined;
}
