import { describe, it, expect } from 'vitest';
import {
  composeBrainstormSnapshot,
  isActiveBrainstorm,
  pickCurrentBrainstorm,
  TERMINAL_BRAINSTORM_STATUSES,
} from './brainstormData';
import type {
  VibeFlowBrainstormSession,
  BrainstormDetailResponse,
  VibeFlowBrainstormResponse,
} from '../../api/types';

function session(over: Partial<VibeFlowBrainstormSession> = {}): VibeFlowBrainstormSession {
  return {
    id: 1, organization_id: 'org', project_id: 28, document_id: 10, final_document_id: null,
    lead_persona_key: 'product_manager', feature_id: null, status: 'active', initiator_session_id: 's1',
    config: {
      max_rounds: 5, timeout_per_persona: 0, scope_guard_enabled: true, token_budget: 500000,
      tokens_used: 0, paused: false, current_topic_index: 0,
      participating_personas: ['architect', 'security_lead'],
    },
    round_number: 2, open_items: [], created_at: '2026-06-19T07:00:00Z', updated_at: '2026-06-19T07:10:00Z',
    ...over,
  };
}

function resp(over: Partial<VibeFlowBrainstormResponse> = {}): VibeFlowBrainstormResponse {
  return {
    id: 1, organization_id: 'org', brainstorm_id: 1, round_number: 1, persona_key: 'architect',
    session_id: 's2', response_type: 'challenge', content: 'x', target_section: null,
    resolution_status: 'open', resolved_in_round: null, target_persona_key: null,
    parent_response_id: null, created_at: '2026-06-19T07:05:00Z', ...over,
  };
}

describe('brainstormData — isActiveBrainstorm', () => {
  it('active/seeding/converging are active; done/cancelled are not', () => {
    expect(isActiveBrainstorm({ status: 'active' })).toBe(true);
    expect(isActiveBrainstorm({ status: 'seeding' })).toBe(true);
    expect(isActiveBrainstorm({ status: 'converging' })).toBe(true);
    expect(isActiveBrainstorm({ status: 'done' })).toBe(false);
    expect(isActiveBrainstorm({ status: 'cancelled' })).toBe(false);
  });
  it('TERMINAL set is exactly done + cancelled', () => {
    expect([...TERMINAL_BRAINSTORM_STATUSES].sort()).toEqual(['cancelled', 'done']);
  });
});

describe('brainstormData — pickCurrentBrainstorm', () => {
  it('prefers the active session even over a newer finished one', () => {
    const done = session({ id: 1, status: 'done', created_at: '2026-06-19T09:00:00Z' });
    const active = session({ id: 2, status: 'active', created_at: '2026-06-19T07:00:00Z' });
    expect(pickCurrentBrainstorm([done, active])?.id).toBe(2);
  });
  it('falls back to most-recent when none active', () => {
    const a = session({ id: 1, status: 'done', created_at: '2026-06-19T07:00:00Z' });
    const b = session({ id: 2, status: 'cancelled', created_at: '2026-06-19T09:00:00Z' });
    expect(pickCurrentBrainstorm([a, b])?.id).toBe(2);
  });
  it('returns undefined for an empty list', () => {
    expect(pickCurrentBrainstorm([])).toBeUndefined();
  });
});

describe('brainstormData — composeBrainstormSnapshot', () => {
  it('no detail → empty mode, carries activePersonas + history', () => {
    const snap = composeBrainstormSnapshot({
      serverUrl: 'https://x', activePersonas: [{ key: 'pm', sessionId: 's' }], history: [session()],
    });
    expect(snap.mode).toBe('empty');
    expect(snap.session).toBeUndefined();
    expect(snap.activePersonas).toHaveLength(1);
    expect(snap.history).toHaveLength(1);
  });

  it('active session → live mode; rounds merged with responses + sorted ascending', () => {
    const detail: BrainstormDetailResponse = {
      session: session({ status: 'active' }),
      rounds: [
        { id: 2, organization_id: 'org', brainstorm_id: 1, round_number: 2, scope_warnings: '', convergence_score: 0.6, created_at: 'b' },
        { id: 1, organization_id: 'org', brainstorm_id: 1, round_number: 1, scope_warnings: '', convergence_score: 0.3, created_at: 'a' },
      ],
      progress: { responded: { architect: 'challenge' }, pending: ['security_lead'], next_up: 'security_lead', elapsed_seconds: 600, response_count: 1, participant_count: 3 },
    };
    const snap = composeBrainstormSnapshot({
      serverUrl: 'https://x',
      detail,
      roundResponses: { 1: [resp({ round_number: 1 })], 2: [resp({ id: 2, round_number: 2, persona_key: 'security_lead' })] },
      documentMarkdown: '# Draft',
    });
    expect(snap.mode).toBe('live');
    expect(snap.rounds?.map(r => r.round_number)).toEqual([1, 2]);
    expect(snap.rounds?.[0].convergence_score).toBe(0.3);
    expect(snap.rounds?.[0].responses).toHaveLength(1);
    expect(snap.rounds?.[1].responses[0].persona_key).toBe('security_lead');
    expect(snap.progress?.next_up).toBe('security_lead');
    expect(snap.documentMarkdown).toBe('# Draft');
  });

  it('done session → closed mode', () => {
    const snap = composeBrainstormSnapshot({ serverUrl: 'https://x', detail: { session: session({ status: 'done' }) } });
    expect(snap.mode).toBe('closed');
    expect(snap.session?.status).toBe('done');
  });

  it('round with no captured responses → empty array, never undefined', () => {
    const detail: BrainstormDetailResponse = {
      session: session(),
      rounds: [{ id: 1, organization_id: 'org', brainstorm_id: 1, round_number: 1, scope_warnings: '', convergence_score: 0, created_at: 'a' }],
    };
    const snap = composeBrainstormSnapshot({ serverUrl: 'https://x', detail });
    expect(snap.rounds?.[0].responses).toEqual([]);
  });
});
