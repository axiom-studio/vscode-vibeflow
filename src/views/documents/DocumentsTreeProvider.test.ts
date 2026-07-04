import { describe, it, expect } from 'vitest';
import { buildBrainstormLeaves } from './DocumentsTreeProvider.js';
import type { VibeFlowBrainstormSession } from '../../api/types.js';

/**
 * Unit tests for `buildBrainstormLeaves` — the pure host-side reducer that maps
 * brainstorm sessions to the leaves rendered under the Documents tree's
 * "Brainstorms" node (todo #2800).
 *
 * The node-wrapping (vscode `TreeItem` construction, collapse-empty behavior)
 * lives in the provider class and is out of unit scope per vitest.config.ts —
 * this cohort covers the pure mapping: ordering, the finalized-vs-working
 * document preference, and label/description formatting.
 *
 * Pure function, pure data — no mocks (project testing policy).
 */

/** Build a brainstorm session with sensible defaults; override per test. */
function mk(over: Partial<VibeFlowBrainstormSession> = {}): VibeFlowBrainstormSession {
  return {
    id: 1,
    organization_id: 'org-1',
    project_id: 28,
    document_id: 100,
    final_document_id: null,
    lead_persona_key: 'product_manager',
    feature_id: null,
    status: 'active',
    initiator_session_id: 'session-x',
    config: {
      max_rounds: 5,
      timeout_per_persona: 300,
      scope_guard_enabled: true,
      token_budget: 500000,
      tokens_used: 0,
      paused: false,
      current_topic_index: 0,
    },
    round_number: 1,
    open_items: [],
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

describe('buildBrainstormLeaves', () => {
  it('returns [] for no brainstorms', () => {
    expect(buildBrainstormLeaves([])).toEqual([]);
  });

  it('maps a session to a leaf with label #id, status description, and its document', () => {
    const leaves = buildBrainstormLeaves([mk({ id: 7, status: 'active', document_id: 100 })]);
    expect(leaves).toEqual([
      { id: 7, label: 'Brainstorm #7', description: 'active', documentId: 100 },
    ]);
  });

  it('prefers final_document_id over document_id when the brainstorm is finalized', () => {
    const leaves = buildBrainstormLeaves([
      mk({ id: 3, status: 'done', document_id: 100, final_document_id: 200 }),
    ]);
    expect(leaves[0].documentId).toBe(200);
  });

  it('falls back to document_id (the working draft) when there is no final document', () => {
    const leaves = buildBrainstormLeaves([
      mk({ id: 4, status: 'active', document_id: 150, final_document_id: null }),
    ]);
    expect(leaves[0].documentId).toBe(150);
  });

  it('yields a null documentId when the session has neither document', () => {
    const leaves = buildBrainstormLeaves([
      mk({ id: 5, status: 'setup', document_id: null, final_document_id: null }),
    ]);
    expect(leaves[0].documentId).toBeNull();
  });

  it('orders newest-first by id and does not mutate the input array', () => {
    const input = [mk({ id: 1 }), mk({ id: 9 }), mk({ id: 4 })];
    const leaves = buildBrainstormLeaves(input);
    expect(leaves.map(l => l.id)).toEqual([9, 4, 1]);
    // Input order preserved (pure — operates on a copy).
    expect(input.map(b => b.id)).toEqual([1, 9, 4]);
  });
});
