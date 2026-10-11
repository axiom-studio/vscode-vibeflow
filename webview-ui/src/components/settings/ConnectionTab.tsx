import { useState } from 'react';
import type { SettingsData, SettingsCommand } from './settingsTypes';
import { CliSettings } from './CliTab';
import { BufferedTextInput, Btn, ButtonRow, Card, LinkBtn, Status } from './_shared';

/** Outcome of the last Test Connection / Test Key, as reported by the host. */
export interface ConnectionChecks {
  serverUrl?: { url: string; valid: boolean; message?: string };
  apiKey?: { valid: boolean; message?: string };
}

interface Props {
  data: SettingsData;
  checks: ConnectionChecks;
  onUpdate: (key: string, value: unknown) => void;
  onCommand: (cmd: SettingsCommand) => void;
}

/**
 * Connection tab (#4045), in setup order: the account the extension and the
 * CLI talk to, the CLI itself, then MCP wiring for coding agents. Project
 * switching lives in the sidebar dropdown, not here.
 */
export function ConnectionTab({ data, checks, onUpdate, onCommand }: Props) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <AccountCard data={data} checks={checks} onUpdate={onUpdate} onCommand={onCommand} />
      <CliSettings data={data} onUpdate={onUpdate} onCommand={onCommand} />
      <McpCard data={data} onCommand={onCommand} />
    </div>
  );
}

function AccountCard({ data, checks, onUpdate, onCommand }: Props) {
  // The text being edited; saved on Enter/blur. Test Connection saves the
  // typed URL itself, host-side, before probing it (#5772).
  const [draftUrl, setDraftUrl] = useState(data.serverUrl);
  const testServer = () => onCommand({ type: 'validateServerUrl', payload: draftUrl });
  const serverCheck = checks.serverUrl?.url === draftUrl ? checks.serverUrl : undefined;

  return (
    <Card
      title="Account"
      description="The VibeFlow server and API key used by this extension and the VibeFlow CLI. Saving here also updates the CLI's config."
    >
      <Field label="Server URL">
        <div style={{ display: 'flex', gap: 8 }}>
          <BufferedTextInput
            ariaLabel="Server URL"
            initial={data.serverUrl}
            placeholder="https://cloud.axiomstudio.ai"
            onCommit={v => onUpdate('serverUrl', v)}
            onValueChange={setDraftUrl}
          />
          <Btn label="Test Connection" secondary onClick={testServer} />
        </div>
        {serverCheck && (
          <div style={{ marginTop: 6 }}>
            <Status ok={serverCheck.valid}>{serverCheck.valid ? 'Reachable' : (serverCheck.message ?? 'Unreachable')}</Status>
          </div>
        )}
      </Field>

      <Field label="API key">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          <Status ok={data.apiKeySet}>
            {data.apiKeySet ? 'Configured · stored in your OS keychain' : 'Not configured'}
          </Status>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn label={data.apiKeySet ? 'Change Key' : 'Paste API Key'} onClick={() => onCommand({ type: 'setApiKey', payload: '' })} />
            {data.apiKeySet && <Btn label="Test Key" secondary onClick={() => onCommand({ type: 'validateApiKey', payload: '' })} />}
          </div>
        </div>
        {checks.apiKey && (
          <div style={{ marginTop: 6 }}>
            <Status ok={checks.apiKey.valid}>{checks.apiKey.valid ? 'Key works' : (checks.apiKey.message ?? 'Key rejected')}</Status>
          </div>
        )}
        {!data.apiKeySet && (
          <div style={{ marginTop: 10, fontSize: 11, lineHeight: 1.55, color: 'var(--feed-muted)' }}>
            No account yet? Sign up, then create a key under <em>Account → API Keys</em> and paste it here.
            <ButtonRow><LinkBtn href={data.serverUrl} label={`Sign up at ${prettyHost(data.serverUrl)} ↗`} secondary /></ButtonRow>
          </div>
        )}
        {data.apiKeySet && (
          <a href={data.serverUrl} target="_blank" rel="noopener noreferrer"
            style={{ display: 'inline-block', marginTop: 8, fontSize: 11, color: 'var(--feed-link)', textDecoration: 'none' }}>
            Manage API keys on the web ↗
          </a>
        )}
      </Field>
    </Card>
  );
}

function McpCard({ data, onCommand }: Pick<Props, 'data' | 'onCommand'>) {
  const enabled = data.mcpAgents.filter(a => a.enabled).length;
  return (
    <Card
      title="MCP for coding agents"
      description="Lets your coding agents read and update VibeFlow work items, using the account above. Installing the CLI configures this automatically."
    >
      <Status ok={data.mcpAgents.length ? enabled > 0 : null}>
        {enabled} of {data.mcpAgents.length} agents configured
      </Status>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '4px 12px', marginTop: 10 }}>
        {data.mcpAgents.map(a => (
          <div key={a.key} style={{ fontSize: 12, color: a.enabled ? 'var(--feed-fg)' : 'var(--feed-muted)' }}>
            <span style={{ display: 'inline-block', width: 16, color: a.enabled ? 'var(--feed-success)' : 'var(--feed-muted)' }}>{a.enabled ? '✓' : '–'}</span>
            {a.label}
          </div>
        ))}
      </div>
      <ButtonRow>
        <Btn label="Configure MCP" disabled={!data.cliInstalled}
          onClick={() => onCommand({ type: 'runCommand', payload: 'vibeflow.bootstrapCli' })} />
        <Btn label="Remove MCP Config" secondary disabled={!data.cliInstalled || enabled === 0}
          onClick={() => onCommand({ type: 'runCommand', payload: 'vibeflow.uninstallCli' })} />
      </ButtonRow>
      {!data.cliInstalled && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--feed-muted)' }}>Install the VibeFlow CLI above to configure MCP.</div>
      )}
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );
}

/** `https://cloud.axiomstudio.ai/` → `cloud.axiomstudio.ai`; the raw string if it does not parse. */
function prettyHost(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}
