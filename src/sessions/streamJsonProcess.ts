import { spawn, type ChildProcess } from 'child_process';
import * as vscode from 'vscode';
import type { ProviderAdapter, NormalizedAgentEvent } from './providerAdapters/types.js';

/**
 * Owns one running agent-CLI child process spawned in stream-json
 * mode. See VibeFlow document #285 for the architectural rationale.
 *
 * Responsibilities:
 *   - spawn the binary with the adapter-supplied argv
 *   - buffer stdout into newline-delimited chunks (provider docs are
 *     consistent: one JSON object per line; partial lines must be
 *     held until the next chunk completes them)
 *   - parse each line as JSON and run it through the adapter
 *   - surface normalized events via a VS Code EventEmitter
 *   - surface stderr verbatim (for the Agent Activity Output channel)
 *   - surface parse / spawn errors as events (do NOT throw — chat
 *     must keep working even if one line is malformed)
 *   - clean shutdown via kill() (SIGTERM) and dispose() releases the
 *     emitters
 *
 * Per the architecture doc, this is the ONLY component that knows
 * about child_process and NDJSON buffering. Everything downstream
 * (SessionStreamRegistry, SessionPanelManager) sees only the typed
 * NormalizedAgentEvent stream.
 */
export class StreamJsonProcess implements vscode.Disposable {
  private readonly proc: ChildProcess;
  private buf = '';
  private disposed = false;
  /** Argv (excluding the binary) used to spawn the child — exposed so
   *  the registry can surface the exact command for diagnostics. */
  readonly argv: readonly string[];

  private readonly _onEvent = new vscode.EventEmitter<NormalizedAgentEvent>();
  readonly onEvent = this._onEvent.event;

  private readonly _onStderr = new vscode.EventEmitter<string>();
  readonly onStderr = this._onStderr.event;

  private readonly _onParseError = new vscode.EventEmitter<{ line: string; err: unknown }>();
  readonly onParseError = this._onParseError.event;

  private readonly _onExit = new vscode.EventEmitter<{ code: number | null; signal: NodeJS.Signals | null }>();
  readonly onExit = this._onExit.event;

  constructor(opts: {
    binary: string;
    adapter: ProviderAdapter;
    cwd: string;
    env: Record<string, string>;
    initPrompt: string;
    /**
     * Absolute path to a `.mcp.json` config file. Forwarded to the
     * adapter's `buildArgs` so providers whose headless mode requires
     * an explicit `--mcp-config` flag (Claude Code) get it. Optional —
     * adapters that don't yet wire MCP through argv ignore this.
     */
    mcpConfigPath?: string;
  }) {
    const argv = opts.adapter.buildArgs({
      initPrompt: opts.initPrompt,
      mcpConfigPath: opts.mcpConfigPath,
    });
    this.argv = argv;

    // Spawn detached: false (default) — the child lives under the
    // extension host process and dies when the host dies. If the user
    // wants survival across IDE restart, that's tmux-backed mode
    // (todo #1615), tracked separately.
    this.proc = spawn(opts.binary, argv, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout?.setEncoding('utf-8');
    this.proc.stderr?.setEncoding('utf-8');

    this.proc.stdout?.on('data', chunk => this.onChunk(chunk, opts.adapter));
    this.proc.stderr?.on('data', chunk => this._onStderr.fire(String(chunk)));

    // Feed the init prompt via stdin for adapters that opt into the
    // stream-json input channel (Claude `--input-format stream-json`),
    // then close stdin unconditionally so providers can't hang on an
    // unread pipe. Adapters that pass the prompt via positional argv
    // (Codex, Gemini, Qwen, Cursor today) just see an EOF on stdin,
    // which is the documented behavior they handle gracefully.
    try {
      const payload = opts.adapter.buildStdinPayload?.({ initPrompt: opts.initPrompt });
      if (payload && this.proc.stdin) {
        this.proc.stdin.write(payload, 'utf-8');
      }
    } catch (err) {
      this._onStderr.fire(`<stdin write failed: ${err instanceof Error ? err.message : String(err)}>\n`);
    }
    this.proc.stdin?.end();

    this.proc.on('exit', (code, signal) => {
      // Flush any trailing line that wasn't newline-terminated. Most
      // providers emit a final `result` event followed by exit; some
      // may close stdout without a trailing newline.
      if (this.buf.trim()) {
        this.parseLine(this.buf.trim(), opts.adapter);
        this.buf = '';
      }
      this._onExit.fire({ code, signal });
    });

    this.proc.on('error', err => {
      // Spawn errors (binary not found, EACCES, etc.) surface as parse
      // errors so the listener can downgrade to REST polling without
      // a special-case branch.
      this._onParseError.fire({ line: '<spawn error>', err });
    });
  }

  /** SIGTERM the child. Idempotent. */
  kill(): void {
    if (this.disposed) { return; }
    try {
      if (!this.proc.killed) { this.proc.kill('SIGTERM'); }
    } catch {
      // Child already gone — fine.
    }
  }

  /** True until SIGTERM is delivered or the child exits on its own. */
  get isAlive(): boolean {
    return !this.proc.killed && this.proc.exitCode === null;
  }

  /** Process id (for diagnostics / Output channel header). */
  get pid(): number | undefined {
    return this.proc.pid;
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    this.kill();
    this._onEvent.dispose();
    this._onStderr.dispose();
    this._onParseError.dispose();
    this._onExit.dispose();
  }

  // --- internal ---

  private onChunk(chunk: string | Buffer, adapter: ProviderAdapter): void {
    this.buf += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    let nl = this.buf.indexOf('\n');
    while (nl >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) { this.parseLine(line, adapter); }
      nl = this.buf.indexOf('\n');
    }
  }

  private parseLine(line: string, adapter: ProviderAdapter): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      this._onParseError.fire({ line, err });
      return;
    }
    // Adapters MUST never throw — guard anyway so a misbehaving
    // adapter doesn't take down the entire stream.
    let event: NormalizedAgentEvent;
    try {
      event = adapter.normalize(raw);
    } catch (err) {
      this._onParseError.fire({ line, err });
      return;
    }
    this._onEvent.fire(event);
  }
}
