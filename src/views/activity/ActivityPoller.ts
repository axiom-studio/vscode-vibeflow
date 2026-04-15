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
  private seenEventIds = new Set<string>();
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
      // Fetch active sessions — only show activity from live sessions
      const sessions = await this.client.listSessions(this.projectId);

      // For each active session with a last_message, create an activity event
      // from the session's latest state. Log-level streaming will be re-added
      // once we have a stable work-item-id field on the session response.
      for (const session of sessions) {
        if (!session.active || session.stale) { continue; }
        if (!session.last_message || !session.last_message_at) { continue; }

        const eventId = `session-${session.session_id}-${session.last_message_at}`;
        if (this.seenEventIds.has(eventId)) { continue; }
        this.seenEventIds.add(eventId);

        events.push({
          type: 'status_change',
          id: eventId,
          timestamp: session.last_message_at,
          personaKey: session.persona_key,
          personaName: session.persona_name ?? session.persona_key,
          content: session.last_message,
        });
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
