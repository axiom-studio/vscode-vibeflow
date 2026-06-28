import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { VibeFlowClient } from '../../api/client.js';
import type { ActivityEntry, VibeFlowIssue, VibeFlowSession, VibeFlowTodo } from '../../api/types.js';
import type { ActivityFeedProvider } from './ActivityFeedProvider.js';
import type { FeedStateController } from './feedStateController.js';
import type { PromptNotifier } from '../../notifications/PromptNotifier.js';
import type { AgentFileDecorationProvider, FileAction } from '../decorations/AgentFileDecorationProvider.js';
import { personaDisplayName } from '../../sessions/personas.js';
import type { ProgressIndicatorPayload } from '../../core/webviewMessages.js';
import type { PollingCoordinator, Disposer } from '../../core/PollingCoordinator.js';

const LOG_TYPE_MAP: Record<string, ActivityEntry['messageType']> = {
  thinking: 'thinking',
  action: 'action',
  observation: 'observation',
  diff: 'action',
  test_result: 'observation',
  summary: 'summary',
};

/**
 * Detect message type from content emoji prefixes.
 * Matches the emoji convention from CLAUDE.md agent instructions.
 */
function detectMessageType(content: string): ActivityEntry['messageType'] {
  if (content.startsWith('🤔')) { return 'thinking'; }
  if (content.startsWith('⚡')) { return 'action'; }
  if (content.startsWith('👁')) { return 'observation'; }
  if (content.startsWith('📋')) { return 'summary'; }
  if (content.startsWith('📝')) { return 'commit'; }
  if (content.startsWith('✅')) { return 'completion'; }
  if (content.startsWith('❌')) { return 'error'; }
  if (content.startsWith('❓')) { return 'prompt'; }
  return 'action';
}

/**
 * Verbs that introduce a file path in agent log content, grouped by the
 * `FileAction` they imply for the file-decoration tooltip. Group 1 of each
 * regex is the verb itself (used to choose the action), group 2 is the
 * segment AFTER the verb (where path tokens live).
 *
 * We deliberately scope path extraction to these verbs (rather than scanning
 * every token) because the cost of false-positive decorations is high and
 * the cost of missing some is low — the next log poll catches the next
 * mention.
 */
const FILE_VERB_PATTERN = /(Modif(?:ied|ying|y)|Creat(?:ed|ing|e)|Read(?:ing)?|Edit(?:ed|ing)?|Wr(?:ote|iting|ite)|Updat(?:ed|ing|e)|Delet(?:ed|ing|e))\s*[:]?\s+([^\n]+?)(?:\s+\(|\s+—|\s+at\s+line\s|$)/gi;

/** Map a matched verb prefix to the `FileAction` it represents. */
function verbToAction(verb: string): FileAction {
  const v = verb.toLowerCase();
  if (v.startsWith('read')) { return 'read'; }
  if (v.startsWith('wr') || v.startsWith('creat')) { return 'write'; }
  if (v.startsWith('delet')) { return 'delete'; }
  return 'edit'; // modif/edit/updat
}

/**
 * Extract candidate file path tokens from a log line, paired with the
 * action verb they were captured under. The verb regex captures the segment
 * AFTER the verb up to a `(` (line/diff stat) or `—` (free-form prose) or
 * end-of-line. We then split on commas/whitespace and keep tokens that look
 * like paths.
 */
function extractFilePaths(content: string): Array<{ path: string; action: FileAction }> {
  const out: Array<{ path: string; action: FileAction }> = [];
  let match: RegExpExecArray | null;
  FILE_VERB_PATTERN.lastIndex = 0;
  while ((match = FILE_VERB_PATTERN.exec(content)) !== null) {
    const action = verbToAction(match[1]);
    const segment = match[2];
    for (const raw of segment.split(/[,\s]+/)) {
      const cleaned = raw.replace(/^[`'"]+|[`'".,;:)]+$/g, '').trim();
      if (looksLikePath(cleaned)) { out.push({ path: cleaned, action }); }
    }
  }
  return out;
}

/**
 * A token is "path-like" if it has a slash (multi-segment path) OR a
 * recognizable file-extension suffix. Reject leading dashes/slashes
 * (would be flags or absolute paths from the log — we only resolve
 * workspace-relative).
 */
function looksLikePath(s: string): boolean {
  if (!s || s.length < 2 || s.length > 240) { return false; }
  if (s.startsWith('-') || s.startsWith('/')) { return false; }
  if (/\s/.test(s)) { return false; }
  if (s.includes('/')) { return true; }
  return /\.[a-z0-9]{1,8}$/i.test(s);
}

/**
 * Resolve a workspace-relative path token to an absolute fsPath. Returns
 * undefined if the path doesn't exist on disk (avoids decorating phantom
 * files mentioned in prose, like `auth.go` referenced abstractly).
 */
function resolveWorkspacePath(workspaceRoot: string, candidate: string): string | undefined {
  const normalized = path.normalize(candidate);
  // Prevent path traversal — refuse anything that resolves outside the workspace.
  if (normalized.startsWith('..')) { return undefined; }
  const abs = path.isAbsolute(normalized)
    ? normalized
    : path.join(workspaceRoot, normalized);
  // Must stay inside the workspace.
  if (!abs.startsWith(workspaceRoot + path.sep) && abs !== workspaceRoot) { return undefined; }
  try {
    if (!fs.existsSync(abs)) { return undefined; }
    return abs;
  } catch {
    return undefined;
  }
}

/**
 * Polls VibeFlow API for session activity, work item logs, and status changes.
 * Converts them into ActivityEntry objects and pushes to the feed; in
 * parallel, drives the file-decoration provider so the Explorer shows which
 * agent is touching which file.
 */
/**
 * Hard cap on the `seenEventIds` set. Each entry is ~60 chars so 5000
 * is ~300 KB of bookkeeping — well below anything that'd matter, but
 * past which growth was effectively unbounded across long sessions.
 * FIFO eviction (Set preserves insertion order in JS, so we drop from
 * the front when over cap).
 */
const MAX_SEEN_EVENT_IDS = 5000;

export class ActivityPoller {
  private pollSub: Disposer | undefined;
  /**
   * Dedupe set for session-level events (one entry per session per
   * `last_message_at` value). Capped via `recordSeenEvent`. Per-log
   * dedup happens via `lastLogLengths` below — this set is NOT the
   * source of truth there.
   */
  private seenEventIds = new Set<string>();
  private entryCounter = 0;
  /** Per work item, the count of log entries we've already processed. */
  private lastLogLengths = new Map<string, number>();
  /**
   * session_id → persona_key. Accumulated across poll cycles — once we know
   * a session's persona, that mapping is immutable, so we keep it even after
   * the session ends. Otherwise log entries written by an ended session
   * would lose their persona attribution mid-task.
   */
  private sessionPersonaMap = new Map<string, string>();

  constructor(
    private readonly client: VibeFlowClient,
    private readonly feedProvider: ActivityFeedProvider,
    private readonly promptNotifier: PromptNotifier,
    private readonly projectId: number,
    private readonly coordinator: PollingCoordinator,
    private readonly fileDecorations?: AgentFileDecorationProvider,
    /**
     * Optional health observer — receives pollSucceeded/pollFailed signals
     * so the empty-state UI can flip to "Connection lost. Retrying…" after
     * a sustained outage. Optional so existing call sites don't break;
     * extension.ts wires it in `connectToProject`.
     */
    private readonly feedStateController?: FeedStateController,
  ) {}

  start(): void {
    this.stop();
    this.pollSub = this.coordinator.subscribe(5000, () => this.poll());
    this.poll();
  }

  stop(): void {
    this.pollSub?.dispose();
    this.pollSub = undefined;
  }

  /**
   * Add an event id to the dedupe set with FIFO eviction at the cap.
   * JS Set preserves insertion order, so the first iterator value is
   * the oldest. We drop a batch at a time (20% headroom) rather than
   * one-at-a-time to amortize the iterator walk.
   */
  private recordSeenEvent(id: string): void {
    this.seenEventIds.add(id);
    if (this.seenEventIds.size <= MAX_SEEN_EVENT_IDS) { return; }
    const dropCount = Math.max(1, Math.floor(MAX_SEEN_EVENT_IDS * 0.2));
    const iter = this.seenEventIds.values();
    for (let i = 0; i < dropCount; i++) {
      const next = iter.next();
      if (next.done) { break; }
      this.seenEventIds.delete(next.value);
    }
  }

  private async poll(): Promise<void> {
    // pollSessions returns whether listSessions (the primary endpoint) was
    // reachable this cycle. That's the signal the FeedStateController needs:
    // if the API is up the feed is "connected", if it's been down N cycles
    // we flip to "Connection lost. Retrying…". Inner per-track catches keep
    // the existing partial-data resilience.
    let healthy = false;
    try {
      healthy = await this.pollSessions();
      await this.pollWorkItemLogs();
      await this.pollPendingPrompts();
    } catch {
      // Silent failure — retry next cycle
    }

    if (healthy) {
      this.feedStateController?.pollSucceeded();
    } else {
      this.feedStateController?.pollFailed();
    }
  }

  /**
   * Track C: fetch agent-initiated prompts that need a human response and
   * hand them to PromptNotifier. Persona name is resolved via the session
   * map populated in Track A — so the toast says "Architect asks: ..."
   * instead of just an opaque session id.
   */
  private async pollPendingPrompts(): Promise<void> {
    const prompts = await this.client.listPendingPrompts(this.projectId);
    const hydrated = prompts.map(p => {
      const personaKey = this.sessionPersonaMap.get(p.session_id) ?? 'developer';
      return {
        id: p.prompt_id,
        text: p.prompt_text,
        personaName: personaDisplayName(personaKey),
        createdAt: p.created_at,
        workItemType: p.work_item_type,
        workItemId: p.work_item_id,
      };
    });
    this.promptNotifier.handlePrompts(hydrated);
  }

  /**
   * Track A: fetch active sessions and create events from last_message.
   * Updates `sessionPersonaMap` as a side-effect (used by Track B).
   * Returns `true` when the API call succeeded (the signal used by the
   * cycle-level health tracker), `false` otherwise.
   */
  private async pollSessions(): Promise<boolean> {
    let sessions: VibeFlowSession[] = [];
    try {
      sessions = await this.client.listSessions(this.projectId);
    } catch {
      // Silent — leave map stale, Track B will fall back gracefully.
      return false;
    }

    // Merge into the session_id → persona map. Don't clear: a session that
    // dropped off the active list still owns logs it already wrote, and the
    // mapping is immutable for the lifetime of that session.
    for (const s of sessions) {
      if (s.session_id && s.persona_key) {
        this.sessionPersonaMap.set(s.session_id, s.persona_key);
      }
    }

    for (const session of sessions) {
      if (!session.active || session.stale) { continue; }
      if (!session.last_message || !session.last_message_at) { continue; }

      const eventId = `session-${session.session_id}-${session.last_message_at}`;
      if (this.seenEventIds.has(eventId)) { continue; }
      this.recordSeenEvent(eventId);

      this.feedProvider.pushEntry({
        id: eventId,
        timestamp: session.last_message_at,
        personaKey: session.persona_key,
        personaName: session.persona_name ?? personaDisplayName(session.persona_key),
        messageType: detectMessageType(session.last_message),
        content: this.truncate(session.last_message),
      });
    }
    return true;
  }

  /**
   * Track B: fetch logs for active work items. For each new log entry we
   * (1) push to the Activity Feed, and (2) extract any mentioned file paths
   * and tell the decoration provider which persona is currently touching
   * them.
   */
  private async pollWorkItemLogs(): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    // Track the freshest structured-progress snapshot across all active
    // work items this cycle. We push the newest one (by last_progress_at)
    // so the pinned indicator follows whichever agent moved most recently.
    let freshestProgress: ProgressIndicatorPayload | undefined;
    const considerProgress = (
      type: 'todo' | 'issue',
      item: VibeFlowTodo | VibeFlowIssue,
    ): void => {
      if (!item.progress?.last_progress_at) { return; }
      if (
        freshestProgress
        && freshestProgress.progress.last_progress_at >= item.progress.last_progress_at
      ) {
        return;
      }
      const personaKey =
        (item.claimed_by && this.sessionPersonaMap.get(item.claimed_by)) || 'developer';
      freshestProgress = {
        personaName: personaDisplayName(personaKey),
        personaKey,
        workItemType: type,
        workItemId: item.id,
        workItemTitle: item.title,
        progress: item.progress,
      };
    };

    try {
      // Implementing issues
      const issues = await this.client.listIssues(this.projectId);
      const activeIssues = issues.filter(i => i.status === 'implementing');
      for (const issue of activeIssues) {
        considerProgress('issue', issue);
        await this.fetchAndPushLogs('issue', issue.id, issue.claimed_by, workspaceRoot);
      }

      // Implementing todos under non-done features
      const features = await this.client.listFeatures(this.projectId);
      const activeFeatures = features.filter(f =>
        f.status === 'implementing' || f.status === 'ready_to_implement',
      );
      for (const feature of activeFeatures) {
        try {
          // Server-side filter so a project with 50 features doesn't
          // round-trip 50× the entire todo list every poll cycle.
          const activeTodos = await this.client.listTodos(feature.id, { status: 'implementing' });
          for (const todo of activeTodos) {
            considerProgress('todo', todo);
            await this.fetchAndPushLogs('todo', todo.id, todo.claimed_by, workspaceRoot);
          }
        } catch {
          // Skip this feature — next cycle may succeed.
        }
      }
    } catch {
      // Silent
    }

    // Push (or clear) the indicator. Sending null when no active item has
    // progress lets the UI hide the widget rather than render stale state.
    this.feedProvider.pushProgress(freshestProgress ?? null);
  }

  private async fetchAndPushLogs(
    type: 'todo' | 'issue',
    id: number,
    claimedBy: string | undefined,
    workspaceRoot: string | undefined,
  ): Promise<void> {
    let logs: { id?: number; content: string; message_type?: string; created_at: string; source?: string }[];
    try {
      logs = await this.client.getWorkItemLogs(type, id);
    } catch {
      return;
    }

    const key = `${type}-${id}`;
    const lastLen = this.lastLogLengths.get(key) ?? 0;
    const newLogs = logs.slice(lastLen);
    this.lastLogLengths.set(key, logs.length);

    if (newLogs.length === 0) { return; }

    // The work item's claimed_by is a final fallback. Each log entry carries
    // its own session_id (or pseudo-source) so a single work item can show
    // entries from multiple personas correctly — e.g. an architect plans,
    // hands off to a developer, then security_review rejects.
    const fallbackPersona = (claimedBy && this.sessionPersonaMap.get(claimedBy)) || 'developer';

    // Aggregate file mentions across this batch so we issue one
    // decoration event for the whole work item rather than per log line.
    const activeFiles: Array<{ filePath: string; persona: string; action: FileAction }> = [];

    for (const log of newLogs) {
      // Per-work-item dedup happens via `lastLogLengths` above (we
      // only slice the suffix beyond the last processed length), so
      // the `seenEventIds` check used to live here was strictly
      // redundant — every id is fresh because `entryCounter++`. We
      // keep entryCounter so each entry has a stable unique key for
      // React's reconciler, but no Set membership probe.
      const eventId = `log-${type}-${id}-${log.created_at}-${this.entryCounter++}`;

      const logType = log.message_type ?? '';
      const messageType = LOG_TYPE_MAP[logType] ?? detectMessageType(log.content);
      const personaKey = this.resolvePersonaForLog(log.source, fallbackPersona);
      const personaName = personaDisplayName(personaKey);

      this.feedProvider.pushEntry({
        id: eventId,
        timestamp: log.created_at,
        personaKey,
        personaName,
        messageType,
        content: this.truncate(log.content),
        metadata: { workItemType: type, workItemId: id },
      });

      // File-decoration extraction. We accept paths from action/observation/
      // commit log lines — the verbs ("Modified", "Reading", etc.) are the
      // gating signal regardless of the message_type field.
      if (workspaceRoot && this.fileDecorations) {
        const candidates = extractFilePaths(log.content);
        for (const { path: candidate, action } of candidates) {
          const abs = resolveWorkspacePath(workspaceRoot, candidate);
          if (!abs) { continue; }
          if (messageType === 'commit' || action === 'delete') {
            // Commit log lines and explicit deletions both terminate the
            // active state — they're not "in progress" anymore.
            this.fileDecorations.markCommitted(abs, personaKey);
          } else {
            activeFiles.push({ filePath: abs, persona: personaKey, action });
          }
        }
      }
    }

    if (activeFiles.length > 0 && this.fileDecorations) {
      this.fileDecorations.markActiveBatch(activeFiles);
    }
  }

  /**
   * Map a log entry's source field to a persona_key.
   *
   * Source can be:
   *   - a session_id ("session-..."): look up via sessionPersonaMap
   *   - a pseudo-source token ("security_review"): map to the persona that
   *     emits it (axiomcloud only emits one such token today, for security
   *     rejections written by security_lead)
   *   - undefined: fall back to the work item's claimed_by persona
   */
  private resolvePersonaForLog(source: string | undefined, fallback: string): string {
    if (!source) { return fallback; }
    if (source.startsWith('session-')) {
      return this.sessionPersonaMap.get(source) ?? fallback;
    }
    if (source === 'security_review') { return 'security_lead'; }
    return fallback;
  }

  private truncate(content: string): string {
    const lines = content.split('\n').filter(l => !l.startsWith('#') && l.trim());
    const firstLine = lines[0] ?? content;
    // Strip markdown bold/italic markers for clean display
    const clean = firstLine.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1');
    return clean.length > 200 ? clean.slice(0, 197) + '...' : clean;
  }
}
