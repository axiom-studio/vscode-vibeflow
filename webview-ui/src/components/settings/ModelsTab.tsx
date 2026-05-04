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
  const provider = data.defaultProvider || 'claude';
  const knownModels = data.knownModels?.[provider] ?? [];
  const stickyModels = data.stickyModels ?? {};

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <Card
        title="Sticky Models"
        description={
          `Each persona remembers its last-used model so re-launching an agent picks up where you left off. Models shown are for your current default provider (${provider}). Change the default provider in the Providers tab to manage models for a different one.`
        }
      >
        {knownModels.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--feed-muted)', fontStyle: 'italic' }}>
            No models known for provider <code>{provider}</code>. Set a different default provider on the Providers tab.
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
