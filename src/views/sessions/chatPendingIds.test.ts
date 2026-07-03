import { describe, it, expect } from 'vitest';
import { nextPendingIds, nextAgentPendingIds } from './chatPendingIds.js';
import type { VibeFlowPrompt } from '../../api/types.js';

function row(id: number, source: 'user' | 'agent', status: string): VibeFlowPrompt {
  return {
    id,
    created_at: '2026-07-03T00:00:00Z',
    updated_at: '2026-07-03T00:00:00Z',
    prompt_id: `p${id}`,
    prompt_text: 'q',
    response_text: '',
    status,
    responded_at: '',
    source,
  } as VibeFlowPrompt;
}

describe('nextPendingIds', () => {
  it('adds pending rows of any source and removes settled ones', () => {
    const s1 = nextPendingIds(new Set(), [row(1, 'user', 'pending'), row(2, 'agent', 'pending')]);
    expect([...s1].sort()).toEqual([1, 2]);
    const s2 = nextPendingIds(s1, [row(1, 'user', 'responded')]);
    expect([...s2]).toEqual([2]);
  });

  it('returns the same set instance for an empty batch (immutability fast-path)', () => {
    const prev = new Set([7]);
    expect(nextPendingIds(prev, [])).toBe(prev);
  });
});

describe('nextAgentPendingIds (#2774 tab indicator)', () => {
  it('adds ONLY agent-authored pending prompts', () => {
    const s = nextAgentPendingIds(new Set(), [
      row(1, 'user', 'pending'),   // user's own message awaiting the agent — not "needs input"
      row(2, 'agent', 'pending'),  // agent question awaiting the human — needs input
    ]);
    expect([...s]).toEqual([2]);
  });

  it('clears the id the moment the prompt is answered or expires', () => {
    const start = new Set([2, 3]);
    const afterAnswer = nextAgentPendingIds(start, [row(2, 'agent', 'responded')]);
    expect([...afterAnswer]).toEqual([3]);
    const afterExpiry = nextAgentPendingIds(afterAnswer, [row(3, 'agent', 'expired')]);
    expect(afterExpiry.size).toBe(0);
  });

  it('re-fetched still-pending rows keep the set stable (idempotent folds)', () => {
    const s1 = nextAgentPendingIds(new Set(), [row(2, 'agent', 'pending')]);
    const s2 = nextAgentPendingIds(s1, [row(2, 'agent', 'pending')]);
    expect([...s2]).toEqual([2]);
  });
});
