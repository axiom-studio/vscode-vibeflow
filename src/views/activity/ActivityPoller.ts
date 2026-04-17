import type { VibeFlowClient } from '../../api/client.js';
import type { ActivityEntry } from '../../api/types.js';
import type { ActivityFeedProvider } from './ActivityFeedProvider.js';
import type { PromptNotifier } from '../../notifications/PromptNotifier.js';

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
  if (content.startsWith('📝')) { return 'action'; }
  if (content.startsWith('✅')) { return 'completion'; }
  if (content.startsWith('❌')) { return 'error'; }
  if (content.startsWith('❓')) { return 'prompt'; }
  return 'action';
}

/**
 * Polls VibeFlow API for session activity, work item logs, and status changes.
 * Converts them into ActivityEntry objects and pushes to the feed.
 */
export class ActivityPoller {
  private timer: ReturnType<typeof setInterval> | undefined;
  private seenEventIds = new Set<string>();
  private entryCounter = 0;
  private lastLogLengths = new Map<string, number>(); // track log growth per work item

  constructor(
    private readonly client: VibeFlowClient,
    private readonly feedProvider: ActivityFeedProvider,
    private readonly _promptNotifier: PromptNotifier,
    private readonly projectId: number,
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
      // Track A: session-level activity (last_message from heartbeats)
      await this.pollSessions();
      // Track B: work item log-level activity (implementing todos/issues)
      await this.pollWorkItemLogs();
    } catch {
      // Silent failure — retry next cycle
    }
  }

  /**
   * Track A: fetch active sessions and create events from last_message.
   * This gives us coarse-grained activity (1 event per heartbeat cycle).
   */
  private async pollSessions(): Promise<void> {
    try {
      const sessions = await this.client.listSessions(this.projectId);

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
          personaName: session.persona_name ?? session.persona_key,
          messageType: detectMessageType(session.last_message),
          content: this.truncate(session.last_message),
        });
      }
    } catch {
      // Silent
    }
  }

  /**
   * Track B: fetch logs for active work items (implementing todos/issues).
   * This gives fine-grained activity (individual log entries).
   */
  private async pollWorkItemLogs(): Promise<void> {
    try {
      // Get implementing issues
      const issues = await this.client.listIssues(this.projectId);
      const activeIssues = issues.filter(i => i.status === 'implementing');

      for (const issue of activeIssues) {
        await this.fetchAndPushLogs('issue', issue.id, issue.claimedBy);
      }

      // Get implementing todos from active features
      const features = await this.client.listFeatures(this.projectId);
      const activeFeatures = features.filter(f =>
        f.status === 'implementing' || f.status === 'ready_to_implement',
      );

      for (const feature of activeFeatures) {
        try {
          const todos = await this.client.listTodos(feature.id);
          const activeTodos = todos.filter(t => t.status === 'implementing');
          for (const todo of activeTodos) {
            await this.fetchAndPushLogs('todo', todo.id, todo.claimedBy);
          }
        } catch {
          // Skip this feature
        }
      }
    } catch {
      // Silent
    }
  }

  private async fetchAndPushLogs(
    type: 'todo' | 'issue',
    id: number,
    _claimedBy?: string,
  ): Promise<void> {
    try {
      const logs = await this.client.getWorkItemLogs(type, id);
      const key = `${type}-${id}`;
      const lastLen = this.lastLogLengths.get(key) ?? 0;

      // Only process new log entries (logs we haven't seen before)
      const newLogs = logs.slice(lastLen);
      this.lastLogLengths.set(key, logs.length);

      for (const log of newLogs) {
        const eventId = `log-${type}-${id}-${log.created_at}-${this.entryCounter}`;
        if (this.seenEventIds.has(eventId)) { continue; }
        this.seenEventIds.add(eventId);

        const logType = log.message_type ?? '';
        const messageType = LOG_TYPE_MAP[logType] ?? detectMessageType(log.content);

        this.feedProvider.pushEntry({
          id: eventId,
          timestamp: log.created_at,
          personaKey: 'developer', // Best effort — claimedBy is session_id, not persona_key
          personaName: 'Agent',
          messageType,
          content: this.truncate(log.content),
          metadata: {
            workItemType: type,
            workItemId: id,
          },
        });
      }
    } catch {
      // Silent — individual work item log fetch failure
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
