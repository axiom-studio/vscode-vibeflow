import { useState } from 'react';
import type { SettingsData, SettingsCommand } from './settingsTypes';

interface Props {
  data: SettingsData;
  onCommand: (cmd: SettingsCommand) => void;
}

/**
 * Display order matches the backend persona registry — code agents
 * first (most-used in development workflows), then review/QA, then
 * product/design, then external. Keep in sync with
 * src/sessions/personas.ts PERSONA_DISPLAY_NAMES.
 */
const PERSONAS: { key: string; name: string; tier: string }[] = [
  { key: 'developer',          name: 'Developer',          tier: 'Engineering' },
  { key: 'architect',          name: 'Architect',          tier: 'Engineering' },
  { key: 'principal_engineer', name: 'Principal Engineer', tier: 'Engineering' },
  { key: 'security_lead',      name: 'Security Lead',      tier: 'Review' },
  { key: 'qa_lead',            name: 'QA Lead',            tier: 'Review' },
  { key: 'product_manager',    name: 'Product Manager',    tier: 'Product' },
  { key: 'project_manager',    name: 'Project Manager',    tier: 'Product' },
  { key: 'ux_designer',        name: 'UX Designer',        tier: 'Product' },
  { key: 'customer',           name: 'Customer',           tier: 'External' },
];

export function ModelsTab({ data, onCommand }: Props) {
  // Tab-scoped provider picker. Defaults to the user's default
  // provider but decouples from it, so the user can browse and pin
  // models from a different provider without switching their global
  // launch default. Stored sticky models are per-persona regardless of
  // provider — see (custom) handling below for cross-provider pins.
  const knownProviders = Object.keys(data.knownModels ?? {});
  const [provider, setProvider] = useState<string>(data.defaultProvider || knownProviders[0] || 'claude');
  const knownModels = data.knownModels?.[provider] ?? [];
  const stickyModels = data.stickyModels ?? {};

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <Card
        title="Sticky Models"
        description="Each persona remembers its last-used model so re-launching an agent picks up where you left off. Pick a provider below to browse its models; pins from other providers stay visible as “(custom)” on each persona row."
      >
        {/* Provider picker scoped to this tab. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <span style={{ fontSize: 12, color: 'var(--feed-muted)' }}>Showing models for</span>
          <select
            value={provider}
            onChange={e => setProvider(e.target.value)}
            style={{
              padding: '4px 8px',
              fontSize: 12,
              background: 'var(--vscode-input-background)',
              color: 'var(--vscode-input-foreground)',
              border: '1px solid var(--vscode-input-border, var(--feed-border))',
              borderRadius: 3,
            }}
          >
            {(knownProviders.length ? knownProviders : [provider]).map(p => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          {provider !== data.defaultProvider && (
            <span style={{ fontSize: 10.5, color: 'var(--feed-muted)' }}>
              (Launch default is <code>{data.defaultProvider}</code>)
            </span>
          )}
        </div>

        {knownModels.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--feed-muted)', fontStyle: 'italic' }}>
            No models known for provider <code>{provider}</code>.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {PERSONAS.map(p => (
              <div
                key={p.key}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '160px 1fr auto',
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{p.name}</span>
                  <span style={{ fontSize: 10, color: 'var(--feed-muted)' }}>{p.tier}</span>
                </div>
                <select
                  value={stickyModels[p.key] ?? ''}
                  onChange={e => onCommand({
                    type: 'updateStickyModel',
                    payload: { persona: p.key, model: e.target.value },
                  })}
                  style={{
                    flex: 1,
                    padding: '4px 8px',
                    fontSize: 12,
                    background: 'var(--vscode-input-background)',
                    color: 'var(--vscode-input-foreground)',
                    border: '1px solid var(--vscode-input-border, var(--feed-border))',
                    borderRadius: 3,
                  }}
                >
                  {/* Allow the current value through even if it's not in the
                      known set — protects against drift between front-end
                      KNOWN_MODELS and what the user already has saved. */}
                  {stickyModels[p.key] && !knownModels.includes(stickyModels[p.key]) && (
                    <option value={stickyModels[p.key]}>{stickyModels[p.key]} (custom)</option>
                  )}
                  {knownModels.map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                <button
                  onClick={() => onCommand({
                    type: 'resetStickyModel',
                    payload: { persona: p.key },
                  })}
                  title="Reset to default"
                  style={{
                    padding: '4px 10px',
                    fontSize: 11,
                    background: 'transparent',
                    color: 'var(--feed-muted)',
                    border: '1px solid var(--feed-border)',
                    borderRadius: 3,
                    cursor: 'pointer',
                  }}
                >
                  Reset
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function Card({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div style={{
      padding: '18px 20px',
      borderRadius: 8,
      border: '1px solid var(--feed-border)',
      background: 'var(--vscode-editor-background)',
    }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 12, color: 'var(--feed-muted)', lineHeight: 1.5, marginBottom: 14 }}>
        {description}
      </div>
      {children}
    </div>
  );
}
