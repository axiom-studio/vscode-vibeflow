import type { SettingsData, SettingsCommand } from './settingsTypes';

interface Props {
  data: SettingsData;
  onUpdate: (key: string, value: unknown) => void;
  onCommand: (cmd: SettingsCommand) => void;
}

export function ConnectionTab({ data, onUpdate, onCommand }: Props) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Server URL */}
      <SettingsCard title="Server URL" description="VibeFlow API server address">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="text"
            value={data.serverUrl}
            onChange={e => onUpdate('serverUrl', e.target.value)}
            style={inputStyle}
          />
          <StatusIndicator status={data.serverReachable} />
        </div>
        <div style={{ marginTop: 8 }}>
          <ActionButton
            label="Test Connection"
            onClick={() => onCommand({ type: 'validateServerUrl', payload: data.serverUrl })}
          />
        </div>
      </SettingsCard>

      {/* API Key */}
      <SettingsCard title="API Key" description="Authentication token from Account > API Keys">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            fontFamily: 'var(--vscode-editor-font-family)',
            fontSize: 13,
            letterSpacing: 2,
            color: data.apiKeySet ? 'var(--feed-success)' : 'var(--feed-error)',
          }}>
            {data.apiKeySet ? '●●●●●●●●●●●● (set)' : 'Not configured'}
          </span>
        </div>
        <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
          <ActionButton
            label={data.apiKeySet ? 'Change Key' : 'Set API Key'}
            onClick={() => onCommand({ type: 'setApiKey', payload: '' })}
          />
          {data.apiKeySet && (
            <ActionButton
              label="Test Key"
              secondary
              onClick={() => onCommand({ type: 'validateApiKey', payload: '' })}
            />
          )}
        </div>
      </SettingsCard>

      {/* Project */}
      <SettingsCard title="Project" description="Connected VibeFlow project for this workspace">
        {data.projectName ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{data.projectName}</span>
            <span style={{ fontSize: 11, color: 'var(--feed-muted)' }}>ID: {data.projectId}</span>
          </div>
        ) : (
          <span style={{ fontSize: 13, color: 'var(--feed-muted)' }}>No project selected</span>
        )}
        <div style={{ marginTop: 8 }}>
          <select
            value={data.projectId ?? ''}
            onChange={e => {
              const id = parseInt(e.target.value);
              if (!isNaN(id)) { onCommand({ type: 'selectProject', payload: id }); }
            }}
            style={selectStyle}
          >
            <option value="">Select project...</option>
            {data.projects.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        <div style={{ marginTop: 6 }}>
          <ActionButton
            label="Refresh Projects"
            secondary
            onClick={() => onCommand({ type: 'refreshProjects' })}
          />
        </div>
      </SettingsCard>
    </div>
  );
}

/* ── Shared Components ── */

function SettingsCard({ title, description, children }: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{
      padding: '16px 18px',
      borderRadius: 8,
      border: '1px solid var(--feed-border)',
      background: 'var(--vscode-editor-background)',
    }}>
      <div style={{ marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{title}</h3>
        <p style={{ margin: '3px 0 0', fontSize: 11, color: 'var(--feed-muted)', lineHeight: 1.4 }}>{description}</p>
      </div>
      {children}
    </div>
  );
}

function ActionButton({ label, onClick, secondary }: {
  label: string;
  onClick: () => void;
  secondary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '5px 12px',
        fontSize: 11,
        fontWeight: 500,
        background: secondary ? 'transparent' : 'var(--feed-button-bg)',
        color: secondary ? 'var(--feed-muted)' : 'var(--feed-button-fg)',
        border: secondary ? '1px solid var(--feed-border)' : 'none',
        borderRadius: 4,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

function StatusIndicator({ status }: { status: boolean | null }) {
  if (status === null) { return null; }
  return (
    <span
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        backgroundColor: status ? 'var(--feed-success)' : 'var(--feed-error)',
        flexShrink: 0,
      }}
      title={status ? 'Connected' : 'Failed'}
    />
  );
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: '7px 10px',
  fontSize: 12,
  borderRadius: 4,
  background: 'var(--feed-input-bg)',
  border: '1px solid var(--feed-input-border)',
  color: 'var(--feed-fg)',
  outline: 'none',
  fontFamily: 'var(--vscode-editor-font-family)',
};

const selectStyle: React.CSSProperties = {
  width: '100%',
  padding: '7px 10px',
  fontSize: 12,
  borderRadius: 4,
  background: 'var(--feed-input-bg)',
  border: '1px solid var(--feed-input-border)',
  color: 'var(--feed-fg)',
  outline: 'none',
};
