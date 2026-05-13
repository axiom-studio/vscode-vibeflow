import * as vscode from 'vscode';
import { StreamJsonProcess } from './streamJsonProcess.js';
import type { ProviderAdapter, NormalizedAgentEvent, ProviderKey } from './providerAdapters/types.js';

/**
 * Handle for one live agent-CLI stream process. The agent's session
 * id is discovered shortly after spawn (via the provider's
 * `session_init` event); until then, `agentSessionId` is undefined
 * and callers use `handleId` as the stable identifier.
 */
export interface StreamHandle {
  /** Stable identifier within this extension session. */
  readonly handleId: string;
  readonly providerKey: ProviderKey;
  /** Persona key (developer, qa_lead, etc.). */
  readonly persona: string;
  /** Git branch the agent is running on. */
  readonly branch: string;
  /** Agent's session id — set once the stream emits `session_init`. */
  agentSessionId?: string;
  /** Underlying child-process wrapper. */
  readonly process: StreamJsonProcess;
}

/**
 * Owns all per-session `StreamJsonProcess` instances for chat-first /
 * stream-json launches. Other parts of the extension (SessionPanelManager,
 * AgentActivityOutputChannel) subscribe to a single aggregated event
 * stream and route messages by session.
 *
 * Lifecycle:
 *   - `start(opts)` spawns a child process and returns a `StreamHandle`.
 *   - Each handle carries `agentSessionId` once the stream emits its
 *     first `session_init` event. Two indices are maintained: by
 *     `handleId` (stable from spawn) and by `agentSessionId` (set
 *     after init).
 *   - `getBySessionId(sessionId)` resolves a handle once the agent
 *     has registered with the server.
 *   - On child exit, the handle is removed from both indices and the
 *     `onExit` event fires with the agent session id (if known) so
 *     consumers can downgrade to REST polling.
 *
 * The registry does NOT own retry / restart logic. If a stream dies,
 * consumers degrade gracefully (REST polling fallback at the chat
 * panel layer; "Relaunch session" CTA at the user layer). This keeps
 * the registry simple and predictable.
 */
export class SessionStreamRegistry implements vscode.Disposable {
  private streams = new Map<string, StreamHandle>(); // handleId → handle
  private sessionToHandle = new Map<string, string>(); // agentSessionId → handleId
  private disposed = false;

  private readonly _onEvent = new vscode.EventEmitter<{
    handleId: string;
    agentSessionId?: string;
    providerKey: ProviderKey;
    persona: string;
    branch: string;
    event: NormalizedAgentEvent;
  }>();
  /** Aggregated normalized-event stream across all running agents. */
  readonly onEvent = this._onEvent.event;

  private readonly _onParseError = new vscode.EventEmitter<{
    handleId: string;
    line: string;
    err: unknown;
  }>();
  readonly onParseError = this._onParseError.event;

  private readonly _onStderr = new vscode.EventEmitter<{
    handleId: string;
    chunk: string;
  }>();
  readonly onStderr = this._onStderr.event;

  private readonly _onExit = new vscode.EventEmitter<{
    handleId: string;
    agentSessionId?: string;
    providerKey: ProviderKey;
    persona: string;
    branch: string;
    code: number | null;
    signal: NodeJS.Signals | null;
  }>();
  readonly onExit = this._onExit.event;

  /**
   * Fired immediately after a child process is spawned with the exact
   * binary + argv + cwd used. Subscribers (the Agent Activity output
   * channel) log this so users debugging a chat-first launch can
   * reproduce the command verbatim in a shell.
   */
  private readonly _onSpawn = new vscode.EventEmitter<{
    handleId: string;
    providerKey: ProviderKey;
    persona: string;
    branch: string;
    binary: string;
    argv: readonly string[];
    cwd: string;
  }>();
  readonly onSpawn = this._onSpawn.event;

  /**
   * Fired when a process has been alive for `WATCHDOG_MS` without
   * emitting any stream event. Lets the user notice silent hangs
   * (Claude waiting on stdin, binary mis-config) without needing to
   * sit through the 30s session_init timeout. Subscribers should
   * surface a warning into the Agent Activity output channel.
   */
  private readonly _onSilent = new vscode.EventEmitter<{
    handleId: string;
    providerKey: ProviderKey;
    persona: string;
    branch: string;
    elapsedMs: number;
  }>();
  readonly onSilent = this._onSilent.event;

  /** Watchdog window — fires once if no events arrive within this. */
  private static readonly WATCHDOG_MS = 15000;

  /**
   * Spawn a new agent process in stream-json mode and register it.
   * Returns the handle immediately; the `agentSessionId` field is
   * populated asynchronously when the stream emits `session_init`.
   */
  start(opts: {
    providerKey: ProviderKey;
    persona: string;
    branch: string;
    workDir: string;
    binary: string;
    adapter: ProviderAdapter;
    env: Record<string, string>;
    initPrompt: string;
    /**
     * Absolute path to the workspace's `.mcp.json` file. Forwarded to
     * the adapter's `buildArgs` so providers whose headless mode
     * requires explicit MCP config (Claude `--mcp-config <path>`) can
     * register the VibeFlow MCP server at spawn time. Without it the
     * agent boots with no MCP servers and can't call session_init.
     */
    mcpConfigPath?: string;
  }): StreamHandle {
    const handleId = `${opts.providerKey}::${opts.persona}::${opts.branch}::${Date.now()}::${Math.random().toString(36).slice(2, 8)}`;

    const proc = new StreamJsonProcess({
      binary: opts.binary,
      adapter: opts.adapter,
      cwd: opts.workDir,
      env: opts.env,
      initPrompt: opts.initPrompt,
      mcpConfigPath: opts.mcpConfigPath,
    });

    const handle: StreamHandle = {
      handleId,
      providerKey: opts.providerKey,
      persona: opts.persona,
      branch: opts.branch,
      process: proc,
    };

    this.streams.set(handleId, handle);

    // Surface the exact command for diagnostics — copy-paste reproducible.
    this._onSpawn.fire({
      handleId,
      providerKey: opts.providerKey,
      persona: opts.persona,
      branch: opts.branch,
      binary: opts.binary,
      argv: proc.argv,
      cwd: opts.workDir,
    });

    // Watchdog: if the child emits zero events / stderr in WATCHDOG_MS,
    // it's likely hung (binary waiting on stdin, auth stuck, network
    // dead). Fire once so the output channel can surface a hint.
    let firstSignal = false;
    const watchdog = setTimeout(() => {
      if (!firstSignal && this.streams.has(handleId)) {
        this._onSilent.fire({
          handleId,
          providerKey: opts.providerKey,
          persona: opts.persona,
          branch: opts.branch,
          elapsedMs: SessionStreamRegistry.WATCHDOG_MS,
        });
      }
    }, SessionStreamRegistry.WATCHDOG_MS);
    const markSignal = () => {
      if (firstSignal) { return; }
      firstSignal = true;
      clearTimeout(watchdog);
    };

    proc.onEvent(event => {
      markSignal();
      // Bootstrap agentSessionId on the first init event.
      if (event.kind === 'session_init' && event.agentSessionId && !handle.agentSessionId) {
        handle.agentSessionId = event.agentSessionId;
        this.sessionToHandle.set(event.agentSessionId, handleId);
      }
      this._onEvent.fire({
        handleId,
        agentSessionId: handle.agentSessionId,
        providerKey: opts.providerKey,
        persona: opts.persona,
        branch: opts.branch,
        event,
      });
    });

    proc.onParseError(({ line, err }) => {
      markSignal();
      this._onParseError.fire({ handleId, line, err });
    });

    proc.onStderr(chunk => {
      markSignal();
      this._onStderr.fire({ handleId, chunk });
    });

    proc.onExit(({ code, signal }) => {
      markSignal();
      this._onExit.fire({
        handleId,
        agentSessionId: handle.agentSessionId,
        providerKey: opts.providerKey,
        persona: opts.persona,
        branch: opts.branch,
        code,
        signal,
      });
      this.streams.delete(handleId);
      if (handle.agentSessionId) {
        this.sessionToHandle.delete(handle.agentSessionId);
      }
      proc.dispose();
    });

    return handle;
  }

  /** Resolve a handle once the agent has registered its session id. */
  getBySessionId(sessionId: string): StreamHandle | undefined {
    const handleId = this.sessionToHandle.get(sessionId);
    return handleId ? this.streams.get(handleId) : undefined;
  }

  /** Resolve a handle by its stable spawn-time id. */
  get(handleId: string): StreamHandle | undefined {
    return this.streams.get(handleId);
  }

  /**
   * Find a live handle by persona + branch. Used by the launch path
   * to dedupe concurrent same-persona launches and by the panel
   * layer to discover the stream before the agent registers.
   */
  findByPersonaBranch(persona: string, branch: string): StreamHandle | undefined {
    for (const handle of this.streams.values()) {
      if (handle.persona === persona && handle.branch === branch) {
        return handle;
      }
    }
    return undefined;
  }

  /** All live handles (snapshot). */
  list(): StreamHandle[] {
    return Array.from(this.streams.values());
  }

  /** SIGTERM the child for the given agent session id. Idempotent. */
  killBySessionId(sessionId: string): boolean {
    const handle = this.getBySessionId(sessionId);
    if (!handle) { return false; }
    handle.process.kill();
    return true;
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    for (const handle of this.streams.values()) {
      handle.process.dispose();
    }
    this.streams.clear();
    this.sessionToHandle.clear();
    this._onEvent.dispose();
    this._onParseError.dispose();
    this._onStderr.dispose();
    this._onExit.dispose();
    this._onSpawn.dispose();
    this._onSilent.dispose();
  }
}
