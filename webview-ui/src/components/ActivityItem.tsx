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

export function ActivityItem({ entry, onRespond }: ActivityItemProps) {
  const personaColor = PERSONA_COLORS[entry.personaKey] ?? '#cccccc';
  const icon = MESSAGE_ICONS[entry.messageType];

  return (
    <div className="flex gap-2 px-2 py-1.5 hover:bg-[var(--vscode-list-hoverBackground)] transition-colors">
      {/* Timestamp */}
      <span className="shrink-0 text-[10px] leading-5 opacity-50 tabular-nums">
        {formatTime(entry.timestamp)}
      </span>

      {/* Persona dot */}
      <span
        className="shrink-0 mt-1.5 size-2 rounded-full"
        style={{ backgroundColor: personaColor }}
        title={entry.personaName}
      />

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="text-xs">{icon}</span>
          <span
            className="text-xs font-medium"
            style={{ color: personaColor }}
          >
            {entry.personaName}
          </span>
          {entry.messageType === 'thinking' && (
            <span className="text-xs italic opacity-60">thinking...</span>
          )}
        </div>

        <Content entry={entry} />

        {/* Respond button for prompts */}
        {entry.messageType === 'prompt' && onRespond && (
          <button
            className="mt-1 px-2 py-0.5 text-[11px] rounded
              bg-[var(--feed-button-bg)] text-[var(--feed-button-fg)]
              hover:bg-[var(--feed-button-hover)] cursor-pointer
              border-none outline-none"
            onClick={() => {
              const promptId = (entry.metadata?.promptId as string) ?? entry.id;
              onRespond(promptId);
            }}
          >
            Respond
          </button>
        )}
      </div>
    </div>
  );
}

function Content({ entry }: { entry: ActivityEntry }) {
  switch (entry.messageType) {
    case 'commit':
      return (
        <div className="text-xs mt-0.5">
          <span className="text-[var(--feed-success)]">committed</span>{' '}
          <span className="opacity-80">{entry.content}</span>
          {Array.isArray(entry.metadata?.files) && (
            <div className="mt-0.5 opacity-60 text-[11px]">
              {(entry.metadata.files as string[]).join(', ')}
            </div>
          )}
        </div>
      );

    case 'error':
      return (
        <div className="text-xs mt-0.5 text-[var(--feed-error)]">
          {entry.content}
        </div>
      );

    case 'completion':
      return (
        <div className="text-xs mt-0.5 text-[var(--feed-success)] font-medium">
          {entry.content}
        </div>
      );

    case 'prompt':
      return (
        <div className="text-xs mt-0.5 px-2 py-1 rounded border
          border-[var(--feed-input-border)] bg-[var(--feed-input-bg)]">
          {entry.content}
        </div>
      );

    case 'summary':
      return (
        <div className="text-xs mt-0.5 px-2 py-1 rounded
          bg-[var(--vscode-textBlockQuote-background)] border-l-2
          border-[var(--feed-link)]">
          {entry.content}
        </div>
      );

    default:
      return (
        <div className="text-xs mt-0.5 opacity-90">
          {entry.content}
        </div>
      );
  }
}
