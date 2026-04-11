import type { SettingsData, SettingsCommand } from './settingsTypes';

interface Props {
  data: SettingsData;
  onUpdate: (key: string, value: unknown) => void;
  onCommand: (cmd: SettingsCommand) => void;
}

export function ProvidersTab({ data, onUpdate, onCommand }: Props) {
  return (
    <div className="space-y-3">
      {/* Default provider */}
      <div>
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--feed-muted)] mb-1">Default Provider</h3>
        <select
          value={data.defaultProvider}
          onChange={e => onUpdate('defaultProvider', e.target.value)}
          className="w-full px-2 py-1 text-xs rounded bg-[var(--feed-input-bg)] border border-[var(--feed-input-border)] text-[var(--feed-fg)] outline-none"
        >
          {data.providers.map(p => (
            <option key={p.key} value={p.key}>{p.name}</option>
          ))}
        </select>
      </div>

      {/* Provider cards */}
      {data.providers.map(provider => (
        <div
          key={provider.key}
          className="p-2 rounded border border-[var(--feed-border)] bg-[var(--vscode-editor-background)]"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">{provider.name}</span>
            <div className="flex items-center gap-2">
              <span
                className="inline-block size-2 rounded-full"
                style={{ backgroundColor: provider.available ? 'var(--feed-success)' : 'var(--feed-error)' }}
                title={provider.available ? 'Installed' : 'Not found'}
              />
              <span className="text-[10px] text-[var(--feed-muted)]">
                {provider.binary}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap gap-1 mt-1">
            {provider.vibeflowIntegrated && (
              <span className="px-1.5 py-0.5 text-[9px] rounded bg-[var(--feed-badge-bg)] text-[var(--feed-badge-fg)]">
                VibeFlow integrated
              </span>
            )}
          </div>

          {/* LLM Gateway toggle */}
          <div className="flex items-center justify-between mt-2">
            <span className="text-[10px] text-[var(--feed-muted)]">LLM Gateway</span>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={provider.llmGatewayEnabled}
                onChange={e => onUpdate(`provider.${provider.key}.llmGateway`, e.target.checked)}
                className="sr-only"
              />
              <div className={`w-7 h-4 rounded-full transition-colors ${
                provider.llmGatewayEnabled ? 'bg-[var(--feed-link)]' : 'bg-[var(--feed-border)]'
              }`}>
                <div className={`size-3 rounded-full bg-white mt-0.5 transition-transform ${
                  provider.llmGatewayEnabled ? 'translate-x-3.5' : 'translate-x-0.5'
                }`} />
              </div>
            </label>
          </div>

          {/* Env token (conditional) */}
          {provider.envTokenName && (
            <div className="mt-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-[var(--feed-muted)]">{provider.envTokenName}</span>
                <span className="text-[10px]">
                  {provider.envTokenSet ? '✓ Set' : '✗ Not set'}
                </span>
              </div>
              <button
                onClick={() => {
                  const token = prompt(`Enter ${provider.envTokenName}:`);
                  if (token) {
                    onCommand({ type: 'setProviderToken', payload: { provider: provider.key, token } });
                  }
                }}
                className="mt-1 px-2 py-0.5 text-[10px] rounded bg-[var(--feed-button-bg)] text-[var(--feed-button-fg)] hover:bg-[var(--feed-button-hover)] cursor-pointer border-none"
              >
                {provider.envTokenSet ? 'Change' : 'Set'}
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
