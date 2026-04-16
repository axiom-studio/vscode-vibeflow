import { useState } from 'react';

export interface PlanStep {
  status: 'done' | 'active' | 'pending';
  content: string;
}

interface PinnedPlanProps {
  personaName: string;
  steps: PlanStep[];
}

/**
 * Persistent plan checklist pinned above the scrolling Activity Feed.
 * Inspired by OpenCode's todowrite sidebar. Collapsible, auto-hides
 * when empty or all steps are done.
 */
export function PinnedPlan({ personaName, steps }: PinnedPlanProps) {
  const [collapsed, setCollapsed] = useState(false);

  // Auto-hide when empty or all done
  if (steps.length === 0) { return null; }
  const allDone = steps.every(s => s.status === 'done');
  if (allDone) { return null; }

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
          {collapsed ? '▸' : '▾'} Plan ({personaName})
        </span>
        <span style={{
          fontSize: 10,
          color: 'var(--feed-muted)',
        }}>
          {steps.filter(s => s.status === 'done').length}/{steps.length}
        </span>
      </div>

      {/* Steps */}
      {!collapsed && (
        <div style={{ marginTop: 6 }}>
          {steps.map((step, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                gap: 6,
                padding: '2px 0',
                opacity: step.status === 'done' ? 0.5 : 1,
              }}
            >
              <span style={{
                fontFamily: 'var(--vscode-editor-font-family)',
                fontSize: 11,
                width: 28,
                textAlign: 'center',
                flexShrink: 0,
                color: step.status === 'done'
                  ? 'var(--feed-success)'
                  : step.status === 'active'
                    ? 'var(--feed-link)'
                    : 'var(--feed-muted)',
              }}>
                {step.status === 'done' ? '[✓]' : step.status === 'active' ? '[»]' : '[ ]'}
              </span>
              <span style={{
                fontSize: 11,
                lineHeight: 1.4,
                textDecoration: step.status === 'done' ? 'line-through' : 'none',
              }}>
                {step.content}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Parse a plan/summary log block into PlanStep[].
 * Expects numbered list format from agent logs:
 *   1. [description] — done if prefixed with ~~
 *   2. [description] — active if current
 *
 * Also handles PLAN: or Summary blocks with numbered items.
 */
export function parsePlanFromLog(logContent: string): PlanStep[] {
  const steps: PlanStep[] = [];
  const lines = logContent.split('\n');

  let foundPlanSection = false;
  for (const line of lines) {
    const trimmed = line.trim();

    // Detect plan section headers
    if (/^(PLAN|📋|## Plan|## Summary)/i.test(trimmed)) {
      foundPlanSection = true;
      continue;
    }

    // Parse numbered items: "1. text" or "- text"
    const match = trimmed.match(/^(?:\d+\.\s+|\-\s+)(.+)/);
    if (match && foundPlanSection) {
      let content = match[1];
      let status: PlanStep['status'] = 'pending';

      // Check for completion markers
      if (content.startsWith('~~') && content.endsWith('~~')) {
        content = content.slice(2, -2);
        status = 'done';
      } else if (content.startsWith('[x]') || content.startsWith('[X]') || content.startsWith('[✓]')) {
        content = content.slice(3).trim();
        status = 'done';
      } else if (content.startsWith('[>>]') || content.startsWith('[»]')) {
        content = content.slice(4).trim();
        status = 'active';
      } else if (content.startsWith('[ ]')) {
        content = content.slice(3).trim();
        status = 'pending';
      }

      steps.push({ status, content });
    }

    // Stop at non-list content after plan section
    if (foundPlanSection && trimmed && !match && !trimmed.startsWith('#')) {
      break;
    }
  }

  return steps;
}
