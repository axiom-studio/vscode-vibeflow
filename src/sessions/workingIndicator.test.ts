import { describe, expect, it } from 'vitest';
import {
  DONE_COOLDOWN_MS,
  PRIMED_IDLE_GUARD_MS,
  SessionWorkingState,
  buildUIWebSocketUrl,
  classifyActivitySummary,
} from './workingIndicator.js';

const projectId = 28;
const sessionId = 'session-1';
const baseMs = Date.parse('2026-07-02T17:00:00.000Z');

function activity(summary: string, createdAt = '2026-07-02T17:00:00.000Z') {
  return {
    session_id: sessionId,
    project_id: projectId,
    summary,
    created_at: createdAt,
  };
}

describe('buildUIWebSocketUrl', () => {
  it('maps HTTPS origins to /ws/ui over WSS', () => {
    expect(buildUIWebSocketUrl('https://cloud.axiomstudio.ai')).toBe('wss://cloud.axiomstudio.ai/ws/ui');
  });

  it('preserves a configured path prefix and clears query/hash', () => {
    expect(buildUIWebSocketUrl('https://example.com/base/?x=1#frag')).toBe('wss://example.com/base/ws/ui');
  });

  it('maps localhost HTTP to WS for validated dev servers', () => {
    expect(buildUIWebSocketUrl('http://localhost:8080')).toBe('ws://localhost:8080/ws/ui');
  });
});

describe('classifyActivitySummary', () => {
  it('recognizes done and in-progress summaries', () => {
    expect(classifyActivitySummary('Marked done and committed')).toBe('done');
    expect(classifyActivitySummary('claimed todo #12 and started work')).toBe('in_progress');
    expect(classifyActivitySummary('read a file')).toBe('ordinary');
  });
});

describe('SessionWorkingState', () => {
  it('shows activity and preserves startedAt across refreshes', () => {
    const state = new SessionWorkingState();
    expect(state.recordActivity(activity('claimed todo #1'), projectId, baseMs)).toBe(true);
    const first = state.getSnapshot(projectId);
    expect(first.activeCount).toBe(1);
    expect(first.startedAtMs).toBe(baseMs);

    state.recordActivity(activity('working on todo #1', '2026-07-02T17:00:20.000Z'), projectId, baseMs + 21_000);
    const second = state.getSnapshot(projectId);
    expect(second.activeCount).toBe(1);
    expect(second.startedAtMs).toBe(first.startedAtMs);
    expect(second.lastActivityAtMs).toBe(Date.parse('2026-07-02T17:00:20.000Z'));
  });

  it('ignores idle events that race within the primed guard window', () => {
    const state = new SessionWorkingState();
    state.recordActivity(activity('claimed todo #1'), projectId, 10_000);

    state.recordIdle({ session_id: sessionId, project_id: projectId }, projectId, 10_000 + PRIMED_IDLE_GUARD_MS - 1);
    expect(state.getSnapshot(projectId).activeCount).toBe(1);

    state.recordIdle({ session_id: sessionId, project_id: projectId }, projectId, 10_000 + PRIMED_IDLE_GUARD_MS);
    expect(state.getSnapshot(projectId).activeCount).toBe(0);
  });

  it('suppresses ordinary activity during done cooldown but lets in-progress activity restart', () => {
    const state = new SessionWorkingState();
    state.recordActivity(activity('claimed todo #1'), projectId, 1_000);
    state.recordActivity(activity('completed todo #1'), projectId, 2_000);
    expect(state.getSnapshot(projectId).activeCount).toBe(0);

    state.recordActivity(activity('read a file'), projectId, 2_000 + DONE_COOLDOWN_MS - 1);
    expect(state.getSnapshot(projectId).activeCount).toBe(0);

    state.recordActivity(activity('implementing follow-up'), projectId, 2_000 + DONE_COOLDOWN_MS - 1);
    expect(state.getSnapshot(projectId).activeCount).toBe(1);
  });

  it('filters events for other projects', () => {
    const state = new SessionWorkingState();
    state.recordActivity({ ...activity('claimed todo #1'), project_id: 999 }, projectId, 1_000);
    expect(state.getSnapshot(projectId).activeCount).toBe(0);
  });

  it('marks previously visible sessions idle when fallback no longer sees active work', () => {
    const state = new SessionWorkingState();
    state.recordActivity(activity('claimed todo #1'), projectId, 1_000);
    expect(state.getSnapshot(projectId).activeCount).toBe(1);

    state.markProjectIdleExcept(projectId, new Set(), 1_000 + PRIMED_IDLE_GUARD_MS);
    expect(state.getSnapshot(projectId).activeCount).toBe(0);
  });
});
