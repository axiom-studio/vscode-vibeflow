import type { CSSProperties } from 'react';
import type { ActivityEntry } from '../types';
import { PERSONA_COLORS, MESSAGE_ICONS } from '../types';
import { StatusPill } from './_shared/StatusPill';
import { enhanceLeafText, type ChatTokenDispatch } from './sessionChat/chatTokens';
import { getVsCodeApi } from '../vscodeApi';

/**
 * Dispatch for the click-to-open buttons emitted by `enhanceLeafText`.
 * Singleton — no instance state. The Activity Feed host registers the
 * matching `chatOpenCommit` / `chatOpenPath` handlers in
 * ActivityFeedProvider, routing through the shared chatActions module.
 */
const activityTokenDispatch: ChatTokenDispatch = {
  openCommit(hash) {
    getVsCodeApi().postMessage({ type: 'chatOpenCommit', payload: { hash } });
  },
  openPath(path, line, column) {
    getVsCodeApi().postMessage({ type: 'chatOpenPath', payload: { path, line, column } });
  },
  openWorkItem(kind, id) {
    getVsCodeApi().postMessage({ type: 'chatOpenWorkItem', payload: { kind, id } });
  },
};

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
    <div
      className="flex gap-2.5 px-3 py-1.5 text-[12px] transition-colors duration-100 ease-out hover:bg-[var(--vscode-list-hoverBackground)]"
      style={{
        borderBottom: '1px solid color-mix(in oklab, var(--vscode-foreground) 7%, transparent)',
      }}
    >
      {/* Timestamp */}
      <span
        className="shrink-0 text-[10.5px] leading-[18px] w-[40px] tabular-nums"
        style={{
          color: 'var(--feed-muted)',
          opacity: 0.7,
          fontFeatureSettings: '"tnum"',
          letterSpacing: '0.01em',
        }}
      >
        {formatTime(entry.timestamp)}
      </span>

      {/* Persona dot — ring-haloed for dimensional presence */}
      <span
        className="shrink-0 mt-[5px] w-[9px] h-[9px] rounded-full"
        style={{
          backgroundColor: personaColor,
          boxShadow: `0 0 0 2px color-mix(in oklab, ${personaColor} 22%, transparent)`,
        }}
        title={displayName}
        aria-hidden
      />

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Header line: icon + persona + optional work item badge */}
        <div className="flex items-baseline gap-[6px] flex-wrap">
          <span className="text-[11px] leading-none" aria-hidden>{icon}</span>
          <span
            className="text-[11.5px] font-medium tracking-[-0.005em]"
            style={{ color: personaColor }}
          >
            {displayName}
          </span>

          {workItem && <WorkItemBadge type={workItem.type} id={workItem.id} />}
          {transition && (
            <StatusPill color={STATUS_COLORS[transition.to] ?? 'var(--feed-muted)'}>
              → {transition.to.replace(/_/g, ' ')}
            </StatusPill>
          )}

          {entry.messageType === 'thinking' && (
            <span className="text-[10px] italic opacity-50">thinking…</span>
          )}
        </div>

        {/* Content body */}
        <ContentBody entry={entry} />

        {/* Respond button for prompts */}
        {entry.messageType === 'prompt' && onRespond && (
          <button
            onClick={() => onRespond((entry.metadata?.promptId as string) ?? entry.id)}
            className="mt-1.5 px-2.5 py-[3px] text-[10.5px] font-medium rounded-sm cursor-pointer border-none outline-none transition-all duration-150 ease-out active:scale-[0.97] bg-[var(--feed-button-bg)] text-[var(--feed-button-fg)] hover:bg-[var(--feed-button-hover)]"
          >
            Respond
          </button>
        )}
      </div>
    </div>
  );
}

function WorkItemBadge({ type, id }: { type: string; id: string }) {
  return (
    <span
      className="text-[9.5px] px-[5px] py-[1px] rounded-[3px] tabular-nums"
      style={{
        background: 'color-mix(in oklab, var(--vscode-foreground) 8%, transparent)',
        color: 'var(--feed-muted)',
        fontFamily: 'var(--vscode-editor-font-family, monospace)',
        letterSpacing: '0.01em',
      }}
    >
      {type} #{id}
    </span>
  );
}

function ContentBody({ entry }: { entry: ActivityEntry }) {
  const baseStyle: CSSProperties = {
    fontSize: 11.5,
    marginTop: 3,
    lineHeight: 1.5,
    wordBreak: 'break-word',
  };

  switch (entry.messageType) {
    case 'commit':
      return (
        <div style={baseStyle}>
          <span style={{ color: 'var(--feed-success)', fontWeight: 600 }}>committed</span>{' '}
          <span style={{ opacity: 0.9 }}>{enhanceLeafText(entry.content, activityTokenDispatch)}</span>
          {Array.isArray(entry.metadata?.files) && (
            <div
              style={{
                marginTop: 3,
                opacity: 0.55,
                fontSize: 10,
                lineHeight: 1.45,
                fontFamily: 'var(--vscode-editor-font-family, monospace)',
              }}
            >
              {(entry.metadata.files as string[]).join(', ')}
            </div>
          )}
        </div>
      );

    case 'error':
      return <div style={{ ...baseStyle, color: 'var(--feed-error)' }}>{enhanceLeafText(entry.content, activityTokenDispatch)}</div>;

    case 'completion':
      return (
        <div style={{ ...baseStyle, color: 'var(--feed-success)', fontWeight: 600 }}>
          {enhanceLeafText(entry.content, activityTokenDispatch)}
        </div>
      );

    case 'prompt':
      return (
        <div
          style={{
            ...baseStyle,
            padding: '5px 9px',
            borderRadius: 5,
            border: '1px solid var(--feed-input-border)',
            background: 'var(--feed-input-bg)',
          }}
        >
          {enhanceLeafText(entry.content, activityTokenDispatch)}
        </div>
      );

    case 'summary':
      return (
        <div
          style={{
            ...baseStyle,
            padding: '5px 10px',
            borderRadius: 5,
            background: 'var(--vscode-textBlockQuote-background)',
            borderLeft: '2px solid var(--feed-link)',
          }}
        >
          {enhanceLeafText(entry.content, activityTokenDispatch)}
        </div>
      );

    default:
      return <div style={{ ...baseStyle, opacity: 0.88 }}>{enhanceLeafText(entry.content, activityTokenDispatch)}</div>;
  }
}
