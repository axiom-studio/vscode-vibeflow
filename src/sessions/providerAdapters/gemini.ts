import type { ProviderAdapter, NormalizedAgentEvent } from './types.js';

/**
 * Gemini CLI stream-json adapter.
 *
 * Spawn: `gemini -p "<initPrompt>" --output-format stream-json --yolo`
 *
 * Documented at:
 *   - https://google-gemini.github.io/gemini-cli/docs/cli/headless.html
 *   - https://github.com/google-gemini/gemini-cli
 *
 * The `-p` flag triggers non-interactive (headless) mode and passes
 * the prompt as a single user message. `--output-format stream-json`
 * emits newline-delimited JSON events; without it Gemini emits a
 * single result. `--yolo` matches the headless permission-skip
 * semantic used elsewhere in this codebase (see
 * `buildLaunchCommand` in `sessionCommands.ts`).
 *
 * Native event vocabulary: documented at a high level but exact
 * field shapes are not pinned. The adapter is permissive — it
 * accepts the common candidate field names observed in
 * gemini-family stream-json runs and falls through to `unknown`
 * for anything else.
 *
 * Example fixtures:
 *
 *   normalize({ type:'system', subtype:'init', model:'gemini-2.5-pro' })
 *     → { kind:'session_init', model:'gemini-2.5-pro', raw:<input> }
 *
 *   normalize({ type:'tool_use', id:'t1', name:'respond_to_prompt', input:{...} })
 *     → { kind:'tool_use', toolName:'respond_to_prompt', toolUseId:'t1', input:{...}, raw:<input> }
 */
export const geminiAdapter: ProviderAdapter = {
  providerKey: 'gemini',

  buildArgs: ({ initPrompt }) => [
    '-p', initPrompt,
    '--output-format', 'stream-json',
    '--yolo',
  ],

  normalize: (raw: unknown): NormalizedAgentEvent => {
    if (!raw || typeof raw !== 'object') { return { kind: 'unknown', raw }; }
    const e = raw as Record<string, unknown>;
    const type = typeof e.type === 'string' ? e.type : '';

    if (type === 'system' || type === 'system.init') {
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

    if (type === 'assistant' || type === 'assistant_message') {
      const message = e.message as Record<string, unknown> | undefined;
      const content = Array.isArray(message?.content) ? message?.content : [];
      const textBlock = content.find(
        (c): c is Record<string, unknown> =>
          typeof c === 'object' && c !== null && (c as Record<string, unknown>).type === 'text',
      );
      const text = textBlock && typeof textBlock.text === 'string'
        ? textBlock.text
        : typeof e.text === 'string' ? e.text : '';
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
