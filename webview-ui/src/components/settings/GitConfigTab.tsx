import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { SettingsCommand, GitProviderView } from './settingsTypes';
import { inputStyle } from './_shared';

/**
 * Git Configuration tab (features #603 / #604) — CRUD over the account-level
 * git providers used by Cloud Runners. Supports PAT and SSH key only.
 *
 * Per the #3389 design (user chose "match the mockup"), the secret is entered
 * INLINE in the "Add a provider" form: a masked Access-token field for PAT, a
 * private-key textarea for SSH. The secret lives only transiently in local
 * component state — it is cleared on submit, never logged, never persisted to
 * settings, and travels straight to the server via `gitProviderCreate`. The
 * list response never carries secrets back (write-only).
 */

type AuthType = 'pat' | 'ssh';

interface Props {
  onCommand: (cmd: SettingsCommand) => void;
  /** Diagnostics toggle state (#3397) — `vibeflow.cloudRunners.debug`. */
  cloudRunnersDebug?: boolean;
  /** Persist a settings change (routes through updateSetting). */
  onUpdate?: (key: string, value: unknown) => void;
}

const DEFAULT_GIT_HOST = 'https://github.com';

const fullInput: CSSProperties = { ...inputStyle, width: '100%' };
const labelStyle: CSSProperties = { fontSize: 12, fontWeight: 600, marginBottom: 4, display: 'block' };
const helpStyle: CSSProperties = { fontSize: 10, color: 'var(--feed-muted)', marginTop: 4 };
const buttonStyle: CSSProperties = {
  padding: '5px 12px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
  background: 'var(--feed-button-bg)', color: 'var(--feed-button-fg)', border: 'none',
};
const ghostButtonStyle: CSSProperties = {
  padding: '5px 12px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
  background: 'transparent', color: 'var(--feed-muted)', border: '1px solid var(--feed-border)',
};

/** Blank is allowed (host defaults to github.com); a provided value must be https. */
function isValidHost(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) { return true; }
  try {
    return new URL(trimmed).protocol === 'https:';
  } catch {
    return false;
  }
}

export function GitConfigTab({ onCommand, cloudRunnersDebug = false, onUpdate }: Props) {
  const [providers, setProviders] = useState<GitProviderView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Outcome of the last add attempt, shown inline so a failure isn't missed
  // (a toast alone reads as success once the form clears) (#3393).
  const [createStatus, setCreateStatus] = useState<{ ok: boolean; error?: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Add-form state. `accessToken` / `sshPrivateKey` are the transient secrets.
  const [authType, setAuthType] = useState<AuthType>('pat');
  const [name, setName] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [userName, setUserName] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [sshPrivateKey, setSshPrivateKey] = useState('');

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
      } else if (msg && msg.type === 'gitProviderCreateResult') {
        setSubmitting(false);
        setCreateStatus({ ok: msg.payload.ok, error: msg.payload.error });
        if (msg.payload.ok) {
          // Success — clear the remaining (non-secret) fields. On failure they
          // are kept so the user can fix and retry without re-typing.
          setName('');
          setGitUrl('');
          setUserName('');
        }
      }
    }
    window.addEventListener('message', handle);
    onCommandRef.current({ type: 'gitProvidersList' });
    return () => window.removeEventListener('message', handle);
  }, []);

  const nameOk = name.trim().length > 0;
  const hostOk = isValidHost(gitUrl);
  const secretOk = authType === 'pat' ? accessToken.trim().length > 0 : sshPrivateKey.trim().length > 0;
  const canCreate = nameOk && hostOk && secretOk;

  function handleCreate() {
    if (!canCreate) { return; }
    const payload =
      authType === 'pat'
        ? {
            name: name.trim(),
            gitUrl: gitUrl.trim() || DEFAULT_GIT_HOST,
            authType,
            ...(userName.trim() ? { userName: userName.trim() } : {}),
            accessToken,
          }
        : {
            name: name.trim(),
            gitUrl: gitUrl.trim() || DEFAULT_GIT_HOST,
            authType,
            sshPrivateKey,
          };
    setCreateStatus(null);
    setSubmitting(true);
    onCommand({ type: 'gitProviderCreate', payload });
    // Clear the SECRET immediately (write-only invariant, #3389). Name / host /
    // username are cleared only on a successful result (#3393) so a failed add
    // can be retried without re-entering everything.
    setAccessToken('');
    setSshPrivateKey('');
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

      {/* Add a provider */}
      <div style={{ padding: '18px 20px', borderRadius: 8, border: '1px solid var(--feed-border)', background: 'var(--vscode-editor-background)' }}>
        <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 700 }}>Add a provider</h3>

        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle} htmlFor="git-config-name">Name</label>
          <input id="git-config-name" aria-label="Name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. my-github" style={fullInput} />
          <div style={helpStyle}>A label to identify this provider later.</div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle} htmlFor="git-config-url">Git host</label>
          <input id="git-config-url" aria-label="Git host" value={gitUrl} onChange={e => setGitUrl(e.target.value)} placeholder={DEFAULT_GIT_HOST} style={fullInput} />
          {gitUrl.trim().length > 0 && !hostOk
            ? <div style={{ ...helpStyle, color: 'var(--feed-error)' }}>Enter a valid https URL (e.g. {DEFAULT_GIT_HOST}).</div>
            : <div style={helpStyle}>Leave blank to default to {DEFAULT_GIT_HOST}.</div>}
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle} htmlFor="git-config-auth">Authentication</label>
          <select
            id="git-config-auth"
            aria-label="Authentication"
            value={authType}
            onChange={e => setAuthType(e.target.value as AuthType)}
            style={fullInput}
          >
            <option value="pat">Personal Access Token</option>
            <option value="ssh">SSH Key</option>
          </select>
        </div>

        {authType === 'pat' ? (
          <div style={{ display: 'flex', gap: 14, marginBottom: 4, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 180 }}>
              <label style={labelStyle} htmlFor="git-config-username">Username <span style={{ fontWeight: 400, color: 'var(--feed-muted)' }}>(optional)</span></label>
              <input id="git-config-username" aria-label="Username" value={userName} onChange={e => setUserName(e.target.value)} placeholder="git username" style={fullInput} />
            </div>
            <div style={{ flex: 1, minWidth: 180 }}>
              <label style={labelStyle} htmlFor="git-config-token">Access token</label>
              <input
                id="git-config-token"
                aria-label="Access token"
                type="password"
                autoComplete="off"
                value={accessToken}
                onChange={e => setAccessToken(e.target.value)}
                placeholder="••••••••"
                style={fullInput}
              />
              <div style={helpStyle}>Needs repository read/write scope.</div>
            </div>
          </div>
        ) : (
          <div style={{ marginBottom: 4 }}>
            <label style={labelStyle} htmlFor="git-config-sshkey">SSH private key</label>
            <textarea
              id="git-config-sshkey"
              aria-label="SSH private key"
              value={sshPrivateKey}
              onChange={e => setSshPrivateKey(e.target.value)}
              placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----'}
              spellCheck={false}
              rows={6}
              style={{ ...fullInput, resize: 'vertical', fontFamily: 'var(--vscode-editor-font-family)', minHeight: 120 }}
            />
            <div style={helpStyle}>Paste the private key in PEM format.</div>
          </div>
        )}

        {createStatus && (
          <div
            role="status"
            style={{
              fontSize: 12, marginTop: 12, padding: '8px 10px', borderRadius: 4,
              color: createStatus.ok ? 'var(--feed-success, #3fb950)' : 'var(--feed-error)',
              border: `1px solid ${createStatus.ok ? 'var(--feed-success, #3fb950)' : 'var(--feed-error)'}`,
            }}
          >
            {createStatus.ok ? 'Provider added.' : (createStatus.error || 'Could not add provider.')}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
          <button
            style={{ ...buttonStyle, padding: '8px 18px', fontSize: 13, fontWeight: 600, opacity: canCreate && !submitting ? 1 : 0.5, cursor: canCreate && !submitting ? 'pointer' : 'not-allowed' }}
            disabled={!canCreate || submitting}
            onClick={handleCreate}
          >
            {submitting ? 'Adding…' : 'Add provider'}
          </button>
        </div>
      </div>

      {/* Diagnostics (#3397) — lives here (not only package.json contributes)
          so it appears after a plain rebuild+reload, no reinstall needed. */}
      {onUpdate && (
        <div style={{ padding: '16px 18px', borderRadius: 8, border: '1px solid var(--feed-border)', background: 'var(--vscode-editor-background)' }}>
          <h3 style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 600 }}>Diagnostics</h3>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, cursor: 'pointer' }}>
            <input
              type="checkbox"
              aria-label="Cloud Runners debug logging"
              checked={cloudRunnersDebug}
              onChange={e => onUpdate('cloudRunners.debug', e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span>
              Log Cloud Runners API calls to the <strong>VibeFlow Cloud Runners</strong> output channel
              <div style={{ fontSize: 10, color: 'var(--feed-muted)', marginTop: 2 }}>
                Traces method, path, status, and response shape for cloud-runner and git-provider requests. Never logs request bodies or secrets. Open via View → Output.
              </div>
            </span>
          </label>
        </div>
      )}
    </div>
  );
}
