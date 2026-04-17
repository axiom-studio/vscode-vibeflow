import type { ActivityEntry } from '../types';
import { PERSONA_COLORS, MESSAGE_ICONS } from '../types';

interface ActivityItemProps {
  entry: ActivityEntry;
  onRespond?: (promptId: string) => void;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Parse work item reference from content or metadata.
 * Looks for patterns like "Todo #1234", "Issue #567", or metadata.workItemId.
 */
function parseWorkItemRef(entry: ActivityEntry): { type: string; id: string; title?: string } | null {
  // Check metadata first
  if (entry.metadata?.workItemType && entry.metadata?.workItemId) {
    return {
      type: entry.metadata.workItemType as string,
      id: String(entry.metadata.workItemId),
      title: entry.metadata.workItemTitle as string | undefined,
    };
  }

  // Parse from personaName if it's "todo #123" format (from poller Track B)
  const nameMatch = entry.personaName.match(/^(todo|issue)\s*#(\d+)$/i);
  if (nameMatch) {
    return { type: nameMatch[1].toLowerCase(), id: nameMatch[2] };
  }

  // Parse from content
  const contentMatch = entry.content.match(/(?:Todo|Issue|Feature)\s*#(\d+)/i);
  if (contentMatch) {
    const typeMatch = entry.content.match(/(Todo|Issue|Feature)/i);
    return { type: (typeMatch?.[1] ?? 'todo').toLowerCase(), id: contentMatch[1] };
  }

  return null;
}

/**
 * Detect status transition from content.
 * Looks for patterns like "moved to implementing", "→ done", "status: planning → ready"
 */
function parseStatusTransition(content: string): { from?: string; to: string } | null {
  const arrowMatch = content.match(/→\s*(\w+)/);
  if (arrowMatch) { return { to: arrowMatch[1] }; }

  const movedMatch = content.match(/moved to\s+(\w+)/i);
  if (movedMatch) { return { to: movedMatch[1] }; }

  const claimedMatch = content.match(/claimed.*(?:planning|implementing)/i);
  if (claimedMatch) { return { to: 'planning' }; }

  const completedMatch = content.match(/completed|done|finished/i);
  if (completedMatch) { return { to: 'done' }; }

  return null;
}

const STATUS_COLORS: Record<string, string> = {
  planning: '#9cdcfe',
  ready_to_implement: '#4fc1ff',
  implementing: '#dcdcaa',
  in_review: '#c586c0',
  done: '#4ec86e',
};

export function ActivityItem({ entry, onRespond }: ActivityItemProps) {
  const personaColor = PERSONA_COLORS[entry.personaKey] ?? '#cccccc';
  const icon = MESSAGE_ICONS[entry.messageType];
  const workItem = parseWorkItemRef(entry);
  const transition = parseStatusTransition(entry.content);

  // Use real persona name, not "todo #123" from poller
  const displayName = entry.personaName.match(/^(todo|issue)\s*#/i)
    ? entry.personaKey.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    : entry.personaName;

  return (
    <div style={{
      display: 'flex',
      gap: 8,
      padding: '6px 10px',
      fontSize: 12,
      borderBottom: '1px solid rgba(127,127,127,0.08)',
    }}>
      {/* Timestamp */}
      <span style={{
        flexShrink: 0,
        fontSize: 10,
        lineHeight: '18px',
        opacity: 0.45,
        fontVariantNumeric: 'tabular-nums',
        width: 38,
      }}>
        {formatTime(entry.timestamp)}
      </span>

      {/* Persona dot */}
      <span
        style={{
          flexShrink: 0,
          marginTop: 5,
          width: 7,
          height: 7,
          borderRadius: '50%',
          backgroundColor: personaColor,
        }}
        title={displayName}
      />

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Header line: icon + persona + optional work item badge */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11 }}>{icon}</span>
          <span style={{ fontSize: 11, fontWeight: 600, color: personaColor }}>{displayName}</span>

          {workItem && (
            <span style={{
              fontSize: 9,
              padding: '1px 5px',
              borderRadius: 3,
              background: 'rgba(127,127,127,0.12)',
              color: 'var(--feed-muted)',
              fontFamily: 'var(--vscode-editor-font-family)',
            }}>
              {workItem.type} #{workItem.id}
            </span>
          )}

          {transition && (
            <span style={{
              fontSize: 9,
              padding: '1px 5px',
              borderRadius: 3,
              background: `${STATUS_COLORS[transition.to] ?? 'var(--feed-muted)'}22`,
              color: STATUS_COLORS[transition.to] ?? 'var(--feed-muted)',
              fontWeight: 600,
            }}>
              → {transition.to.replace(/_/g, ' ')}
            </span>
          )}

          {entry.messageType === 'thinking' && (
            <span style={{ fontSize: 10, fontStyle: 'italic', opacity: 0.5 }}>thinking...</span>
          )}
        </div>

        {/* Content body */}
        <ContentBody entry={entry} />

        {/* Respond button for prompts */}
        {entry.messageType === 'prompt' && onRespond && (
          <button
            onClick={() => onRespond((entry.metadata?.promptId as string) ?? entry.id)}
            style={{
              marginTop: 4,
              padding: '3px 10px',
              fontSize: 10,
              borderRadius: 3,
              background: 'var(--feed-button-bg)',
              color: 'var(--feed-button-fg)',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            Respond
          </button>
        )}
      </div>
    </div>
  );
}

function ContentBody({ entry }: { entry: ActivityEntry }) {
  const style: React.CSSProperties = {
    fontSize: 11,
    marginTop: 2,
    lineHeight: 1.4,
  };

  switch (entry.messageType) {
    case 'commit':
      return (
        <div style={style}>
          <span style={{ color: 'var(--feed-success)', fontWeight: 500 }}>committed</span>{' '}
          <span style={{ opacity: 0.85 }}>{entry.content}</span>
          {Array.isArray(entry.metadata?.files) && (
            <div style={{ marginTop: 2, opacity: 0.5, fontSize: 10 }}>
              {(entry.metadata.files as string[]).join(', ')}
            </div>
          )}
        </div>
      );

    case 'error':
      return <div style={{ ...style, color: 'var(--feed-error)' }}>{entry.content}</div>;

    case 'completion':
      return <div style={{ ...style, color: 'var(--feed-success)', fontWeight: 500 }}>{entry.content}</div>;

    case 'prompt':
      return (
        <div style={{
          ...style,
          padding: '4px 8px',
          borderRadius: 4,
          border: '1px solid var(--feed-input-border)',
          background: 'var(--feed-input-bg)',
        }}>
          {entry.content}
        </div>
      );

    case 'summary':
      return (
        <div style={{
          ...style,
          padding: '4px 8px',
          borderRadius: 4,
          background: 'var(--vscode-textBlockQuote-background)',
          borderLeft: '2px solid var(--feed-link)',
        }}>
          {entry.content}
        </div>
      );

    default:
      return <div style={{ ...style, opacity: 0.85 }}>{entry.content}</div>;
  }
}
