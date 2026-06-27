import { useEffect, useRef, useState } from 'react';
import type { SettingsData, SettingsCommand } from './settingsTypes';

interface Props {
  data: SettingsData;
  onUpdate: (key: string, value: unknown) => void;
  onCommand: (cmd: SettingsCommand) => void;
}

export function ConnectionTab({ data, onUpdate, onCommand }: Props) {
  // Refresh-list feedback: track when we asked, and clear once data
  // changes (projects list or last-snapshot identity flips). Without
  // this, "Refresh List" looks dead — the host re-pushes a snapshot
  // silently and the user has no idea anything happened.
  const [refreshing, setRefreshing] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const lastProjectsRef = useRef(data.projects);
  useEffect(() => {
    if (refreshing && data.projects !== lastProjectsRef.current) {
      setRefreshing(false);
      setRefreshedAt(Date.now());
    }
    lastProjectsRef.current = data.projects;
  }, [data.projects, refreshing]);

  const onRefresh = () => {
    setRefreshing(true);
    onCommand({ type: 'refreshProjects' });
    // Safety: if the host doesn't push a new projects array (e.g. same
    // list came back), still drop the spinner after a short delay so
    // the button isn't stuck spinning.
    window.setTimeout(() => {
      setRefreshing(prev => {
        if (prev) { setRefreshedAt(Date.now()); }
        return false;
      });
    }, 1500);
  };

  const copyProjectId = async () => {
    if (data.projectId == null) { return; }
    try { await navigator.clipboard.writeText(String(data.projectId)); } catch { /* clipboard unavailable */ }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <Card
        title="Integration Status"
        description="At-a-glance: is everything wired up?"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <StatusRow label="API Key" value={data.apiKeySet ? 'Configured' : 'Not set'} ok={data.apiKeySet} />
          <StatusRow label="VibeFlow CLI" value={data.cliInstalled ? (data.cliVersion ? `v${data.cliVersion}` : 'Installed') : 'Not installed'} ok={data.cliInstalled} />
          <StatusRow label="MCP Servers" value={`${data.mcpAgents.filter(a => a.enabled).length} / ${data.mcpAgents.length} agents`} ok={data.mcpAgents.some(a => a.enabled)} />
        </div>
      </Card>

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
        description="Your authentication token. Stored securely in your OS keychain — never in plaintext files."
      >
        <div style={{
          fontFamily: 'var(--vscode-editor-font-family)',
          fontSize: 13,
          color: data.apiKeySet ? 'var(--feed-success)' : 'var(--feed-error)',
        }}>
          {data.apiKeySet ? '●●●●●●●●●●●● (configured)' : 'Not configured'}
        </div>

        {!data.apiKeySet && (
          // No key yet — most users land here on first install. Lead with
          // the account-creation step (since most won't have one) and
          // make the destination URL the affordance, not buried in prose.
          <div style={{
            marginTop: 10,
            padding: '10px 12px',
            borderRadius: 6,
            background: 'color-mix(in oklab, var(--feed-link) 8%, transparent)',
            border: '1px solid color-mix(in oklab, var(--feed-link) 22%, transparent)',
            fontSize: 12,
            lineHeight: 1.55,
            color: 'var(--feed-fg)',
          }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Don't have an account yet?</div>
            <div style={{ color: 'var(--feed-muted)', marginBottom: 8 }}>
              Sign up free, then generate an API key under <em>Account → API Keys</em> and paste it here.
            </div>
            <a
              href={data.serverUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '4px 10px',
                fontSize: 11,
                fontWeight: 600,
                background: 'var(--feed-button-bg)',
                color: 'var(--feed-button-fg)',
                borderRadius: 4,
                textDecoration: 'none',
              }}
            >
              Sign up at {prettyHost(data.serverUrl)} ↗
            </a>
          </div>
        )}

        <ActionRow>
          <Btn label={data.apiKeySet ? 'Change Key' : 'Paste API Key'} onClick={() => onCommand({ type: 'setApiKey', payload: '' })} />
          {data.apiKeySet && <Btn label="Test Key" secondary onClick={() => onCommand({ type: 'validateApiKey', payload: '' })} />}
          {data.apiKeySet && (
            <a
              href={data.serverUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                alignSelf: 'center',
                marginLeft: 4,
                fontSize: 11,
                color: 'var(--feed-link)',
                textDecoration: 'none',
              }}
              title={`Manage API keys at ${data.serverUrl}`}
            >
              Manage in dashboard ↗
            </a>
          )}
        </ActionRow>
      </Card>

      <Card
        title="Configure MCP for Coding Agents"
        description="Wire the VibeFlow MCP server into your coding agents so they can read and update VibeFlow work items. Uses the API key and server URL above — no re-entry. Also runs automatically when you install the CLI."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 4 }}>
          {data.mcpAgents.map(a => (
            <div key={a.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <span style={{ width: 12, textAlign: 'center', color: a.enabled ? 'var(--feed-success)' : 'var(--feed-muted)' }}>
                {a.enabled ? '✓' : '—'}
              </span>
              <span style={{ minWidth: 120, color: a.enabled ? 'var(--feed-fg)' : 'var(--feed-muted)' }}>{a.label}</span>
              <span style={{ fontSize: 11, color: 'var(--feed-muted)' }}>{a.enabled ? 'Enabled' : 'Not configured'}</span>
            </div>
          ))}
        </div>
        <ActionRow>
          <Btn
            label="Configure MCP"
            onClick={() => onCommand({ type: 'runCommand', payload: 'vibeflow.bootstrapCli' })}
            disabled={!data.cliInstalled}
          />
          <Btn
            label="Remove MCP Config"
            secondary
            onClick={() => onCommand({ type: 'runCommand', payload: 'vibeflow.uninstallCli' })}
            disabled={!data.cliInstalled || !data.mcpAgents.some(a => a.enabled)}
          />
        </ActionRow>
        {!data.cliInstalled && (
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--feed-muted)' }}>
            Install the VibeFlow CLI (Settings → CLI Interface) to configure or change MCP.
          </div>
        )}
      </Card>

      <Card
        title="Project"
        description="The VibeFlow project linked to this workspace. Agents, work items, documents, and sessions are all scoped to this project. Auto-detected from your git remote URL on first setup."
      >
        {data.projectName ? (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>{data.projectName}</span>
            <button
              onClick={copyProjectId}
              title="Copy project ID"
              style={{
                fontSize: 11,
                fontFamily: 'var(--vscode-editor-font-family)',
                color: 'var(--feed-muted)',
                background: 'transparent',
                border: 'none',
                padding: '1px 4px',
                borderRadius: 3,
                cursor: 'pointer',
              }}
            >
              ID: {data.projectId}
            </button>
          </div>
        ) : (
          <span style={{ fontSize: 13, color: 'var(--feed-muted)' }}>No project selected</span>
        )}
        <select
          value={data.projectId ?? ''}
          onChange={e => {
            const id = parseInt(e.target.value, 10);
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
          <Btn
            label={refreshing ? 'Refreshing…' : 'Refresh List'}
            secondary
            onClick={onRefresh}
            disabled={refreshing}
          />
          {refreshedAt && !refreshing && (
            <span style={{ alignSelf: 'center', fontSize: 11, color: 'var(--feed-muted)' }}>
              Refreshed · {data.projects.length} project{data.projects.length === 1 ? '' : 's'}
            </span>
          )}
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

function Btn({ label, onClick, secondary, disabled }: { label: string; onClick: () => void; secondary?: boolean; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: '5px 12px', fontSize: 11, fontWeight: 500, borderRadius: 4,
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.6 : 1,
      background: secondary ? 'transparent' : 'var(--feed-button-bg)',
      color: secondary ? 'var(--feed-muted)' : 'var(--feed-button-fg)',
      border: secondary ? '1px solid var(--feed-border)' : 'none',
    }}>{label}</button>
  );
}

/**
 * Render the server URL as a friendly host-only label for CTA text
 * (e.g. `https://cloud.axiomstudio.ai/` → `cloud.axiomstudio.ai`). Falls
 * back to the raw string if the URL doesn't parse cleanly.
 */
function prettyHost(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

function StatusRow({ label, value, ok }: { label: string; value: string; ok: boolean | null }) {
  const color = ok === null ? 'var(--feed-muted)' : ok ? 'var(--feed-success)' : 'var(--feed-error)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12 }}>
      <span style={{ color: 'var(--feed-muted)' }}>{label}</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--feed-fg)' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block' }} />
        {value}
      </span>
    </div>
  );
}

function StatusDot({ status }: { status: boolean | null }) {
  if (status === null) { return null; }
  return <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: status ? 'var(--feed-success)' : 'var(--feed-error)', flexShrink: 0, display: 'inline-block' }} title={status ? 'Connected' : 'Failed'} />;
}

const inputStyle: React.CSSProperties = { flex: 1, padding: '7px 10px', fontSize: 12, borderRadius: 4, background: 'var(--feed-input-bg)', border: '1px solid var(--feed-input-border)', color: 'var(--feed-fg)', outline: 'none', fontFamily: 'var(--vscode-editor-font-family)' };
const selectStyle: React.CSSProperties = { width: '100%', padding: '7px 10px', fontSize: 12, borderRadius: 4, background: 'var(--feed-input-bg)', border: '1px solid var(--feed-input-border)', color: 'var(--feed-fg)', outline: 'none' };
