import type { VibeFlowClient } from '../../api/client.js';
import type { ActivityEntry } from '../../api/types.js';
import type { ActivityFeedProvider } from './ActivityFeedProvider.js';
import type { PromptNotifier } from '../../notifications/PromptNotifier.js';

interface SessionEvent {
  type: 'status_change' | 'commit' | 'prompt';
  id: string;
  timestamp: string;
  personaKey: string;
  personaName: string;
  content: string;
  metadata?: Record<string, unknown>;
}

const LOG_TYPE_MAP: Record<string, ActivityEntry['messageType']> = {
  thinking: 'thinking',
  action: 'action',
  observation: 'observation',
  diff: 'action',
  test_result: 'observation',
  summary: 'summary',
};

/**
 * Polls VibeFlow API for session logs, status changes, and prompts.
 * Converts them into ActivityEntry objects and pushes to the feed.
 */
export class ActivityPoller {
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastSeenLogId = 0;
  private lastSeenEventId = '';
  private entryCounter = 0;

  constructor(
    private readonly client: VibeFlowClient,
    private readonly feedProvider: ActivityFeedProvider,
    private readonly promptNotifier: PromptNotifier,
    private readonly projectId: number,
  ) {}

  start(): void {
    this.stop();
    // Active polling: 5s for real-time feel
    this.timer = setInterval(() => this.poll(), 5000);
    // Initial poll immediately
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
      const events = await this.fetchEvents();
      if (events.length > 0) {
        const entries = events.map(e => this.toActivityEntry(e));
        for (const entry of entries) {
          this.feedProvider.pushEntry(entry);
        }
      }
    } catch {
      // Silent failure — will retry next cycle
    }
  }

  private async fetchEvents(): Promise<SessionEvent[]> {
    const events: SessionEvent[] = [];

    try {
      // Fetch active sessions to get their logs
      const sessions = await this.client.listSessions(this.projectId);

      for (const session of sessions) {
        if (session.status !== 'active' && session.status !== 'idle') {
          continue;
        }

        // Fetch logs for current work item if any
        if (session.currentWorkItem) {
          try {
            const logs = await this.client.getWorkItemLogs(
              session.currentWorkItem.type,
              session.currentWorkItem.id,
            );

            for (const log of logs) {
              const logId = log.id ?? 0;
              if (logId > this.lastSeenLogId) {
                this.lastSeenLogId = logId;
                events.push({
                  type: 'status_change',
                  id: `log-${logId}`,
                  timestamp: log.created_at,
                  personaKey: session.personaKey,
                  personaName: session.personaName ?? session.personaKey,
                  content: log.content,
                  metadata: { messageType: log.message_type },
                });
              }
            }
          } catch {
            // Individual log fetch failure — skip this session
          }
        }
      }
    } catch {
      // Session list failure — skip this cycle
    }

    return events;
  }

  private toActivityEntry(event: SessionEvent): ActivityEntry {
    const logType = (event.metadata?.messageType as string) ?? '';
    const messageType = LOG_TYPE_MAP[logType] ?? 'action';

    return {
      id: event.id || `poll-${++this.entryCounter}`,
      timestamp: event.timestamp,
      personaKey: event.personaKey,
      personaName: event.personaName,
      messageType,
      content: this.truncateContent(event.content),
      metadata: event.metadata,
    };
  }

  private truncateContent(content: string): string {
    // Strip markdown headers and keep first meaningful line
    const lines = content.split('\n').filter(l => !l.startsWith('#') && l.trim());
    const firstLine = lines[0] ?? content;
    return firstLine.length > 200 ? firstLine.slice(0, 197) + '...' : firstLine;
  }
}
