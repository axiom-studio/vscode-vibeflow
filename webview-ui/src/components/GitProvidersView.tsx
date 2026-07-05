import { useState, useEffect, type CSSProperties } from 'react';
import { getVsCodeApi } from '../vscodeApi';
import type {
  GitProvidersPageClientMessage,
  GitProvidersPageHostMessage,
} from '../../../src/core/webviewMessages';
import type { GitProviderView } from '../../../src/api/types';

const vscode = getVsCodeApi() as { postMessage: (msg: GitProvidersPageClientMessage) => void };

interface State {
  providers: GitProviderView[];
  loading: boolean;
  error: string | undefined;
}

// Standard table styling — mirrors the Cloud Runners / Tickets cloud-style
// table (#2811) so Browse pages read consistently.
const th: CSSProperties = {
  textAlign: 'left', padding: '7px 12px', fontSize: 10.5, fontWeight: 600,
  textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--feed-muted)',
  borderBottom: '1px solid var(--feed-border)', whiteSpace: 'nowrap',
};
const td: CSSProperties = {
  padding: '7px 12px', fontSize: 12, borderBottom: '1px solid var(--feed-border)',
  verticalAlign: 'middle', maxWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const actionsTd: CSSProperties = { padding: '5px 12px', fontSize: 12, borderBottom: '1px solid var(--feed-border)', verticalAlign: 'middle', whiteSpace: 'nowrap', textAlign: 'right' };
const msgStyle: CSSProperties = { fontSize: 12, color: 'var(--feed-muted)', padding: '16px 24px' };
const actionBtn: CSSProperties = {
  padding: '4px 10px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
  background: 'transparent', color: 'var(--feed-error)', border: '1px solid var(--feed-border)',
};
const authBadge: CSSProperties = {
  fontSize: 9, padding: '2px 6px', borderRadius: 3, textTransform: 'uppercase', fontWeight: 700,
  background: 'rgba(127,127,127,0.14)', color: 'var(--feed-muted)',
};

/**
 * Git Providers page (#2822) — lists the user's account-level git providers.
 * `GitProviderView` carries id/name/gitUrl/authMode only; the API never returns
 * credentials, so nothing sensitive can render here. Delete posts id+name and
 * the HOST shows the modal confirm before calling the API.
 */
export function GitProvidersView() {
  const [state, setState] = useState<State>({ providers: [], loading: true, error: undefined });

  useEffect(() => {
    function handle(event: MessageEvent<GitProvidersPageHostMessage>) {
      const msg = event.data;
      if (msg?.type === 'gitProvidersPageData') {
        setState({ providers: msg.payload.providers ?? [], loading: false, error: undefined });
      } else if (msg?.type === 'gitProvidersPageError') {
        setState(s => ({ ...s, loading: false, error: msg.payload.message }));
      }
    }
    window.addEventListener('message', handle);
    vscode.postMessage({ type: 'gitProvidersPageLoad' });
    return () => window.removeEventListener('message', handle);
  }, []);

  function refresh() {
    setState(s => ({ ...s, loading: true, error: undefined }));
    vscode.postMessage({ type: 'gitProvidersPageRefresh' });
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
        <div>
          <span style={{ fontSize: 16, fontWeight: 700 }}>Git Providers</span>
          <div style={{ fontSize: 11, color: 'var(--feed-muted)', marginTop: 2 }}>
            Credentials Cloud Runners use to clone and push. Tokens and keys are stored on the server and never shown here.
          </div>
        </div>
        <button
          onClick={refresh}
          style={{ padding: '5px 14px', fontSize: 12, background: 'var(--feed-button-bg)', color: 'var(--feed-button-fg)', border: 'none', borderRadius: 4, cursor: 'pointer' }}
        >Refresh</button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {state.loading && <div style={msgStyle}>Loading git providers…</div>}
        {state.error && !state.loading && (
          <div style={{ ...msgStyle, color: 'var(--feed-error)' }}>{state.error}</div>
        )}
        {!state.loading && !state.error && state.providers.length === 0 && (
          <div style={msgStyle}>No git providers yet. Add one in Settings → Git Configuration.</div>
        )}
        {!state.loading && !state.error && state.providers.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ position: 'sticky', top: 0, background: 'var(--feed-bg)', zIndex: 1 }}>
                <th style={th}>Name</th>
                <th style={th}>Git Host</th>
                <th style={th}>Authentication</th>
                <th style={{ ...th, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {state.providers.map(p => (
                <tr key={p.id}>
                  <td style={{ ...td, fontWeight: 600 }}>{p.name}</td>
                  <td style={{ ...td, fontFamily: 'var(--vscode-editor-font-family)' }}>{p.gitUrl}</td>
                  <td style={td}><span style={authBadge}>{p.authMode}</span></td>
                  <td style={actionsTd}>
                    <button
                      style={actionBtn}
                      onClick={() => vscode.postMessage({ type: 'gitProvidersPageDelete', payload: { id: p.id, name: p.name } })}
                    >Delete</button>
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
