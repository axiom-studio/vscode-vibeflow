import * as vscode from 'vscode';
import type { NormalizedAgentEvent, ProviderKey } from '../../sessions/providerAdapters/types.js';
import { redactCredentials } from '../../sessions/providerAdapters/types.js';

/**
 * Single VS Code Output channel that renders the normalized event
 * stream from all running agent processes. One channel for the whole
 * extension (sessions are differentiated by prefix); users open it via
 * the `vibeflow.openAgentActivity` command.
 *
 * Rationale for one channel (vs. per-session): the user typically
 * watches one or two agents at a time, and VS Code's Output panel
 * already supports text search / filtering. Multiple channels would
 * proliferate noisy entries in the Output dropdown and make
 * cross-session correlation harder.
 *
 * Credentials are redacted before any event is written (defensive —
 * Anthropic / OpenAI / Google / Alibaba / Cursor's stream-json
 * spec all exclude API keys from stdout, but a future regression
 * could leak; we strip a known set of credential field names
 * regardless).
 */
export class AgentActivityOutputChannel implements vscode.Disposable {
  private readonly channel: vscode.LogOutputChannel;

  constructor() {
    this.channel = vscode.window.createOutputChannel('VibeFlow Agent Activity', { log: true });
  }

  /** Render one event with a session-aware prefix. */
  appendEvent(opts: {
    providerKey: ProviderKey;
    persona: string;
    branch: string;
    agentSessionId?: string;
    event: NormalizedAgentEvent;
  }): void {
    const prefix = this.formatPrefix(opts);
    const event = opts.event;

    switch (event.kind) {
      case 'session_init':
        this.channel.info(
          `${prefix} agent ready (model=${event.model ?? 'unknown'}${event.toolNames?.length ? `, tools=${event.toolNames.length}` : ''})`,
        );
        break;
      case 'agent_text':
        if (event.delta) {
          this.channel.debug(`${prefix} ${truncate(event.delta, 200)}`);
        }
        break;
      case 'tool_use':
        this.channel.info(`${prefix} → ${event.toolName} ${truncate(JSON.stringify(redactCredentials(event.input)), 200)}`);
        break;
      case 'tool_result':
        if (event.isError) {
          this.channel.warn(`${prefix} ← ${event.toolUseId} (error) ${truncate(JSON.stringify(event.content), 200)}`);
        } else {
          this.channel.debug(`${prefix} ← ${event.toolUseId} ok`);
        }
        break;
      case 'api_retry':
        this.channel.warn(
          `${prefix} provider retry (${event.reason}${event.etaSeconds ? `, eta ${event.etaSeconds}s` : ''})`,
        );
        break;
      case 'turn_complete':
        this.channel.debug(`${prefix} turn complete`);
        break;
      case 'error':
        this.channel.error(`${prefix} ${event.message}`);
        break;
      case 'unknown':
        this.channel.debug(`${prefix} (raw) ${truncate(safeJsonStringify(redactCredentials(event.raw)), 500)}`);
        break;
    }
  }

  /** Render a stderr chunk (provider may print warnings / progress to stderr). */
  appendStderr(opts: {
    providerKey: ProviderKey;
    persona: string;
    branch: string;
    chunk: string;
  }): void {
    const prefix = this.formatPrefix({ ...opts, event: { kind: 'unknown', raw: null } as NormalizedAgentEvent });
    const trimmed = opts.chunk.trimEnd();
    if (trimmed) {
      this.channel.warn(`${prefix} (stderr) ${truncate(trimmed, 500)}`);
    }
  }

  /** Render a parse error so a maintainer can see what failed. */
  appendParseError(opts: {
    providerKey: ProviderKey;
    persona: string;
    branch: string;
    line: string;
    err: unknown;
  }): void {
    const prefix = this.formatPrefix({ ...opts, event: { kind: 'unknown', raw: null } as NormalizedAgentEvent });
    const message = opts.err instanceof Error ? opts.err.message : String(opts.err);
    this.channel.error(`${prefix} parse error: ${message} (line: ${truncate(opts.line, 200)})`);
  }

  /** Render an exit notification. */
  appendExit(opts: {
    providerKey: ProviderKey;
    persona: string;
    branch: string;
    agentSessionId?: string;
    code: number | null;
    signal: NodeJS.Signals | null;
  }): void {
    const prefix = this.formatPrefix({ ...opts, event: { kind: 'turn_complete', raw: null } as NormalizedAgentEvent });
    const suffix = opts.signal ? `signal=${opts.signal}` : `code=${opts.code ?? 'null'}`;
    this.channel.info(`${prefix} exited (${suffix})`);
  }

  /**
   * Render the exact spawn command for a stream. Logged once per
   * launch so the user can copy-paste the binary + argv into a shell
   * if they need to repro outside the extension.
   */
  appendSpawn(opts: {
    providerKey: ProviderKey;
    persona: string;
    branch: string;
    binary: string;
    argv: readonly string[];
    cwd: string;
  }): void {
    const prefix = this.formatPrefix({ ...opts, event: { kind: 'unknown', raw: null } as NormalizedAgentEvent });
    const quoted = opts.argv.map(a => /[\s'"]/.test(a) ? JSON.stringify(a) : a).join(' ');
    this.channel.info(`${prefix} spawn (cwd=${opts.cwd}): ${opts.binary} ${quoted}`);
  }

  /**
   * Render a "no events yet" warning fired by the registry's watchdog.
   * Surfaces silent hangs (binary waiting on stdin, auth stuck) before
   * the 30s session_init timeout kicks in.
   */
  appendSilent(opts: {
    providerKey: ProviderKey;
    persona: string;
    branch: string;
    elapsedMs: number;
  }): void {
    const prefix = this.formatPrefix({ ...opts, event: { kind: 'unknown', raw: null } as NormalizedAgentEvent });
    this.channel.warn(
      `${prefix} no events in ${Math.round(opts.elapsedMs / 1000)}s — binary may be hung. Check the spawn line above to repro.`,
    );
  }

  /** Reveal the Output channel in the VS Code panel. */
  show(): void {
    this.channel.show();
  }

  dispose(): void {
    this.channel.dispose();
  }

  // --- internal ---

  private formatPrefix(opts: {
    providerKey: ProviderKey;
    persona: string;
    branch: string;
    agentSessionId?: string;
    event: NormalizedAgentEvent;
  }): string {
    const sessionSuffix = opts.agentSessionId ? `:${opts.agentSessionId.slice(-8)}` : '';
    return `[${opts.providerKey}/${opts.persona}@${opts.branch}${sessionSuffix}]`;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) { return s; }
  return s.slice(0, max - 1) + '…';
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
