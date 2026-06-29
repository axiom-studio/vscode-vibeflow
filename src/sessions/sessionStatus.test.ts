import { describe, it, expect } from 'vitest';
import {
  deriveSessionStatus,
  isActiveSession,
  isLiveStatus,
  type SessionStatus,
} from './sessionStatus.js';
import { buildTmuxName } from './tmuxState.js';
import type { VibeFlowSession } from '../api/types.js';

function session(over: Partial<VibeFlowSession>): VibeFlowSession {
  return {
    id: 1,
    session_id: 'abc',
    project_id: 1,
    working_directory: '',
    git_branch: 'main',
    agent_type: 'claude',
    agent_model: '',
    persona_key: 'developer',
    created_at: '',
    active: true,
    ...over,
  } as VibeFlowSession;
}

describe('deriveSessionStatus', () => {
  it('without a tmux probe: backend-only 3-state derivation', () => {
    expect(deriveSessionStatus(session({ active: true, stale: false }))).toBe('active');
    expect(deriveSessionStatus(session({ active: true, stale: true }))).toBe('stale');
    expect(deriveSessionStatus(session({ active: false }))).toBe('inactive');
  });

  it('with a tmux probe: cross-checks pane liveness against the backend', () => {
    const s = session({ agent_type: 'claude', session_id: 'abc' });
    const alive = new Set([buildTmuxName('claude', 'abc')]);
    const dead = new Set<string>();

    expect(deriveSessionStatus({ ...s, active: true, stale: false }, alive)).toBe('active');
    expect(deriveSessionStatus({ ...s, active: true, stale: true }, alive)).toBe('stale');
    expect(deriveSessionStatus({ ...s, active: false }, alive)).toBe('stalled'); // pane up, backend gone
    expect(deriveSessionStatus({ ...s, active: true }, dead)).toBe('ghost');      // pane dead, backend up
    expect(deriveSessionStatus({ ...s, active: false }, dead)).toBe('inactive');  // both dead
  });
});

describe('isActiveSession', () => {
  it('is active && !stale', () => {
    expect(isActiveSession(session({ active: true, stale: false }))).toBe(true);
    expect(isActiveSession(session({ active: true, stale: true }))).toBe(false);
    expect(isActiveSession(session({ active: false }))).toBe(false);
  });
});

describe('isLiveStatus', () => {
  it('counts active/stale/stalled as live, not inactive/ghost', () => {
    expect((['active', 'stale', 'stalled'] as SessionStatus[]).every(isLiveStatus)).toBe(true);
    expect((['inactive', 'ghost'] as SessionStatus[]).some(isLiveStatus)).toBe(false);
  });
});
