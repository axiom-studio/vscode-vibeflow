import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { SettingsCommand, GitProviderView } from './settingsTypes';
import { inputStyle } from './_shared';

/**
 * Git Configuration tab (feature #603) — CRUD over the account-level git
 * providers used by Cloud Runners. Supports PAT and SSH key only (OAuth is
 * out of scope here). Secrets are NEVER entered in this webview: the "Add"
 * form collects only the non-secret fields and fires `gitProviderCreate`;
 * the host then prompts for the PAT (masked input) or reads the SSH key from
 * a file the user picks. The list response never carries secrets back.
 */

type AuthType = 'pat' | 'ssh';

interface Props {
  onCommand: (cmd: SettingsCommand) => void;
}

const fullInput: CSSProperties = { ...inputStyle, width: '100%' };
const labelStyle: CSSProperties = { fontSize: 11, fontWeight: 500, color: 'var(--feed-muted)', marginBottom: 4, display: 'block' };
const buttonStyle: CSSProperties = {
  padding: '5px 12px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
  background: 'var(--feed-button-bg)', color: 'var(--feed-button-fg)', border: 'none',
};
const ghostButtonStyle: CSSProperties = {
  padding: '5px 12px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
  background: 'transparent', color: 'var(--feed-muted)', border: '1px solid var(--feed-border)',
};

/** A well-formed https URL host, e.g. `https://github.com`. */
function isValidHttpsUrl(value: string): boolean {
  try {
    return new URL(value.trim()).protocol === 'https:';
  } catch {
    return false;
  }
}

export function GitConfigTab({ onCommand }: Props) {
  const [providers, setProviders] = useState<GitProviderView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add-form state.
  const [authType, setAuthType] = useState<AuthType>('pat');
  const [name, setName] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [userName, setUserName] = useState('');

  // Inline rename state.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');

  // `onCommand` is redefined each render by the parent; a ref keeps the
  // mount effect from re-subscribing (and re-fetching) on every render.
  const onCommandRef = useRef(onCommand);
  onCommandRef.current = onCommand;

  useEffect(() => {
    function handle(event: MessageEvent) {
      const msg = event.data;
      if (msg && msg.type === 'gitProvidersData') {
        setProviders(msg.payload.providers ?? []);
        setError(msg.payload.error ?? null);
        setLoading(false);
      }
    }
    window.addEventListener('message', handle);
    onCommandRef.current({ type: 'gitProvidersList' });
    return () => window.removeEventListener('message', handle);
  }, []);

  const nameOk = name.trim().length > 0;
  const urlOk = isValidHttpsUrl(gitUrl);
  const canCreate = nameOk && urlOk;

  function handleCreate() {
    if (!canCreate) { return; }
    onCommand({
      type: 'gitProviderCreate',
      payload: {
        name: name.trim(),
        gitUrl: gitUrl.trim(),
        authType,
        ...(authType === 'pat' && userName.trim() ? { userName: userName.trim() } : {}),
      },
    });
    // Reset the form; the host re-lists and pushes fresh gitProvidersData.
    setName('');
    setGitUrl('');
    setUserName('');
  }

  function saveRename(id: number) {
    const trimmed = editName.trim();
    if (trimmed) {
      onCommand({ type: 'gitProviderRename', payload: { id, name: trimmed } });
    }
    setEditingId(null);
    setEditName('');
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Existing configurations */}
      <div style={{ padding: '16px 18px', borderRadius: 8, border: '1px solid var(--feed-border)', background: 'var(--vscode-editor-background)' }}>
        <h3 style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 600 }}>Git Configurations</h3>
        <p style={{ margin: '0 0 14px', fontSize: 11, color: 'var(--feed-muted)', lineHeight: 1.5 }}>
          Credentials Cloud Runners use to clone and push. Tokens and keys are stored on the server and never shown here.
        </p>

        {loading && <div style={{ fontSize: 12, color: 'var(--feed-muted)' }}>Loading…</div>}
        {error && !loading && (
          <div style={{ fontSize: 12, color: 'var(--feed-error)' }}>{error}</div>
        )}
        {!loading && !error && providers.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--feed-muted)' }}>No git configurations yet. Add one below.</div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {providers.map(p => (
            <div key={p.id} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
              padding: '10px 12px', borderRadius: 6, border: '1px solid var(--feed-border)',
            }}>
              {editingId === p.id ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
                  <input
                    aria-label={`Rename ${p.name}`}
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    style={{ ...inputStyle, width: 200 }}
                  />
                  <button style={buttonStyle} onClick={() => saveRename(p.id)}>Save</button>
                  <button style={ghostButtonStyle} onClick={() => { setEditingId(null); setEditName(''); }}>Cancel</button>
                </div>
              ) : (
                <>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                      {p.name}
                      <span style={{
                        fontSize: 9, padding: '2px 6px', borderRadius: 3, textTransform: 'uppercase', fontWeight: 700,
                        background: 'rgba(127,127,127,0.14)', color: 'var(--feed-muted)',
                      }}>{p.authMode}</span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--feed-muted)', fontFamily: 'var(--vscode-editor-font-family)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {p.gitUrl}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button style={ghostButtonStyle} onClick={() => { setEditingId(p.id); setEditName(p.name); }}>Rename</button>
                    <button
                      style={{ ...ghostButtonStyle, color: 'var(--feed-error)' }}
                      onClick={() => onCommand({ type: 'gitProviderDelete', payload: { id: p.id, name: p.name } })}
                    >Delete</button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Add a configuration */}
      <div style={{ padding: '16px 18px', borderRadius: 8, border: '1px solid var(--feed-border)', background: 'var(--vscode-editor-background)' }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>Add Git Configuration</h3>

        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          {(['pat', 'ssh'] as AuthType[]).map(t => (
            <label key={t} style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12,
              background: authType === t ? 'rgba(127,127,127,0.10)' : 'transparent',
              border: authType === t ? '1px solid var(--feed-border)' : '1px solid transparent',
            }}>
              <input type="radio" name="git-auth-type" checked={authType === t} onChange={() => setAuthType(t)} style={{ accentColor: 'var(--feed-link)' }} />
              {t === 'pat' ? 'Personal access token (PAT)' : 'SSH key'}
            </label>
          ))}
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle} htmlFor="git-config-name">Name</label>
          <input id="git-config-name" aria-label="Configuration name" value={name} onChange={e => setName(e.target.value)} placeholder="GitHub (work)" style={fullInput} />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle} htmlFor="git-config-url">Git host URL</label>
          <input id="git-config-url" aria-label="Git host URL" value={gitUrl} onChange={e => setGitUrl(e.target.value)} placeholder="https://github.com" style={fullInput} />
          {gitUrl.trim().length > 0 && !urlOk && (
            <div style={{ fontSize: 10, color: 'var(--feed-error)', marginTop: 4 }}>Enter a valid https URL (e.g. https://github.com).</div>
          )}
        </div>

        {authType === 'pat' && (
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle} htmlFor="git-config-username">Username (optional)</label>
            <input id="git-config-username" aria-label="Username" value={userName} onChange={e => setUserName(e.target.value)} placeholder="octocat" style={fullInput} />
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6 }}>
          <button style={{ ...buttonStyle, opacity: canCreate ? 1 : 0.5, cursor: canCreate ? 'pointer' : 'not-allowed' }} disabled={!canCreate} onClick={handleCreate}>
            Add configuration
          </button>
          <span style={{ fontSize: 10, color: 'var(--feed-muted)' }}>
            {authType === 'pat'
              ? 'You’ll be prompted securely for the token.'
              : 'You’ll be asked to pick your private key file.'}
          </span>
        </div>
      </div>
    </div>
  );
}
