import type { ProviderAdapter, NormalizedAgentEvent } from './types.js';

/**
 * Claude Code stream-json adapter.
 *
 * Spawn:
 *   claude --print
 *          --input-format stream-json
 *          --output-format stream-json
 *          --verbose
 *          --dangerously-skip-permissions
 *          "<initPrompt>"
 *
 * Documented at:
 *   - https://code.claude.com/docs/en/headless
 *   - https://code.claude.com/docs/en/cli-reference
 *   - https://github.com/anthropics/claude-code/issues/24594
 *
 * The `--verbose` flag is REQUIRED to get the full per-event stream;
 * without it Claude only emits the final result event. `--print`
 * combined with `--input-format stream-json` enables multi-turn
 * streaming over stdin/stdout. `--dangerously-skip-permissions` is
 * required because chat-first headless mode has no UI to display
 * per-tool permission prompts (already gated in #1611 via the user's
 * explicit consent dialog).
 *
 * Native event vocabulary (verified from docs + observed runs):
 *   - { type:'system', subtype:'init', session_id, model, tools: string[] }
 *   - { type:'system', subtype:'api_retry', reason, retry_after_seconds? }
 *   - { type:'assistant', message:{ content:[{type:'text', text}, ...] } }
 *   - { type:'tool_use', id, name, input }
 *   - { type:'tool_result', tool_use_id, content, is_error }
 *   - { type:'result', subtype:'success'|'error', session_id, duration_ms }
 *   - { type:'error', message }
 *
 * Example fixtures (used as inline doctests; if a test harness is
 * added later, these become canonical test inputs):
 *
 *   normalize({ type:'system', subtype:'init', session_id:'s1', model:'claude-opus-4-7', tools:['Bash','Read'] })
 *     → { kind:'session_init', agentSessionId:'s1', model:'claude-opus-4-7', toolNames:['Bash','Read'], raw:<input> }
 *
 *   normalize({ type:'tool_use', id:'toolu_42', name:'prompt_user', input:{ prompt_text:'Continue?' } })
 *     → { kind:'tool_use', toolName:'prompt_user', toolUseId:'toolu_42', input:{prompt_text:'Continue?'}, raw:<input> }
 *
 *   normalize({ type:'system', subtype:'api_retry', reason:'rate_limit', retry_after_seconds:30 })
 *     → { kind:'api_retry', reason:'rate_limit', etaSeconds:30, raw:<input> }
 *
 *   normalize({ type:'frobnicate' })
 *     → { kind:'unknown', raw:<input> }
 *
 *   normalize(null)
 *     → { kind:'unknown', raw:null }
 */
export const claudeAdapter: ProviderAdapter = {
  providerKey: 'claude',

  buildArgs: ({ initPrompt, mcpConfigPath }) => {
    // Headless `claude --print` does NOT auto-load `.mcp.json` from the
    // workspace the way the TUI does — per
    // https://docs.anthropic.com/en/docs/claude-code/headless-mode the
    // `--mcp-config <file>` flag is required to register MCP servers in
    // headless mode. Without it the agent boots with zero MCP servers,
    // can't call `session_init` against the VibeFlow MCP, and the
    // chat-first launch path (which polls the backend for a session
    // row) times out after 30s. Fixed by todo #1621.
    const args = [
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ];
    if (mcpConfigPath) {
      args.push('--mcp-config', mcpConfigPath);
    }
    args.push(initPrompt);
    return args;
  },

  normalize: (raw: unknown): NormalizedAgentEvent => {
    if (!raw || typeof raw !== 'object') { return { kind: 'unknown', raw }; }
    const e = raw as Record<string, unknown>;
    const type = typeof e.type === 'string' ? e.type : '';

    if (type === 'system') {
      const subtype = typeof e.subtype === 'string' ? e.subtype : '';
      if (subtype === 'init') {
        const tools = Array.isArray(e.tools)
          ? (e.tools as unknown[]).filter((t): t is string => typeof t === 'string')
          : undefined;
        return {
          kind: 'session_init',
          agentSessionId: typeof e.session_id === 'string' ? e.session_id : undefined,
          model: typeof e.model === 'string' ? e.model : undefined,
          toolNames: tools,
          raw,
        };
      }
      if (subtype === 'api_retry') {
        return {
          kind: 'api_retry',
          reason: typeof e.reason === 'string' ? e.reason : 'unknown',
          etaSeconds: typeof e.retry_after_seconds === 'number' ? e.retry_after_seconds : undefined,
          raw,
        };
      }
      return { kind: 'unknown', raw };
    }

    if (type === 'assistant') {
      // `message.content` is an array of content blocks; extract the
      // first text block. Streaming text deltas have the same shape.
      const message = e.message as Record<string, unknown> | undefined;
      const content = Array.isArray(message?.content) ? message?.content : [];
      const textBlock = content.find(
        (c): c is Record<string, unknown> =>
          typeof c === 'object' && c !== null && (c as Record<string, unknown>).type === 'text',
      );
      const text = textBlock && typeof textBlock.text === 'string' ? textBlock.text : '';
      return { kind: 'agent_text', delta: text, raw };
    }

    if (type === 'tool_use') {
      return {
        kind: 'tool_use',
        toolName: typeof e.name === 'string' ? e.name : '',
        toolUseId: typeof e.id === 'string' ? e.id : '',
        input: e.input ?? {},
        raw,
      };
    }

    if (type === 'tool_result') {
      return {
        kind: 'tool_result',
        toolUseId: typeof e.tool_use_id === 'string' ? e.tool_use_id : '',
        content: e.content,
        isError: e.is_error === true,
        raw,
      };
    }

    if (type === 'result') {
      return { kind: 'turn_complete', raw };
    }

    if (type === 'error') {
      return {
        kind: 'error',
        message: typeof e.message === 'string' ? e.message : 'unknown error',
        raw,
      };
    }

    return { kind: 'unknown', raw };
  },
};
