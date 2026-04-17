import type { SettingsData, SettingsCommand } from './settingsTypes';

interface Props {
  data: SettingsData;
  onUpdate: (key: string, value: unknown) => void;
  onCommand: (cmd: SettingsCommand) => void;
}

export function ConnectionTab({ data, onUpdate, onCommand }: Props) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <Card
        title="Server URL"
        description="The VibeFlow API server your agents connect to. Default is Axiom Cloud. Change this if you're running a self-hosted instance."
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="text"
            value={data.serverUrl}
            onChange={e => onUpdate('serverUrl', e.target.value)}
            style={inputStyle}
          />
          <StatusDot status={data.serverReachable} />
        </div>
        <ActionRow>
          <Btn label="Test Connection" onClick={() => onCommand({ type: 'validateServerUrl', payload: data.serverUrl })} />
        </ActionRow>
      </Card>

      <Card
        title="API Key"
        description="Your authentication token. Generate one from the VibeFlow web UI at Account > API Keys. The key is stored securely in your OS keychain — never in plaintext files."
      >
        <div style={{
          fontFamily: 'var(--vscode-editor-font-family)',
          fontSize: 13,
          color: data.apiKeySet ? 'var(--feed-success)' : 'var(--feed-error)',
        }}>
          {data.apiKeySet ? '●●●●●●●●●●●● (configured)' : 'Not configured'}
        </div>
        <ActionRow>
          <Btn label={data.apiKeySet ? 'Change Key' : 'Set API Key'} onClick={() => onCommand({ type: 'setApiKey', payload: '' })} />
          {data.apiKeySet && <Btn label="Test Key" secondary onClick={() => onCommand({ type: 'validateApiKey', payload: '' })} />}
        </ActionRow>
      </Card>

      <Card
        title="Project"
        description="The VibeFlow project linked to this workspace. Agents, work items, documents, and sessions are all scoped to this project. Auto-detected from your git remote URL on first setup."
      >
        {data.projectName ? (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>{data.projectName}</span>
            <span style={{ fontSize: 11, color: 'var(--feed-muted)' }}>ID: {data.projectId}</span>
          </div>
        ) : (
          <span style={{ fontSize: 13, color: 'var(--feed-muted)' }}>No project selected</span>
        )}
        <select
          value={data.projectId ?? ''}
          onChange={e => {
            const id = parseInt(e.target.value);
            if (!isNaN(id)) { onCommand({ type: 'selectProject', payload: id }); }
          }}
          style={{ ...selectStyle, marginTop: 8 }}
        >
          <option value="">Select a different project...</option>
          {data.projects.map(p => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <ActionRow>
          <Btn label="Refresh List" secondary onClick={() => onCommand({ type: 'refreshProjects' })} />
        </ActionRow>
      </Card>
    </div>
  );
}

/* ── Shared Components ── */

function Card({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div style={{
      padding: '18px 20px',
      borderRadius: 8,
      border: '1px solid var(--feed-border)',
      background: 'var(--vscode-editor-background)',
    }}>
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, letterSpacing: '0.01em' }}>{title}</h3>
      <p style={{ margin: '4px 0 14px', fontSize: 11, color: 'var(--feed-muted)', lineHeight: 1.5 }}>{description}</p>
      {children}
    </div>
  );
}

function ActionRow({ children }: { children: React.ReactNode }) {
  return <div style={{ marginTop: 10, display: 'flex', gap: 6 }}>{children}</div>;
}

function Btn({ label, onClick, secondary }: { label: string; onClick: () => void; secondary?: boolean }) {
  return (
    <button onClick={onClick} style={{
      padding: '5px 12px', fontSize: 11, fontWeight: 500, borderRadius: 4, cursor: 'pointer',
      background: secondary ? 'transparent' : 'var(--feed-button-bg)',
      color: secondary ? 'var(--feed-muted)' : 'var(--feed-button-fg)',
      border: secondary ? '1px solid var(--feed-border)' : 'none',
    }}>{label}</button>
  );
}

function StatusDot({ status }: { status: boolean | null }) {
  if (status === null) { return null; }
  return <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: status ? 'var(--feed-success)' : 'var(--feed-error)', flexShrink: 0, display: 'inline-block' }} title={status ? 'Connected' : 'Failed'} />;
}

const inputStyle: React.CSSProperties = { flex: 1, padding: '7px 10px', fontSize: 12, borderRadius: 4, background: 'var(--feed-input-bg)', border: '1px solid var(--feed-input-border)', color: 'var(--feed-fg)', outline: 'none', fontFamily: 'var(--vscode-editor-font-family)' };
const selectStyle: React.CSSProperties = { width: '100%', padding: '7px 10px', fontSize: 12, borderRadius: 4, background: 'var(--feed-input-bg)', border: '1px solid var(--feed-input-border)', color: 'var(--feed-fg)', outline: 'none' };
