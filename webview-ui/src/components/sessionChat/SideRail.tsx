import { useState } from 'react';
import type { SessionMeta, LogEntry } from './sessionChatTypes';

interface Props {
  meta: SessionMeta;
  logs: LogEntry[];
  onStop: () => void;
  onRefresh: () => void;
}

/**
 * Right rail of the session-chat panel. Surfaces the operational
 * signal (persona / model / branch / status / current task / latest
 * progress log entries) without crowding the chat column.
 *
 * Both the Current Task block and each Activity log row clamp to a
 * fixed line count and expand on click — the rail stays compact at a
 * glance, drilldown is one click away. The full log lives in the
 * work-item panel and the Activity Feed; this rail answers
 * "what's the agent doing right now?" at a glance, then "tell me
 * more" when asked.
 */
const MAX_LOG_ENTRIES = 30;

export function SideRail({ meta, logs, onStop, onRefresh }: Props) {
  const recentLogs = logs.slice(-MAX_LOG_ENTRIES).reverse();
  const statusColor =
    meta.status === 'active' ? 'var(--vscode-testing-iconPassed, #4caf50)' :
    meta.status === 'stale' ? 'var(--vscode-editorWarning-foreground, #ffc107)' :
    'var(--vscode-disabledForeground, #888)';

  return (
    <div className="side-rail">
      {/* Persona header */}
      <div className="rail-section rail-header">
        <div className="rail-avatar">
          {meta.personaName.trim().charAt(0).toUpperCase() || 'A'}
        </div>
        <div className="rail-header-text">
          <div className="rail-persona">{meta.personaName}</div>
          <div className="rail-meta">
            <span>{meta.model}</span>
          </div>
          <div className="rail-meta">
            <span className="rail-branch">⎇ {meta.branch}</span>
            <span className="rail-status" style={{ color: statusColor }}>
              <span className="rail-status-dot" style={{ background: statusColor }} />
              {meta.status}
            </span>
          </div>
        </div>
      </div>

      {/* Current task — collapsible */}
      <CurrentTaskCard taskTitle={meta.taskTitle} taskStatus={meta.taskStatus} />

      {/* Progress ledger */}
      <div className="rail-section rail-ledger-section">
        <div className="rail-section-title">Activity</div>
        <div className="rail-logs">
          {recentLogs.length === 0 ? (
            <div className="rail-logs-empty">No activity yet.</div>
          ) : recentLogs.map((entry, i) => (
            <ActivityRow key={`${i}-${entry.time ?? ''}`} entry={entry} />
          ))}
        </div>
      </div>

      {/* Actions */}
      <div className="rail-section rail-actions">
        <button onClick={onRefresh} className="rail-btn rail-btn-secondary">Refresh</button>
        <button onClick={onStop} className="rail-btn rail-btn-danger">Stop</button>
      </div>
    </div>
  );
}

function CurrentTaskCard({ taskTitle, taskStatus }: { taskTitle: string; taskStatus: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!taskTitle) {
    return (
      <div className="rail-section">
        <div className="rail-section-title">Current Task</div>
        <div className="rail-task">
          <span className="rail-task-empty">No active task</span>
        </div>
      </div>
    );
  }
  // Heuristic: only show the expand button when content is plausibly
  // long enough to be clamped. Keeps the UI quiet for short titles.
  const probablyClamps = taskTitle.length > 140 || taskTitle.split('\n').length > 4;
  return (
    <div className="rail-section">
      <div className="rail-section-title">Current Task</div>
      <div className={`rail-task${expanded || !probablyClamps ? '' : ' is-collapsed'}`}>
        {taskTitle}
      </div>
      {taskStatus && <div className="rail-task-time">{taskStatus}</div>}
      {probablyClamps && (
        <button
          className="rail-expand-btn"
          onClick={() => setExpanded(e => !e)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

function ActivityRow({ entry }: { entry: LogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const probablyClamps = entry.text.length > 120 || entry.text.split('\n').length > 3;
  return (
    <div
      className={`rail-log-row${expanded || !probablyClamps ? '' : ' is-collapsed'}`}
      onClick={() => probablyClamps && setExpanded(e => !e)}
      role={probablyClamps ? 'button' : undefined}
      tabIndex={probablyClamps ? 0 : undefined}
      onKeyDown={e => {
        if (!probablyClamps) { return; }
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setExpanded(x => !x);
        }
      }}
    >
      {entry.src && <span className="rail-log-src">{entry.src}</span>}
      {entry.time && <span className="rail-log-time">{entry.time}</span>}
      <div className="rail-log-text">{entry.text}</div>
      {probablyClamps && !expanded && (
        <div className="rail-log-expand-hint">Click to expand</div>
      )}
    </div>
  );
}
