import type { ProviderAdapter, NormalizedAgentEvent } from './types.js';

/**
 * Qwen Code stream-json adapter.
 *
 * Spawn: `qwen -p "<initPrompt>" --output-format stream-json --yolo`
 *
 * Documented at:
 *   - https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/
 *   - https://github.com/QwenLM/qwen-code
 *
 * Schema lineage: Qwen Code is a fork of gemini-cli, so the wire
 * shape closely tracks Gemini's. We keep the adapters separate
 * anyway (intentional duplication) so a future divergence in
 * either provider doesn't require touching the other.
 *
 * Stream-json INPUT is marked "under construction" in Qwen's docs
 * but we never use stream-json input — sends go via REST
 * `createPrompt` per the architecture decision in document #285 §6.
 * Output stream-json is shipped and stable.
 *
 * Example fixtures:
 *
 *   normalize({ type:'system', subtype:'init', model:'qwen3-coder' })
 *     → { kind:'session_init', model:'qwen3-coder', raw:<input> }
 *
 *   normalize({ type:'tool_use', id:'t1', name:'prompt_user', input:{...} })
 *     → { kind:'tool_use', toolName:'prompt_user', toolUseId:'t1', input:{...}, raw:<input> }
 */
export const qwenAdapter: ProviderAdapter = {
  providerKey: 'qwen',

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
