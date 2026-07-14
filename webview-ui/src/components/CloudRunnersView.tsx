import { useState, useEffect, type CSSProperties } from 'react';
import { getVsCodeApi } from '../vscodeApi';
import type {
  CloudRunnerListRow,
  CloudRunnersClientMessage,
  CloudRunnersHostMessage,
} from '../../../src/core/webviewMessages';
import { isRunnerRunning, isRunnerTransitioning, canManageRunner, summarizeRepos, runnerHealthIcon, runnerPrimaryAction, bulkEligibility } from '../../../src/api/cloudRunners';

/** Glyph per health kind (#2890) — text glyphs so no icon lib enters the CSP. */
const HEALTH_GLYPH: Record<string, { glyph: string; color: string }> = {
  healthy: { glyph: '✓', color: 'var(--feed-success, #3fb950)' },
  error: { glyph: '⚠', color: 'var(--feed-error, #f85149)' },
  busy: { glyph: '◌', color: '#d29922' },
};

const vscode = getVsCodeApi() as { postMessage: (msg: CloudRunnersClientMessage) => void };

/** Runner lifecycle status → dot color. Unknown statuses fall back to muted. */
const STATUS_COLOR: Record<string, string> = {
  pending: 'var(--feed-muted, #8b949e)',
  starting: '#d29922',
  authenticating: '#d29922', // agent mid-login (#437) — pod up, awaiting sign-in
  active: 'var(--feed-success, #3fb950)',
  stopping: '#db6d28',
  stopped: 'var(--feed-muted, #8b949e)',
  failed: 'var(--feed-error, #f85149)',
};

export function statusColor(status: string): string {
  return STATUS_COLOR[status] ?? 'var(--feed-muted, #8b949e)';
}

/** RFC3339 → a locale date-time; empty/invalid stamps render as an em dash. */
export function formatCreatedAt(iso: string): string {
  if (!iso) { return '—'; }
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

interface State {
  runners: CloudRunnerListRow[];
  loading: boolean;
  error: string | undefined;
  generatedAt: string | undefined;
}

// Standard table styling — mirrors TicketsView's Th/Td so the Cloud Runners
// page reads as the same "cloud-style table" as the rest of Browse (#2811).
const th: CSSProperties = {
  textAlign: 'left', padding: '7px 12px', fontSize: 10.5, fontWeight: 600,
  textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--feed-muted)',
  borderBottom: '1px solid var(--feed-border)', whiteSpace: 'nowrap',
};
const td: CSSProperties = {
  padding: '7px 12px', fontSize: 12, borderBottom: '1px solid var(--feed-border)',
  verticalAlign: 'middle', maxWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const msgStyle: CSSProperties = { fontSize: 12, color: 'var(--feed-muted)', padding: '16px 24px' };
// Actions cell opts out of the ellipsis clamp so the buttons keep their width.
const actionsTd: CSSProperties = { padding: '5px 12px', fontSize: 12, borderBottom: '1px solid var(--feed-border)', verticalAlign: 'middle', whiteSpace: 'nowrap', textAlign: 'right' };
const actionBtn: CSSProperties = {
  padding: '4px 10px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
  background: 'transparent', color: 'var(--feed-fg)', border: '1px solid var(--feed-border)',
};

export function CloudRunnersView() {
  const [state, setState] = useState<State>({ runners: [], loading: true, error: undefined, generatedAt: undefined });
  const [selected, setSelected] = useState<Set<number>>(new Set());

  useEffect(() => {
    function handle(event: MessageEvent<CloudRunnersHostMessage>) {
      const msg = event.data;
      if (msg?.type === 'cloudRunnersData') {
        const runners = msg.payload.runners ?? [];
        setState({ runners, loading: false, error: undefined, generatedAt: msg.payload.generatedAt });
        // Prune selection to runners that still exist (#2893).
        setSelected(prev => {
          const live = new Set(runners.map(r => r.id));
          const next = new Set<number>();
          prev.forEach(id => { if (live.has(id)) { next.add(id); } });
          return next;
        });
      } else if (msg?.type === 'cloudRunnersError') {
        setState(s => ({ ...s, loading: false, error: msg.payload.message }));
      }
    }
    window.addEventListener('message', handle);
    vscode.postMessage({ type: 'cloudRunnersLoad' });
    return () => window.removeEventListener('message', handle);
  }, []);

  function refresh() {
    setState(s => ({ ...s, loading: true, error: undefined }));
    vscode.postMessage({ type: 'cloudRunnersRefresh' });
  }

  function toggleRow(id: number) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
  }

  function toggleAll() {
    setSelected(prev => prev.size === state.runners.length ? new Set() : new Set(state.runners.map(r => r.id)));
  }

  const selectedRunners = state.runners.filter(r => selected.has(r.id));
  const eligibility = bulkEligibility(selectedRunners.map(r => r.status));

  function bulk(type: 'cloudRunnerBulkStart' | 'cloudRunnerBulkStop' | 'cloudRunnerBulkDelete') {
    if (type === 'cloudRunnerBulkDelete') {
      vscode.postMessage({ type, payload: { runners: selectedRunners.map(r => ({ projectId: r.projectId, id: r.id, name: r.name })) } });
      return;
    }
    const running = type === 'cloudRunnerBulkStop';
    const runners = selectedRunners
      .filter(r => !isRunnerTransitioning(r.status) && isRunnerRunning(r.status) === running)
      .map(r => ({ projectId: r.projectId, id: r.id }));
    vscode.postMessage({ type, payload: { runners } });
  }

  return (
    <div style={{
      fontFamily: 'var(--vscode-font-family)', color: 'var(--feed-fg)', background: 'var(--feed-bg)',
      height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 24px', borderBottom: '1px solid var(--feed-border)', flexShrink: 0,
      }}>
        <span style={{ fontSize: 16, fontWeight: 700 }}>Cloud Runners</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {selected.size > 0 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <span style={{ color: 'var(--feed-muted)' }}>{selected.size} selected</span>
              <button style={actionBtn} disabled={eligibility.startable === 0} onClick={() => bulk('cloudRunnerBulkStart')}>Start {eligibility.startable}</button>
              <button style={actionBtn} disabled={eligibility.stoppable === 0} onClick={() => bulk('cloudRunnerBulkStop')}>Stop {eligibility.stoppable}</button>
              <button style={{ ...actionBtn, color: 'var(--feed-error)' }} onClick={() => bulk('cloudRunnerBulkDelete')}>Delete {selected.size}</button>
            </span>
          )}
          <button
            onClick={refresh}
            style={{ padding: '5px 14px', fontSize: 12, background: 'var(--feed-button-bg)', color: 'var(--feed-button-fg)', border: 'none', borderRadius: 4, cursor: 'pointer' }}
          >Refresh</button>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {state.loading && <div style={msgStyle}>Loading runners…</div>}
        {state.error && !state.loading && (
          <div style={{ ...msgStyle, color: 'var(--feed-error)' }}>{state.error}</div>
        )}
        {!state.loading && !state.error && state.runners.length === 0 && (
          <div style={msgStyle}>No cloud runners yet.</div>
        )}
        {!state.loading && !state.error && state.runners.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ position: 'sticky', top: 0, background: 'var(--feed-bg)', zIndex: 1 }}>
                <th style={{ ...th, width: 28 }}>
                  <input
                    type="checkbox"
                    aria-label="Select all runners"
                    checked={selected.size > 0 && selected.size === state.runners.length}
                    onChange={toggleAll}
                  />
                </th>
                <th style={th}>Name</th>
                <th style={th}>Status</th>
                <th style={th}>Pod Status</th>
                <th style={th}>User</th>
                <th style={th}>Repository</th>
                <th style={th}>Branch</th>
                <th style={th}>Created</th>
                <th style={{ ...th, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {state.runners.map(r => (
                <tr key={r.id}>
                  <td style={{ ...td, width: 28 }}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${r.name}`}
                      checked={selected.has(r.id)}
                      onChange={() => toggleRow(r.id)}
                    />
                  </td>
                  <td style={{ ...td, fontWeight: 600 }}>{r.name}</td>
                  <td style={td}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor(r.status), display: 'inline-block' }} />
                      {r.status}
                      {(() => {
                        // One-click contextual action from the tuple (#2891).
                        const action = runnerPrimaryAction(r.status, r.podStatus);
                        if (action.disabled) {
                          // Muted affordance only when it adds information.
                          return action.label.toLowerCase() !== r.status
                            ? <span style={{ fontSize: 11, color: 'var(--feed-muted)' }}>· {action.label}</span>
                            : null;
                        }
                        return (
                          <button
                            style={{ ...actionBtn, padding: '2px 8px' }}
                            onClick={() => vscode.postMessage({ type: 'cloudRunnerManage', payload: { projectId: r.projectId, id: r.id, name: r.name } })}
                          >{action.label}</button>
                        );
                      })()}
                    </span>
                  </td>
                  <td style={{ ...td, color: 'var(--feed-muted)' }}>
                    {(() => {
                      const health = runnerHealthIcon(r.status, r.podStatus);
                      const g = HEALTH_GLYPH[health.kind];
                      return (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title={health.title || undefined} aria-label={health.title || undefined}>
                          {g && <span style={{ color: g.color }}>{g.glyph}</span>}
                          {r.podStatus || '—'}
                        </span>
                      );
                    })()}
                  </td>
                  <td style={{ ...td, color: 'var(--feed-muted)' }} title={r.ownerEmail || undefined}>{r.ownerEmail || `#${r.userId}`}</td>
                  <td style={td}>{summarizeRepos(r.repos).repo}</td>
                  <td style={{ ...td, fontFamily: 'var(--vscode-editor-font-family)' }}>{summarizeRepos(r.repos).branch}</td>
                  <td style={{ ...td, color: 'var(--feed-muted)' }}>{formatCreatedAt(r.createdAt)}</td>
                  <td style={actionsTd}>
                    {isRunnerTransitioning(r.status) ? (
                      <span style={{ fontSize: 11, color: 'var(--feed-muted)' }}>
                        {r.status === 'starting' ? 'Starting…' : 'Stopping…'}
                      </span>
                    ) : (
                      <span style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end' }}>
                        {canManageRunner(r.status) && (
                          <button style={actionBtn} onClick={() => vscode.postMessage({ type: 'cloudRunnerManage', payload: { projectId: r.projectId, id: r.id, name: r.name } })}>Manage</button>
                        )}
                        {isRunnerRunning(r.status) ? (
                          <button style={actionBtn} onClick={() => vscode.postMessage({ type: 'cloudRunnerStop', payload: { projectId: r.projectId, id: r.id } })}>Stop</button>
                        ) : (
                          <button style={actionBtn} onClick={() => vscode.postMessage({ type: 'cloudRunnerStart', payload: { projectId: r.projectId, id: r.id } })}>Start</button>
                        )}
                        <button
                          style={{ ...actionBtn, color: 'var(--feed-error)' }}
                          onClick={() => vscode.postMessage({ type: 'cloudRunnerDelete', payload: { projectId: r.projectId, id: r.id, name: r.name } })}
                        >Delete</button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
