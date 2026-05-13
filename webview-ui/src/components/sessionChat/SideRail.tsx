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
 * Log entries are truncated to the most recent N — the full log lives
 * in the work-item panel and the Activity Feed. The rail is intended
 * to answer "what's the agent doing right now?" at a glance.
 */
const MAX_LOG_ENTRIES = 20;

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

      {/* Current task */}
      <div className="rail-section">
        <div className="rail-section-title">Current Task</div>
        <div className="rail-task">
          {meta.taskTitle || <span className="rail-task-empty">No active task</span>}
          {meta.taskStatus && <div className="rail-task-time">{meta.taskStatus}</div>}
        </div>
      </div>

      {/* Progress ledger */}
      <div className="rail-section rail-ledger-section">
        <div className="rail-section-title">Activity</div>
        <div className="rail-logs">
          {recentLogs.length === 0 ? (
            <div className="rail-logs-empty">No activity yet.</div>
          ) : recentLogs.map((entry, i) => (
            <div className="rail-log-row" key={i}>
              {entry.src && <span className="rail-log-src">{entry.src}</span>}
              {entry.time && <span className="rail-log-time">{entry.time}</span>}
              <div className="rail-log-text">{entry.text}</div>
            </div>
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
