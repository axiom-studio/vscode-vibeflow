export const PRIMED_IDLE_GUARD_MS = 5_000;
export const DONE_COOLDOWN_MS = 60_000;

export type WorkingIndicatorSource = 'websocket' | 'polling';
export type WorkingConnectionState = 'connecting' | 'connected' | 'fallback';

export interface WorkingIndicatorSessionSnapshot {
  sessionId: string;
  projectId: number;
  startedAtMs: number;
  lastActivityAtMs: number;
  summary?: string;
  workItemType?: 'todo' | 'issue';
  workItemId?: number;
}

export interface WorkingIndicatorSnapshot {
  activeCount: number;
  startedAtMs?: number;
  lastActivityAtMs?: number;
  sessions: WorkingIndicatorSessionSnapshot[];
}

export interface WorkingIndicatorUpdate {
  snapshot: WorkingIndicatorSnapshot;
  source: WorkingIndicatorSource;
  connection: WorkingConnectionState;
  detail?: string;
}

export interface WorkingActivityInput {
  session_id?: unknown;
  project_id?: unknown;
  summary?: unknown;
  message?: unknown;
  content?: unknown;
  current_action?: unknown;
  created_at?: unknown;
  message_type?: unknown;
  work_item_type?: unknown;
  work_item_id?: unknown;
}

export interface WorkingIdleInput {
  session_id?: unknown;
  project_id?: unknown;
}

export type ActivityClassification = 'done' | 'in_progress' | 'ordinary';

const DONE_ACTIVITY_RE = /(?:\u2705|(?:^|\b)(?:done|completed|complete|committed|finished|marked\s+done|status\s+(?:updated|changed|set|moved)\s+to\s+done)(?:\b|$))/i;
const IN_PROGRESS_ACTIVITY_RE = /(?:^|\b)(?:claimed|implementing|in[-\s]?progress|working|started|starting|progress|current action)(?:\b|$)/i;

interface SessionWorkingRecord {
  sessionId: string;
  projectId: number;
  visible: boolean;
  startedAtMs?: number;
  lastActivityAtMs: number;
  primedAtMs?: number;
  doneCooldownUntilMs?: number;
  summary?: string;
  workItemType?: 'todo' | 'issue';
  workItemId?: number;
}

interface NormalizedActivity {
  sessionId: string;
  projectId: number;
  summary: string;
  createdAtMs?: number;
  workItemType?: 'todo' | 'issue';
  workItemId?: number;
}

interface NormalizedIdle {
  sessionId: string;
  projectId: number;
}

export function buildUIWebSocketUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    throw new Error('serverUrl is empty');
  }

  const base = new URL(trimmed.endsWith('/') ? trimmed : `${trimmed}/`);
  if (base.protocol === 'https:') {
    base.protocol = 'wss:';
  } else if (base.protocol === 'http:') {
    base.protocol = 'ws:';
  } else {
    throw new Error(`serverUrl protocol ${base.protocol} does not support WebSocket`);
  }

  const prefix = base.pathname.replace(/\/+$/, '');
  base.pathname = `${prefix}/ws/ui`.replace(/\/{2,}/g, '/');
  base.search = '';
  base.hash = '';
  return base.toString();
}

export function classifyActivitySummary(summary: string): ActivityClassification {
  if (DONE_ACTIVITY_RE.test(summary)) {
    return 'done';
  }
  if (IN_PROGRESS_ACTIVITY_RE.test(summary)) {
    return 'in_progress';
  }
  return 'ordinary';
}

export class SessionWorkingState {
  private readonly sessions = new Map<string, SessionWorkingRecord>();

  applyEnvelope(envelope: unknown, watchedProjectId: number, nowMs = Date.now()): boolean {
    if (!isRecord(envelope)) { return false; }
    const type = typeof envelope.type === 'string' ? envelope.type : '';
    if (type === 'vibeflow_activity') {
      return this.recordActivity(envelope.data as WorkingActivityInput, watchedProjectId, nowMs);
    }
    if (type === 'vibeflow_session_idle') {
      return this.recordIdle(envelope.data as WorkingIdleInput, watchedProjectId, nowMs);
    }
    return false;
  }

  recordActivity(input: WorkingActivityInput, watchedProjectId: number, nowMs = Date.now()): boolean {
    const event = normalizeActivity(input);
    if (!event || event.projectId !== watchedProjectId) { return false; }

    const existing = this.sessions.get(event.sessionId);
    const record: SessionWorkingRecord = existing ?? {
      sessionId: event.sessionId,
      projectId: event.projectId,
      visible: false,
      lastActivityAtMs: nowMs,
    };
    record.projectId = event.projectId;
    record.lastActivityAtMs = event.createdAtMs ?? nowMs;
    record.summary = event.summary;
    record.workItemType = event.workItemType;
    record.workItemId = event.workItemId;

    const classification = classifyActivitySummary(event.summary);
    if (classification === 'done') {
      this.hideWithCooldown(record, nowMs);
      this.sessions.set(event.sessionId, record);
      return true;
    }

    if (classification === 'ordinary' && (record.doneCooldownUntilMs ?? 0) > nowMs) {
      record.visible = false;
      this.sessions.set(event.sessionId, record);
      return true;
    }

    record.doneCooldownUntilMs = undefined;
    record.primedAtMs = nowMs;
    if (!record.visible || record.startedAtMs === undefined) {
      record.startedAtMs = Math.min(event.createdAtMs ?? nowMs, nowMs);
    }
    record.visible = true;
    this.sessions.set(event.sessionId, record);
    return true;
  }

  recordIdle(input: WorkingIdleInput, watchedProjectId: number, nowMs = Date.now()): boolean {
    const event = normalizeIdle(input);
    if (!event || event.projectId !== watchedProjectId) { return false; }

    const existing = this.sessions.get(event.sessionId);
    const record: SessionWorkingRecord = existing ?? {
      sessionId: event.sessionId,
      projectId: event.projectId,
      visible: false,
      lastActivityAtMs: nowMs,
    };

    if (record.primedAtMs !== undefined && nowMs - record.primedAtMs < PRIMED_IDLE_GUARD_MS) {
      this.sessions.set(event.sessionId, record);
      return true;
    }

    this.hideWithCooldown(record, nowMs);
    this.sessions.set(event.sessionId, record);
    return true;
  }

  markProjectIdleExcept(projectId: number, activeSessionIds: Set<string>, nowMs = Date.now()): boolean {
    let changed = false;
    for (const record of this.sessions.values()) {
      if (record.projectId !== projectId || !record.visible || activeSessionIds.has(record.sessionId)) {
        continue;
      }
      if (record.primedAtMs !== undefined && nowMs - record.primedAtMs < PRIMED_IDLE_GUARD_MS) {
        continue;
      }
      this.hideWithCooldown(record, nowMs);
      changed = true;
    }
    return changed;
  }

  clearProject(projectId: number): void {
    for (const [sessionId, record] of this.sessions) {
      if (record.projectId === projectId) {
        this.sessions.delete(sessionId);
      }
    }
  }

  getSnapshot(projectId: number): WorkingIndicatorSnapshot {
    const sessions = [...this.sessions.values()]
      .filter((record): record is SessionWorkingRecord & { startedAtMs: number } =>
        record.projectId === projectId && record.visible && record.startedAtMs !== undefined,
      )
      .map(record => ({
        sessionId: record.sessionId,
        projectId: record.projectId,
        startedAtMs: record.startedAtMs,
        lastActivityAtMs: record.lastActivityAtMs,
        summary: record.summary,
        workItemType: record.workItemType,
        workItemId: record.workItemId,
      }))
      .sort((a, b) => a.startedAtMs - b.startedAtMs);

    return {
      activeCount: sessions.length,
      startedAtMs: sessions.length > 0 ? Math.min(...sessions.map(s => s.startedAtMs)) : undefined,
      lastActivityAtMs: sessions.length > 0 ? Math.max(...sessions.map(s => s.lastActivityAtMs)) : undefined,
      sessions,
    };
  }

  private hideWithCooldown(record: SessionWorkingRecord, nowMs: number): void {
    record.visible = false;
    record.startedAtMs = undefined;
    record.primedAtMs = undefined;
    record.doneCooldownUntilMs = nowMs + DONE_COOLDOWN_MS;
    record.lastActivityAtMs = nowMs;
  }
}

function normalizeActivity(input: WorkingActivityInput): NormalizedActivity | undefined {
  if (!isRecord(input)) { return undefined; }
  const sessionId = typeof input.session_id === 'string' && input.session_id.trim()
    ? input.session_id
    : undefined;
  const projectId = toNumber(input.project_id);
  if (!sessionId || projectId === undefined) { return undefined; }

  const summary = [
    input.summary,
    input.current_action,
    input.message,
    input.content,
    input.message_type,
  ]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .join(' ');

  const workItemType = input.work_item_type === 'todo' || input.work_item_type === 'issue'
    ? input.work_item_type
    : undefined;

  return {
    sessionId,
    projectId,
    summary: summary || 'activity',
    createdAtMs: typeof input.created_at === 'string' ? parseDateMs(input.created_at) : undefined,
    workItemType,
    workItemId: toNumber(input.work_item_id),
  };
}

function normalizeIdle(input: WorkingIdleInput): NormalizedIdle | undefined {
  if (!isRecord(input)) { return undefined; }
  const sessionId = typeof input.session_id === 'string' && input.session_id.trim()
    ? input.session_id
    : undefined;
  const projectId = toNumber(input.project_id);
  if (!sessionId || projectId === undefined) { return undefined; }
  return { sessionId, projectId };
}

function parseDateMs(value: string): number | undefined {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
