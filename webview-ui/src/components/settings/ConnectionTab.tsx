import type { SettingsData, SettingsCommand } from './settingsTypes';

interface Props {
  data: SettingsData;
  onUpdate: (key: string, value: unknown) => void;
  onCommand: (cmd: SettingsCommand) => void;
}

export function ConnectionTab({ data, onUpdate, onCommand }: Props) {
  return (
    <div className="space-y-4">
      {/* Server URL */}
      <Section title="Server URL">
        <div className="flex gap-2">
          <input
            type="text"
            value={data.serverUrl}
            onChange={e => onUpdate('serverUrl', e.target.value)}
            className="flex-1 px-2 py-1 text-xs rounded bg-[var(--feed-input-bg)] border border-[var(--feed-input-border)] text-[var(--feed-fg)] outline-none"
          />
          <StatusDot status={data.serverReachable} />
        </div>
        <button
          onClick={() => onCommand({ type: 'validateServerUrl', payload: data.serverUrl })}
          className="mt-1 px-2 py-0.5 text-[10px] rounded bg-[var(--feed-button-bg)] text-[var(--feed-button-fg)] hover:bg-[var(--feed-button-hover)] cursor-pointer border-none"
        >
          Test Connection
        </button>
      </Section>

      {/* API Key */}
      <Section title="API Key">
        <div className="flex items-center gap-2">
          <span className="text-xs">
            {data.apiKeySet ? '••••••••••' : 'Not set'}
          </span>
          <StatusDot status={data.apiKeyValid} />
        </div>
        <div className="flex gap-1 mt-1">
          <button
            onClick={() => onCommand({ type: 'setApiKey', payload: '' })}
            className="px-2 py-0.5 text-[10px] rounded bg-[var(--feed-button-bg)] text-[var(--feed-button-fg)] hover:bg-[var(--feed-button-hover)] cursor-pointer border-none"
          >
            {data.apiKeySet ? 'Change' : 'Set Key'}
          </button>
          {data.apiKeySet && (
            <button
              onClick={() => onCommand({ type: 'validateApiKey', payload: '' })}
              className="px-2 py-0.5 text-[10px] rounded bg-[var(--feed-button-bg)] text-[var(--feed-button-fg)] hover:bg-[var(--feed-button-hover)] cursor-pointer border-none"
            >
              Test
            </button>
          )}
        </div>
      </Section>

      {/* Project */}
      <Section title="Project">
        {data.projectName ? (
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium">{data.projectName}</span>
            <span className="text-[10px] text-[var(--feed-muted)]">ID: {data.projectId}</span>
          </div>
        ) : (
          <span className="text-xs text-[var(--feed-muted)]">No project selected</span>
        )}
        <div className="mt-1">
          <select
            value={data.projectId ?? ''}
            onChange={e => {
              const id = parseInt(e.target.value);
              if (!isNaN(id)) { onCommand({ type: 'selectProject', payload: id }); }
            }}
            className="w-full px-2 py-1 text-xs rounded bg-[var(--feed-input-bg)] border border-[var(--feed-input-border)] text-[var(--feed-fg)] outline-none"
          >
            <option value="">Select project...</option>
            {data.projects.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <button
            onClick={() => onCommand({ type: 'refreshProjects' })}
            className="mt-1 px-2 py-0.5 text-[10px] rounded bg-[var(--feed-button-bg)] text-[var(--feed-button-fg)] hover:bg-[var(--feed-button-hover)] cursor-pointer border-none"
          >
            Refresh
          </button>
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--feed-muted)] mb-1">{title}</h3>
      {children}
    </div>
  );
}

function StatusDot({ status }: { status: boolean | null }) {
  if (status === null) { return null; }
  return (
    <span
      className="inline-block size-2 rounded-full shrink-0"
      style={{ backgroundColor: status ? 'var(--feed-success)' : 'var(--feed-error)' }}
      title={status ? 'OK' : 'Failed'}
    />
  );
}
