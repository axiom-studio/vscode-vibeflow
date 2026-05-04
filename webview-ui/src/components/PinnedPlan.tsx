import { useState } from 'react';

/**
 * Wire shape mirrors `VibeFlowProgressSnapshot` in src/api/types.ts, which
 * mirrors the backend `ProgressSnapshot` struct in
 * axiomcloud/database/vibeflow_models.go. All counters/labels are optional —
 * agents may publish a partial snapshot (e.g. just current_action), so the
 * widget renders whatever fields are present.
 */
export interface ProgressSnapshot {
  progress_pct?: number;
  milestone_name?: string;
  milestone_index?: number;
  milestone_total?: number;
  eta_seconds?: number;
  current_action?: string;
  last_progress_at: string;
}

export interface PinnedProgressData {
  personaName: string;
  workItemType: 'todo' | 'issue';
  workItemId: number;
  workItemTitle: string;
  progress: ProgressSnapshot;
}

interface PinnedPlanProps {
  data: PinnedProgressData | null;
}

/**
 * Persistent progress indicator pinned above the scrolling Activity Feed.
 * Renders the structured progress snapshot the backend stamps onto each
 * todo/issue when an agent calls publish_todo_log / publish_issue_log with
 * any progress field (progress_pct, milestone_*, current_action, eta_seconds).
 *
 * Auto-hides when no active work item has a progress snapshot.
 */
export function PinnedPlan({ data }: PinnedPlanProps) {
  const [collapsed, setCollapsed] = useState(false);

  if (!data) { return null; }
  const { personaName, workItemType, workItemId, workItemTitle, progress } = data;

  const { milestone_index, milestone_total, milestone_name, current_action, eta_seconds, progress_pct } = progress;
  const hasMilestone = milestone_total !== undefined && milestone_total > 0;
  // Render index as 1-based since agents report milestone_index zero-based.
  const milestoneLabel = hasMilestone
    ? `${(milestone_index ?? 0) + 1}/${milestone_total}${milestone_name ? ` · ${milestone_name}` : ''}`
    : milestone_name;

  const pctClamped = progress_pct === undefined
    ? undefined
    : Math.max(0, Math.min(100, progress_pct));

  return (
    <div style={{
      borderBottom: '1px solid var(--feed-border)',
      padding: '8px 12px',
      fontSize: 12,
      background: 'var(--vscode-editorHoverWidget-background, var(--feed-bg))',
    }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer',
          userSelect: 'none',
        }}
        onClick={() => setCollapsed(c => !c)}
      >
        <span style={{
          fontWeight: 600,
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          color: 'var(--feed-muted)',
        }}>
          {collapsed ? '▸' : '▾'} Progress · {personaName}
        </span>
        {milestoneLabel && (
          <span style={{ fontSize: 10, color: 'var(--feed-muted)' }}>
            {milestoneLabel}
          </span>
        )}
      </div>

      {!collapsed && (
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 11, color: 'var(--feed-muted)' }}>
            {workItemType === 'todo' ? '☐' : '⚠'} #{workItemId} {workItemTitle}
          </div>

          {pctClamped !== undefined && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}>
              <div style={{
                flex: 1,
                height: 4,
                borderRadius: 2,
                background: 'var(--feed-border)',
                overflow: 'hidden',
              }}>
                <div style={{
                  width: `${pctClamped}%`,
                  height: '100%',
                  background: 'var(--feed-link)',
                  transition: 'width 200ms',
                }} />
              </div>
              <span style={{ fontSize: 10, color: 'var(--feed-muted)', minWidth: 32, textAlign: 'right' }}>
                {pctClamped.toFixed(0)}%
              </span>
            </div>
          )}

          {current_action && (
            <div style={{
              fontSize: 11,
              fontStyle: 'italic',
              color: 'var(--feed-fg)',
              lineHeight: 1.4,
            }}>
              {current_action}
            </div>
          )}

          {eta_seconds !== undefined && eta_seconds > 0 && (
            <div style={{ fontSize: 10, color: 'var(--feed-muted)' }}>
              ETA {formatEta(eta_seconds)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatEta(seconds: number): string {
  if (seconds < 60) { return `${seconds}s`; }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) { return `${minutes}m`; }
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin === 0 ? `${hours}h` : `${hours}h ${remMin}m`;
}
