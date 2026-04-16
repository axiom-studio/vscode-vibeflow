import type { SettingsData, SettingsCommand } from './settingsTypes';

interface Props {
  data: SettingsData;
  onUpdate: (key: string, value: unknown) => void;
  onCommand: (cmd: SettingsCommand) => void;
}

export function ProvidersTab({ data, onUpdate, onCommand }: Props) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Default Provider */}
      <div style={{
        padding: '14px 16px',
        borderRadius: 8,
        border: '1px solid var(--feed-border)',
        background: 'var(--vscode-editor-background)',
      }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 14, fontWeight: 600 }}>Default Provider</h3>
        <select
          value={data.defaultProvider}
          onChange={e => onUpdate('defaultProvider', e.target.value)}
          style={{
            width: '100%',
            padding: '7px 10px',
            fontSize: 12,
            borderRadius: 4,
            background: 'var(--feed-input-bg)',
            border: '1px solid var(--feed-input-border)',
            color: 'var(--feed-fg)',
            outline: 'none',
          }}
        >
          {data.providers.map(p => (
            <option key={p.key} value={p.key}>{p.name}</option>
          ))}
        </select>
      </div>

      {/* Provider Cards */}
      {data.providers.map(provider => (
        <div
          key={provider.key}
          style={{
            padding: '16px 18px',
            borderRadius: 8,
            border: '1px solid var(--feed-border)',
            background: 'var(--vscode-editor-background)',
          }}
        >
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{provider.name}</span>
              {provider.vibeflowIntegrated && (
                <span style={{
                  fontSize: 9,
                  padding: '2px 6px',
                  borderRadius: 3,
                  background: 'rgba(79, 193, 255, 0.15)',
                  color: '#4fc1ff',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                }}>
                  VibeFlow
                </span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                display: 'inline-block',
                background: provider.available ? 'var(--feed-success)' : 'var(--feed-error)',
              }} />
              <span style={{ fontSize: 11, color: 'var(--feed-muted)', fontFamily: 'var(--vscode-editor-font-family)' }}>
                {provider.binary}
              </span>
            </div>
          </div>

          {/* LLM Gateway */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 0',
            borderTop: '1px solid var(--feed-border)',
          }}>
            <div>
              <span style={{ fontSize: 12 }}>LLM Gateway</span>
              <span style={{ fontSize: 10, color: 'var(--feed-muted)', marginLeft: 6 }}>Route through Axiom proxy</span>
            </div>
            <ToggleSwitch
              checked={provider.llmGatewayEnabled}
              onChange={v => onUpdate(`provider.${provider.key}.llmGateway`, v)}
            />
          </div>

          {/* Env Token */}
          {provider.envTokenName && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '8px 0',
              borderTop: '1px solid var(--feed-border)',
            }}>
              <div>
                <span style={{ fontSize: 12, fontFamily: 'var(--vscode-editor-font-family)' }}>{provider.envTokenName}</span>
                <span style={{
                  marginLeft: 8,
                  fontSize: 10,
                  color: provider.envTokenSet ? 'var(--feed-success)' : 'var(--feed-error)',
                }}>
                  {provider.envTokenSet ? '● Set' : '○ Not set'}
                </span>
              </div>
              <button
                onClick={() => onCommand({ type: 'setProviderToken', payload: { provider: provider.key, token: '' } })}
                style={{
                  padding: '4px 10px',
                  fontSize: 11,
                  background: 'var(--feed-button-bg)',
                  color: 'var(--feed-button-fg)',
                  border: 'none',
                  borderRadius: 3,
                  cursor: 'pointer',
                }}
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

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      style={{
        position: 'relative',
        width: 36,
        height: 20,
        borderRadius: 10,
        border: 'none',
        background: checked ? 'var(--feed-link)' : 'var(--feed-border)',
        cursor: 'pointer',
        transition: 'background 150ms',
        padding: 0,
        flexShrink: 0,
      }}
    >
      <span style={{
        position: 'absolute',
        top: 2,
        left: checked ? 18 : 2,
        width: 16,
        height: 16,
        borderRadius: '50%',
        background: 'white',
        transition: 'left 150ms',
        boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
      }} />
    </button>
  );
}
