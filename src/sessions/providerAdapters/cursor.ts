import type { ProviderAdapter, NormalizedAgentEvent } from './types.js';

/**
 * Cursor Agent stream-json adapter.
 *
 * Spawn: `<cursor binary> -p "<initPrompt>" --output-format stream-json --yolo --approve-mcps`
 *
 * The project's binary dispatch (`binaries` map in
 * `sessionCommands.ts`) maps the 'cursor' provider key to the binary
 * `agent`. Cursor's own docs reference `cursor-agent`. Either way,
 * the argv built by this adapter is binary-agnostic — the launcher
 * picks the binary path.
 *
 * Documented at:
 *   - https://cursor.com/docs/cli/headless
 *   - https://cursor.com/blog/cli
 *
 * **Beta**: the Cursor Agent CLI is explicitly in beta. Commit C
 * surfaces a `beta` indicator in the launch wizard when this
 * provider is selected for chat-first mode. Schema observability
 * is via the "Agent Activity" Output channel; any unrecognized
 * event surfaces as `unknown` without crashing chat.
 *
 * `--approve-mcps` is required to authorize MCP server calls
 * without an interactive prompt — matches the existing chat-first
 * YOLO contract (#1611).
 */
export const cursorAdapter: ProviderAdapter = {
  providerKey: 'cursor',

  buildArgs: ({ initPrompt }) => [
    '-p', initPrompt,
    '--output-format', 'stream-json',
    '--yolo',
    '--approve-mcps',
  ],

  normalize: (raw: unknown): NormalizedAgentEvent => {
    if (!raw || typeof raw !== 'object') { return { kind: 'unknown', raw }; }
    const e = raw as Record<string, unknown>;
    const type = typeof e.type === 'string' ? e.type : '';

    if (type === 'system' || type === 'system.init' || type === 'init') {
      return {
        kind: 'session_init',
        agentSessionId: typeof e.session_id === 'string' ? e.session_id : undefined,
        model: typeof e.model === 'string' ? e.model : undefined,
        toolNames: Array.isArray(e.tools)
          ? (e.tools as unknown[]).filter((t): t is string => typeof t === 'string')
          : undefined,
        raw,
      };
    }

    if (type === 'assistant' || type === 'delta' || type === 'assistant_delta') {
      const text = typeof e.text === 'string'
        ? e.text
        : typeof e.delta === 'string' ? e.delta : '';
      return { kind: 'agent_text', delta: text, raw };
    }

    if (type === 'tool_use' || type === 'tool_call') {
      return {
        kind: 'tool_use',
        toolName: typeof e.name === 'string'
          ? e.name
          : typeof e.tool === 'string' ? e.tool : '',
        toolUseId: typeof e.id === 'string' ? e.id : '',
        input: e.input ?? e.arguments ?? {},
        raw,
      };
    }

    if (type === 'tool_result') {
      return {
        kind: 'tool_result',
        toolUseId: typeof e.tool_use_id === 'string'
          ? e.tool_use_id
          : typeof e.id === 'string' ? e.id : '',
        content: e.content ?? e.result,
        isError: e.is_error === true || e.isError === true,
        raw,
      };
    }

    if (type === 'result' || type === 'turn_complete') {
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
