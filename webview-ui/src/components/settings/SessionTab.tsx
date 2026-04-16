import type { SettingsData } from './settingsTypes';

interface Props {
  data: SettingsData;
  onUpdate: (key: string, value: unknown) => void;
}

export function SessionTab({ data, onUpdate }: Props) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Terminal Mode */}
      <Card title="Terminal Mode" desc="Controls how agent terminals appear when launching sessions">
        <RadioGroup
          value={data.sessionTerminalMode ?? 'hybrid'}
          options={[
            { value: 'hybrid', label: 'Hybrid', desc: 'Code agents visible, advisory agents hidden' },
            { value: 'all', label: 'All Visible', desc: 'Every agent terminal shown' },
            { value: 'none', label: 'All Hidden', desc: 'Background only — use Agent Fleet to inspect' },
          ]}
          onChange={v => onUpdate('session.terminalMode', v)}
        />
      </Card>

      {/* Polling */}
      <Card title="Polling Interval" desc="How often to refresh TreeViews and Activity Feed (seconds)">
        <input
          type="number"
          min={5}
          max={300}
          value={data.pollInterval}
          onChange={e => onUpdate('polling.interval', parseInt(e.target.value) || 30)}
          style={inputStyle}
        />
      </Card>

      {/* Notifications */}
      <Card title="Notifications" desc="Control which events show toast notifications">
        <ToggleRow label="Agent Prompts" desc="When an agent needs your input" checked={data.notifyAgentPrompts} onChange={v => onUpdate('notifications.agentPrompts', v)} />
        <ToggleRow label="Work Item Complete" desc="When a todo or issue is finished" checked={data.notifyWorkComplete} onChange={v => onUpdate('notifications.workItemComplete', v)} />
      </Card>

      {/* Worktree */}
      <Card title="Worktrees" desc="Git worktree management settings">
        <label style={{ fontSize: 11, color: 'var(--feed-muted)', display: 'block', marginBottom: 4 }}>Base Directory</label>
        <input
          type="text"
          value={data.worktreeBaseDir}
          onChange={e => onUpdate('worktreeBaseDir', e.target.value)}
          style={{ ...inputStyle, width: '100%' }}
        />
        <div style={{ marginTop: 10 }}>
          <ToggleRow label="Auto Create" desc="Create worktree automatically on branch switch" checked={data.worktreeAutoCreate} onChange={v => onUpdate('worktreeAutoCreate', v)} />
        </div>
        <div style={{ marginTop: 8 }}>
          <label style={{ fontSize: 11, color: 'var(--feed-muted)', display: 'block', marginBottom: 4 }}>Cleanup on Session Kill</label>
          <select
            value={data.worktreeCleanupOnKill}
            onChange={e => onUpdate('worktreeCleanupOnKill', e.target.value)}
            style={{ ...inputStyle, width: '100%' }}
          >
            <option value="ask">Ask</option>
            <option value="always">Always</option>
            <option value="never">Never</option>
          </select>
        </div>
      </Card>

      {/* Advanced */}
      <Card title="Advanced" desc="Debug and development options">
        <ToggleRow label="Simulate Activity Feed" desc="Fill feed with demo data (development only)" checked={data.debugSimulateActivity} onChange={v => onUpdate('debug.simulateActivity', v)} />
        <ToggleRow label="Verbose Logging" desc="Log detailed extension activity to console" checked={data.debugVerboseLogging} onChange={v => onUpdate('debugVerboseLogging', v)} />
      </Card>

      {/* About */}
      <Card title="About" desc="">
        <div style={{ fontSize: 12, color: 'var(--feed-muted)', lineHeight: 1.8 }}>
          <div><strong>VibeFlow for VSCode</strong> v{data.version}</div>
          <div>Multi-persona AI agent orchestration</div>
          <div style={{ marginTop: 6, fontSize: 11 }}>
            <a href="https://cloud.axiomstudio.ai" style={{ color: 'var(--feed-link)', textDecoration: 'none' }}>cloud.axiomstudio.ai</a>
            {' · '}
            <a href="https://bitbucket.org/axiom-studio/vscode-vibeflow" style={{ color: 'var(--feed-link)', textDecoration: 'none' }}>Source</a>
          </div>
        </div>
      </Card>
    </div>
  );
}

/* ── Shared Components ── */

function Card({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div style={{
      padding: '16px 18px',
      borderRadius: 8,
      border: '1px solid var(--feed-border)',
      background: 'var(--vscode-editor-background)',
    }}>
      <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{title}</h3>
      {desc && <p style={{ margin: '3px 0 12px', fontSize: 11, color: 'var(--feed-muted)' }}>{desc}</p>}
      {!desc && <div style={{ height: 8 }} />}
      {children}
    </div>
  );
}

function ToggleRow({ label, desc, checked, onChange }: {
  label: string;
  desc: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '6px 0',
    }}>
      <div>
        <div style={{ fontSize: 12 }}>{label}</div>
        <div style={{ fontSize: 10, color: 'var(--feed-muted)', marginTop: 1 }}>{desc}</div>
      </div>
      <ToggleSwitch checked={checked} onChange={onChange} />
    </div>
  );
}

function RadioGroup({ value, options, onChange }: {
  value: string;
  options: { value: string; label: string; desc: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {options.map(opt => (
        <label
          key={opt.value}
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            padding: '6px 8px',
            borderRadius: 4,
            cursor: 'pointer',
            background: value === opt.value ? 'rgba(127,127,127,0.08)' : 'transparent',
          }}
        >
          <input
            type="radio"
            name="terminalMode"
            checked={value === opt.value}
            onChange={() => onChange(opt.value)}
            style={{ marginTop: 2, accentColor: 'var(--feed-link)' }}
          />
          <div>
            <div style={{ fontSize: 12, fontWeight: 500 }}>{opt.label}</div>
            <div style={{ fontSize: 10, color: 'var(--feed-muted)' }}>{opt.desc}</div>
          </div>
        </label>
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

const inputStyle: React.CSSProperties = {
  padding: '7px 10px',
  fontSize: 12,
  borderRadius: 4,
  background: 'var(--feed-input-bg)',
  border: '1px solid var(--feed-input-border)',
  color: 'var(--feed-fg)',
  outline: 'none',
  fontFamily: 'var(--vscode-editor-font-family)',
  width: 80,
};
