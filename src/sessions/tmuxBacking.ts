import { execFile } from 'child_process';
import * as vscode from 'vscode';

/**
 * Opt-in tmux runtime backing for chat-first / headless sessions
 * (todo #1615 — Chat-First Mode #6).
 *
 * **Why tmux**: agent survives IDE restart, and a user can
 * `tmux -L vibeflow-headless attach -t <name>` from any terminal
 * for live observability. Default is OFF; `vibeflow.session.headlessBacking`
 * controls activation.
 *
 * **Why a dedicated socket**: `-L vibeflow-headless` keeps our
 * sessions cleanly namespaced away from the user's default tmux
 * sessions and from the existing CLI-mode socket (`-L vibeflow`).
 * Two sockets are cheap; the isolation is worth it.
 *
 * **Security boundary** (mirrors the eba7956 + 7046d53
 * worktree-injection lessons):
 *  - `execFile('tmux', [...])` argv form only. No shell. No
 *    `execSync('tmux ... ${interp}')` patterns.
 *  - All session names validated against `^[a-zA-Z0-9_-]+$`
 *    before any tmux invocation. The validator is applied
 *    upstream of every public call here AND defensively
 *    re-applied inside each method (belt and suspenders).
 *  - Tmux verb allowlist on the same call site.
 *  - All caller-supplied args (command, workDir, env) flow as
 *    distinct argv elements; tmux itself is responsible for
 *    re-quoting when it spawns the inner shell.
 */

/** The dedicated tmux socket name for headless agent backings. */
export const TMUX_SOCKET = 'vibeflow-headless';

/**
 * Pattern enforced on every tmux session name we construct or
 * accept from outside. Refuses everything that isn't ASCII
 * alphanumeric + `_` + `-`. tmux itself permits a wider set,
 * but we narrow further to make any future code change that
 * lets a name through accidentally be safe-by-construction.
 */
const SESSION_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Allowlist of tmux verbs we will ever execute. The dispatcher
 * methods below are the only callsites; this constant exists to
 * make the audit trivial — grep for `TMUX_VERBS` to see exactly
 * which subcommands could ever be invoked.
 */
const TMUX_VERBS = [
  'new-session',
  'has-session',
  'kill-session',
  'list-sessions',
  'send-keys',
  'capture-pane',
] as const;
type TmuxVerb = typeof TMUX_VERBS[number];

/**
 * Build the tmux session name for a (persona, branch, workDir)
 * triple. Includes an 8-char hash suffix derived from `workDir`
 * so two worktrees of the same branch don't collide. Slugs the
 * branch (replace `/` with `_`) and lowercases the persona to
 * keep names ASCII.
 */
export function buildHeadlessTmuxName(persona: string, branch: string, workDir: string): string {
  const personaSlug = String(persona).toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 24);
  const branchSlug = String(branch).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
  const dirHash = simpleHash(workDir).toString(16).padStart(8, '0').slice(0, 8);
  const name = `vibeflow-${personaSlug}-${branchSlug}-${dirHash}`;
  // Defensive — strip any leftover characters that slipped
  // through (slice ranges + non-greedy replacements).
  return name.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
}

/** Tiny non-cryptographic 32-bit hash. Sufficient for namespace disambiguation. */
function simpleHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/**
 * Throws if `name` doesn't match the allowed shape. Used as an
 * invariant guard at every tmux dispatcher entry point.
 */
function assertValidSessionName(name: string): void {
  if (!SESSION_NAME_RE.test(name)) {
    throw new Error(`tmux: invalid session name shape: ${JSON.stringify(name).slice(0, 80)}`);
  }
}

/**
 * Run a tmux subcommand with strict argv-form discipline. Verb
 * MUST be in `TMUX_VERBS`. Args are forwarded verbatim; the
 * caller is responsible for ensuring caller-supplied strings
 * are tmux-safe at the SHELL boundary that tmux itself will
 * eventually invoke.
 *
 * Resolves to `{ stdout, stderr, code }` so callers can read
 * tmux's exit code (relevant for `has-session` which exits
 * non-zero when the session is absent — that's not an error).
 */
function runTmux(verb: TmuxVerb, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  if (!TMUX_VERBS.includes(verb)) {
    return Promise.reject(new Error(`tmux: disallowed verb ${verb}`));
  }
  return new Promise(resolve => {
    execFile(
      'tmux',
      ['-L', TMUX_SOCKET, verb, ...args],
      { timeout: 5000, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: number }).code === 'number'
          ? (err as { code: number }).code
          : err ? 1 : 0;
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), code });
      },
    );
  });
}

/**
 * Public surface for the headless tmux backing. Methods map
 * 1:1 to a single tmux verb each — easier to audit and easier
 * to mock for tests if a harness lands.
 */
export class TmuxBacking implements vscode.Disposable {
  /**
   * Spawn a new detached tmux session that runs `command` in
   * `workDir` with `env`. Returns the resolved tmux session
   * name (caller can keep it for later operations).
   *
   * Implementation notes:
   *  - `new-session -d` keeps it detached (no terminal hijack).
   *  - We pass the command as a single argv element to tmux,
   *    which then invokes the user's `$SHELL -c` to run it.
   *    tmux's own quoting handles the shell-boundary
   *    re-escape — we don't try to pre-escape ourselves.
   *  - Env vars are merged in via tmux `-e KEY=VAL` flags
   *    (one flag per var). Names are restricted to
   *    `^[A-Z_][A-Z0-9_]*$` — anything weirder rejects the
   *    whole start.
   */
  async start(opts: {
    name: string;
    workDir: string;
    command: string;
    env: Record<string, string>;
  }): Promise<{ name: string }> {
    assertValidSessionName(opts.name);
    const envArgs: string[] = [];
    for (const [k, v] of Object.entries(opts.env)) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) {
        throw new Error(`tmux: invalid env-var name shape: ${JSON.stringify(k).slice(0, 40)}`);
      }
      // Reject newline / NUL — tmux's -e parsing tolerates most
      // chars but these would corrupt the command line.
      if (typeof v !== 'string' || v.includes('\0') || v.includes('\n')) {
        throw new Error(`tmux: invalid env-var value for ${k}`);
      }
      envArgs.push('-e', `${k}=${v}`);
    }
    const args = [
      '-d',
      '-s', opts.name,
      '-c', opts.workDir,
      ...envArgs,
      opts.command,
    ];
    const res = await runTmux('new-session', args);
    if (res.code !== 0) {
      throw new Error(`tmux new-session failed (code ${res.code}): ${res.stderr.trim() || res.stdout.trim() || 'no output'}`);
    }
    return { name: opts.name };
  }

  /** Returns true if a session with the given name is currently alive. */
  async hasSession(name: string): Promise<boolean> {
    assertValidSessionName(name);
    const res = await runTmux('has-session', ['-t', name]);
    return res.code === 0;
  }

  /** Kill a session by name. Returns true if tmux reported success. */
  async kill(name: string): Promise<boolean> {
    assertValidSessionName(name);
    const res = await runTmux('kill-session', ['-t', name]);
    return res.code === 0;
  }

  /**
   * List every session on our dedicated socket (one name per
   * line). Used by SessionReattacher to detect existing
   * tmux-backed agents at activation.
   *
   * Returns empty when the socket has no server (no sessions
   * yet) — the caller treats this as "no tmux-backed agents."
   */
  async list(): Promise<string[]> {
    const res = await runTmux('list-sessions', ['-F', '#{session_name}']);
    if (res.code !== 0) { return []; }
    return res.stdout
      .split('\n')
      .map(s => s.trim())
      .filter(s => s.length > 0 && SESSION_NAME_RE.test(s));
  }

  /**
   * Send a keystroke / text to a running session. `text` is
   * passed as a tmux literal (the `-l` flag) so it isn't
   * interpreted as a tmux key-binding — this prevents an
   * attacker who could influence the text from injecting
   * tmux commands.
   */
  async sendInput(name: string, text: string): Promise<void> {
    assertValidSessionName(name);
    if (text.includes('\0')) {
      throw new Error('tmux sendInput: NUL byte rejected');
    }
    const res = await runTmux('send-keys', ['-t', name, '-l', text]);
    if (res.code !== 0) {
      throw new Error(`tmux send-keys failed (code ${res.code}): ${res.stderr.trim() || 'no stderr'}`);
    }
  }

  /**
   * Capture the visible buffer of a tmux pane. Useful when the
   * session is tmux-backed (the agent's TUI/stdout isn't piped
   * anywhere else) and we want a snapshot for the chat panel
   * or for debug. ANSI escapes are stripped — see
   * `stripAnsiEscapes`.
   */
  async capture(name: string): Promise<string> {
    assertValidSessionName(name);
    const res = await runTmux('capture-pane', ['-t', name, '-p', '-J']);
    if (res.code !== 0) { return ''; }
    return stripAnsiEscapes(res.stdout);
  }

  dispose(): void {
    // No long-lived state to clean up — every method spawns and
    // reaps its own child.
  }
}

/**
 * Strip a conservative set of ANSI escape sequences. Not a full
 * terminal emulator — handles CSI sequences (the dominant case:
 * cursor movement, color codes) and bare ESC sequences. Newlines,
 * tabs, and other text characters are preserved.
 *
 * Used before any tmux pane output crosses into chat rendering —
 * paired with the existing webview escHtml discipline (#1610)
 * so the strings are sanitization-clean by the time they reach
 * the DOM.
 */
export function stripAnsiEscapes(s: string): string {
  if (!s) { return ''; }
  // CSI sequences: ESC [ ... letter
  // OSC sequences: ESC ] ... BEL or ESC ] ... ESC \
  // Other escapes: ESC <single-char>
  // eslint-disable-next-line no-control-regex
  const csi = /\x1B\[[0-?]*[ -/]*[@-~]/g;
  // eslint-disable-next-line no-control-regex
  const osc = /\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g;
  // eslint-disable-next-line no-control-regex
  const other = /\x1B[@-Z\\-_]/g;
  return s.replace(csi, '').replace(osc, '').replace(other, '');
}
