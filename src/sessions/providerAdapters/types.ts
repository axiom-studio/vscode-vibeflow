/**
 * Provider-agnostic stream-json event normalization.
 *
 * See VibeFlow document #285 ("Chat-First Realtime via stream-json") for
 * the full architectural rationale. Briefly:
 *
 *   - Each AI coding CLI (Claude Code, OpenAI Codex, Gemini CLI, Qwen
 *     Code, Cursor Agent) ships an officially-supported "stream-json" /
 *     "--json" transport that emits newline-delimited JSON events over
 *     stdout.
 *   - The event vocabularies differ between providers.
 *   - This module defines the COMMON normalized event shape that the
 *     rest of the extension (SessionPanelManager, Agent Activity Output
 *     channel, chat state) sees. Per-provider adapters map native
 *     events into this shape via a single pure `normalize(raw)`
 *     function.
 *
 * Adapters are intentionally PURE FUNCTIONS — no side effects, no I/O,
 * no VS Code APIs. They are trivial to test against fixture JSONL
 * captures from real CLI runs. The project has no test harness today;
 * if one is added later (vitest), tests can be written against the
 * fixtures embedded in each adapter's docstring without changing the
 * adapter code.
 */

/**
 * Provider key as used by the launch wizard's PROVIDERS list and the
 * agent CLI binary-name dispatch in `sessionCommands.ts`.
 */
export type ProviderKey = 'claude' | 'codex' | 'gemini' | 'qwen' | 'cursor';

/**
 * Normalized agent event. Discriminated by `kind`. Every variant
 * carries the original raw JSON in `raw` so the Agent Activity Output
 * channel can display the verbatim payload for debugging / auditing.
 *
 * The set is deliberately small — the extension renders chat content
 * from `tool_use` events (when toolName is `prompt_user` or
 * `respond_to_prompt`) and surfaces everything else in the Output
 * channel. If a provider emits an event whose meaning we don't yet
 * handle, the adapter emits a `{ kind: 'unknown', raw }` variant; the
 * Output channel renders the raw JSON and nothing crashes.
 */
export type NormalizedAgentEvent =
  /** Agent process initialized — first event in a session. */
  | {
      kind: 'session_init';
      /**
       * Provider's own session id (NOT to be confused with VibeFlow's
       * session_id; some providers expose theirs in init events).
       */
      agentSessionId?: string;
      model?: string;
      /** Names of tools the agent has access to (informational; Output channel). */
      toolNames?: string[];
      raw: unknown;
    }
  /**
   * Agent producing textual reply / reasoning content (operational
   * narration, not the canonical chat content — chat lives in the
   * `prompt_user` / `respond_to_prompt` MCP tool calls).
   */
  | {
      kind: 'agent_text';
      delta: string;
      raw: unknown;
    }
  /**
   * Agent invoked a tool — including MCP tools. Chat content lives
   * here when toolName is `prompt_user` or `respond_to_prompt`.
   */
  | {
      kind: 'tool_use';
      /** e.g., `prompt_user`, `respond_to_prompt`, `bash`, `Read`, `Edit`, … */
      toolName: string;
      /** Provider-assigned id for matching this call with its result. */
      toolUseId: string;
      /** Tool input arguments (provider-shaped JSON). */
      input: unknown;
      raw: unknown;
    }
  /** Result of a tool invocation. */
  | {
      kind: 'tool_result';
      toolUseId: string;
      content: unknown;
      isError: boolean;
      raw: unknown;
    }
  /**
   * Upstream API rate-limit / retry signal. Not all providers expose
   * this; adapters that don't see one in the native event stream
   * simply never emit this variant.
   */
  | {
      kind: 'api_retry';
      reason: string;
      etaSeconds?: number;
      raw: unknown;
    }
  /**
   * Turn (single user→agent exchange) completed. Mostly informational;
   * in our multi-turn flow, turns chain via the agent's autonomous
   * loop.
   */
  | {
      kind: 'turn_complete';
      raw: unknown;
    }
  /** Adapter detected a provider-emitted error. */
  | {
      kind: 'error';
      message: string;
      raw: unknown;
    }
  /**
   * Adapter received an event it does not yet recognize — defensive
   * default. The raw payload still surfaces in the Output channel.
   */
  | {
      kind: 'unknown';
      raw: unknown;
    };

/**
 * Per-provider adapter. Pure functions only — no VS Code APIs, no
 * I/O, no side effects.
 */
export interface ProviderAdapter {
  /** Provider key — must match the launch wizard's PROVIDERS list. */
  readonly providerKey: ProviderKey;

  /**
   * Build the argv array to pass to `child_process.spawn` for
   * stream-json headless mode. The init prompt is passed as a
   * positional argument or via stdin per the provider's convention.
   *
   * `mcpConfigPath` (optional): absolute path to a `.mcp.json` file.
   * Claude Code's headless mode (and other providers that follow the
   * same model) does NOT auto-discover MCP config in the workspace —
   * it must be passed explicitly via the provider's `--mcp-config`
   * flag. Without it, the spawned agent boots with zero MCP servers
   * and can't call VibeFlow MCP tools like `session_init`. See todo
   * #1621 for the gap that surfaced this. Adapters that don't yet
   * wire the flag may safely ignore the field; they document their
   * gap with a TODO in the body.
   */
  buildArgs(opts: { initPrompt: string; mcpConfigPath?: string }): string[];

  /**
   * Optional: payload to write to the child's stdin immediately after
   * spawn. When defined, StreamJsonProcess writes the returned bytes
   * and then calls `stdin.end()` to signal EOF.
   *
   * Required for providers whose stream-json INPUT format is mandatory
   * (Claude Code: `--input-format stream-json` makes the binary read
   * user messages from stdin as JSON-per-line; the positional prompt
   * is ignored). Without writing + ending stdin, those binaries hang
   * forever waiting for input.
   *
   * Adapters that pass the prompt via positional argv can omit this —
   * StreamJsonProcess will close stdin after spawn either way so the
   * binary can't block on `read(stdin)`.
   */
  buildStdinPayload?(opts: { initPrompt: string }): string;

  /**
   * Translate a single raw JSON event from the provider's stdout into
   * the normalized event shape. Must NEVER throw — unknown shapes
   * return `{ kind: 'unknown', raw }` so the listener never crashes
   * mid-stream.
   */
  normalize(raw: unknown): NormalizedAgentEvent;
}

/**
 * Default credential-redaction helper used by Output-channel and log
 * pipelines before they print a raw event. Strips a known set of
 * credential field names from a SHALLOW copy of a JSON object.
 * Recursive descent is avoided to keep cost predictable; the
 * providers we support carry credentials (if any) at the top level
 * of the init event.
 *
 * Adapters that emit credentials deeper than top-level should provide
 * their own redaction (none of the current five do).
 */
export function redactCredentials(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return raw; }
  const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  const credentialKeys = [
    'api_key', 'apiKey', 'API_KEY',
    'token', 'access_token', 'accessToken',
    'auth', 'authorization', 'Authorization',
    'secret', 'password',
  ];
  for (const k of credentialKeys) {
    if (k in out) { out[k] = '[REDACTED]'; }
  }
  return out;
}

/**
 * Type guard for the chat-relevant tool_use events the
 * SessionPanelManager routes to the chat panel. These are the only
 * stream-json events that synthesize chat messages; everything else
 * goes to the Output channel.
 */
export function isChatToolUse(
  event: NormalizedAgentEvent,
): event is Extract<NormalizedAgentEvent, { kind: 'tool_use' }> {
  return event.kind === 'tool_use'
    && (event.toolName === 'prompt_user' || event.toolName === 'respond_to_prompt');
}
