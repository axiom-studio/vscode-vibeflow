import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { VibeFlowClient } from '../../api/client.js';
import type { ActivityEntry, VibeFlowSession } from '../../api/types.js';
import type { ActivityFeedProvider } from './ActivityFeedProvider.js';
import type { PromptNotifier } from '../../notifications/PromptNotifier.js';
import type { AgentFileDecorationProvider, FileAction } from '../decorations/AgentFileDecorationProvider.js';
import { personaDisplayName } from '../../sessions/personas.js';

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
export class ActivityPoller {
  private timer: ReturnType<typeof setInterval> | undefined;
  private seenEventIds = new Set<string>();
  private entryCounter = 0;
  /** Per work item, the count of log entries we've already processed. */
  private lastLogLengths = new Map<string, number>();
  /** session_id → persona_key, refreshed each poll cycle. */
  private sessionPersonaMap = new Map<string, string>();

  constructor(
    private readonly client: VibeFlowClient,
    private readonly feedProvider: ActivityFeedProvider,
    private readonly promptNotifier: PromptNotifier,
    private readonly projectId: number,
    private readonly fileDecorations?: AgentFileDecorationProvider,
  ) {}

  start(): void {
    this.stop();
    this.timer = setInterval(() => this.poll(), 5000);
    this.poll();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async poll(): Promise<void> {
    try {
      // Track A: session-level activity (last_message from heartbeats). This
      // also refreshes our session_id → persona_key map for Tracks B and C.
      await this.pollSessions();
      // Track B: work item log-level activity (implementing todos/issues).
      await this.pollWorkItemLogs();
      // Track C: pending agent → user prompts (toasts + status bar badge).
      await this.pollPendingPrompts();
    } catch {
      // Silent failure — retry next cycle
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
   */
  private async pollSessions(): Promise<void> {
    let sessions: VibeFlowSession[] = [];
    try {
      sessions = await this.client.listSessions(this.projectId);
    } catch {
      // Silent — leave map stale, Track B will fall back gracefully.
      return;
    }

    // Refresh session_id → persona map.
    this.sessionPersonaMap.clear();
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
      this.seenEventIds.add(eventId);

      this.feedProvider.pushEntry({
        id: eventId,
        timestamp: session.last_message_at,
        personaKey: session.persona_key,
        personaName: session.persona_name ?? personaDisplayName(session.persona_key),
        messageType: detectMessageType(session.last_message),
        content: this.truncate(session.last_message),
      });
    }
  }

  /**
   * Track B: fetch logs for active work items. For each new log entry we
   * (1) push to the Activity Feed, and (2) extract any mentioned file paths
   * and tell the decoration provider which persona is currently touching
   * them.
   */
  private async pollWorkItemLogs(): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    try {
      // Implementing issues
      const issues = await this.client.listIssues(this.projectId);
      const activeIssues = issues.filter(i => i.status === 'implementing');
      for (const issue of activeIssues) {
        await this.fetchAndPushLogs('issue', issue.id, issue.claimedBy, workspaceRoot);
      }

      // Implementing todos under non-done features
      const features = await this.client.listFeatures(this.projectId);
      const activeFeatures = features.filter(f =>
        f.status === 'implementing' || f.status === 'ready_to_implement',
      );
      for (const feature of activeFeatures) {
        try {
          const todos = await this.client.listTodos(feature.id);
          const activeTodos = todos.filter(t => t.status === 'implementing');
          for (const todo of activeTodos) {
            await this.fetchAndPushLogs('todo', todo.id, todo.claimedBy, workspaceRoot);
          }
        } catch {
          // Skip this feature — next cycle may succeed.
        }
      }
    } catch {
      // Silent
    }
  }

  private async fetchAndPushLogs(
    type: 'todo' | 'issue',
    id: number,
    claimedBy: string | undefined,
    workspaceRoot: string | undefined,
  ): Promise<void> {
    let logs: { id?: number; content: string; message_type?: string; created_at: string }[];
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

    // Resolve the persona that owns this work item. claimedBy is a session_id;
    // map it via the snapshot we built in pollSessions.
    const personaKey = (claimedBy && this.sessionPersonaMap.get(claimedBy)) || 'developer';
    const personaName = personaDisplayName(personaKey);

    // Aggregate file mentions across this batch so we issue one
    // decoration event for the whole work item rather than per log line.
    const activeFiles: Array<{ filePath: string; persona: string; action: FileAction }> = [];

    for (const log of newLogs) {
      const eventId = `log-${type}-${id}-${log.created_at}-${this.entryCounter++}`;
      if (this.seenEventIds.has(eventId)) { continue; }
      this.seenEventIds.add(eventId);

      const logType = log.message_type ?? '';
      const messageType = LOG_TYPE_MAP[logType] ?? detectMessageType(log.content);

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

  private truncate(content: string): string {
    const lines = content.split('\n').filter(l => !l.startsWith('#') && l.trim());
    const firstLine = lines[0] ?? content;
    // Strip markdown bold/italic markers for clean display
    const clean = firstLine.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1');
    return clean.length > 200 ? clean.slice(0, 197) + '...' : clean;
  }
}
