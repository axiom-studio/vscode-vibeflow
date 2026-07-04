import { useState, useEffect, type CSSProperties } from 'react';
import { getVsCodeApi } from '../vscodeApi';
import type {
  CloudRunnersClientMessage,
  CloudRunnersHostMessage,
} from '../../../src/core/webviewMessages';
import type { GlobalCloudRunnerView } from '../../../src/api/types';

const vscode = getVsCodeApi() as { postMessage: (msg: CloudRunnersClientMessage) => void };

/** Runner lifecycle status → dot color. Unknown statuses fall back to muted. */
const STATUS_COLOR: Record<string, string> = {
  pending: 'var(--feed-muted, #8b949e)',
  starting: '#d29922',
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
  runners: GlobalCloudRunnerView[];
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

export function CloudRunnersView() {
  const [state, setState] = useState<State>({ runners: [], loading: true, error: undefined, generatedAt: undefined });

  useEffect(() => {
    function handle(event: MessageEvent<CloudRunnersHostMessage>) {
      const msg = event.data;
      if (msg?.type === 'cloudRunnersData') {
        setState({ runners: msg.payload.runners ?? [], loading: false, error: undefined, generatedAt: msg.payload.generatedAt });
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
        <button
          onClick={refresh}
          style={{ padding: '5px 14px', fontSize: 12, background: 'var(--feed-button-bg)', color: 'var(--feed-button-fg)', border: 'none', borderRadius: 4, cursor: 'pointer' }}
        >Refresh</button>
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
                <th style={th}>Name</th>
                <th style={th}>Status</th>
                <th style={th}>Pod Status</th>
                <th style={th}>Project</th>
                <th style={th}>Created</th>
              </tr>
            </thead>
            <tbody>
              {state.runners.map(r => (
                <tr key={r.id}>
                  <td style={{ ...td, fontWeight: 600 }}>{r.name}</td>
                  <td style={td}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor(r.status), display: 'inline-block' }} />
                      {r.status}
                    </span>
                  </td>
                  <td style={{ ...td, color: 'var(--feed-muted)' }}>{r.podStatus || '—'}</td>
                  <td style={td}>{r.projectName || '—'}</td>
                  <td style={{ ...td, color: 'var(--feed-muted)' }}>{formatCreatedAt(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
