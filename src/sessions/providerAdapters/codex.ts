import type { ProviderAdapter, NormalizedAgentEvent } from './types.js';

/**
 * OpenAI Codex CLI stream-json adapter.
 *
 * Spawn: `codex exec --json --yolo "<initPrompt>"`
 *
 * Documented at:
 *   - https://developers.openai.com/codex/noninteractive
 *   - https://developers.openai.com/codex/cli/reference
 *   - https://github.com/openai/codex/blob/main/docs/exec.md
 *
 * Native event vocabulary (per docs):
 *   - { type:'thread.started', thread_id, model? }
 *   - { type:'thread.completed', thread_id }
 *   - { type:'turn.started' | 'turn.completed' | 'turn.failed', turn_id, ... }
 *   - { type:'item.assistant_message', text }
 *   - { type:'item.reasoning', text }
 *   - { type:'item.command_execution', command, exit_code? }
 *   - { type:'item.file_change', path, before?, after? }
 *   - { type:'item.mcp_tool_call', server, tool, arguments, result? }
 *   - { type:'item.web_search', query }
 *   - { type:'item.plan_update', plan }
 *   - { type:'error', message }
 *
 * Chat-relevant signal: `item.mcp_tool_call` where `tool` is
 * `prompt_user` or `respond_to_prompt`. Other item.* events are
 * operational narration — surface in the Output channel.
 *
 * Codex may emit a tool call and its result in separate events OR
 * bundle them. The adapter emits a tool_use on every call; if a
 * result is bundled, the consumer sees it via `result` in the input
 * payload's raw form.
 *
 * Example fixtures:
 *
 *   normalize({ type:'thread.started', thread_id:'t1', model:'gpt-5-codex' })
 *     → { kind:'session_init', agentSessionId:'t1', model:'gpt-5-codex', raw:<input> }
 *
 *   normalize({ type:'item.assistant_message', text:'Reading the file...' })
 *     → { kind:'agent_text', delta:'Reading the file...', raw:<input> }
 *
 *   normalize({ type:'item.mcp_tool_call', id:'c1', server:'vibeflow', tool:'prompt_user', arguments:{prompt_text:'Continue?'} })
 *     → { kind:'tool_use', toolName:'prompt_user', toolUseId:'c1', input:{prompt_text:'Continue?'}, raw:<input> }
 *
 *   normalize({ type:'turn.completed', turn_id:'tr1' })
 *     → { kind:'turn_complete', raw:<input> }
 *
 *   normalize({ type:'error', message:'Rate limited' })
 *     → { kind:'error', message:'Rate limited', raw:<input> }
 */
export const codexAdapter: ProviderAdapter = {
  providerKey: 'codex',

  buildArgs: ({ initPrompt }) => ['exec', '--json', '--yolo', initPrompt],

  normalize: (raw: unknown): NormalizedAgentEvent => {
    if (!raw || typeof raw !== 'object') { return { kind: 'unknown', raw }; }
    const e = raw as Record<string, unknown>;
    const type = typeof e.type === 'string' ? e.type : '';

    if (type === 'thread.started') {
      return {
        kind: 'session_init',
        agentSessionId: typeof e.thread_id === 'string' ? e.thread_id : undefined,
        model: typeof e.model === 'string' ? e.model : undefined,
        raw,
      };
    }

    if (type === 'turn.completed' || type === 'turn.failed' || type === 'thread.completed') {
      return { kind: 'turn_complete', raw };
    }

    if (type === 'item.assistant_message' || type === 'item.reasoning') {
      const text = typeof e.text === 'string' ? e.text : '';
      return { kind: 'agent_text', delta: text, raw };
    }

    if (type === 'item.mcp_tool_call') {
      const toolName = typeof e.tool === 'string'
        ? e.tool
        : typeof e.tool_name === 'string'
          ? e.tool_name
          : '';
      const toolUseId = typeof e.id === 'string'
        ? e.id
        : typeof e.call_id === 'string'
          ? e.call_id
          : '';
      const input = e.arguments ?? e.input ?? {};
      return {
        kind: 'tool_use',
        toolName,
        toolUseId,
        input,
        raw,
      };
    }

    // Operational narration: command runs, file edits, web searches,
    // plan updates. Surfaced in the Output channel via the `unknown`
    // pass-through — they're not chat content.
    if (
      type === 'item.command_execution' ||
      type === 'item.file_change' ||
      type === 'item.web_search' ||
      type === 'item.plan_update' ||
      type === 'turn.started'
    ) {
      return { kind: 'unknown', raw };
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
