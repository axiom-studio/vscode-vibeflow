import type { SettingsData } from './settingsTypes';

interface Props {
  data: SettingsData;
  onUpdate: (key: string, value: unknown) => void;
}

export function SessionTab({ data, onUpdate }: Props) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <Card
        title="Terminal Mode"
        description="When you launch agent sessions, this controls which terminals are visible in the Terminal panel. Code agents (Developer, Architect, Principal Engineer) modify files — you usually want to watch them. Advisory agents (QA, Security, PM) don't touch code — hiding them reduces clutter."
      >
        <RadioGroup
          value={data.sessionTerminalMode ?? 'hybrid'}
          options={[
            { value: 'hybrid', label: 'Hybrid (recommended)', desc: 'Code agents visible, advisory agents hidden' },
            { value: 'all', label: 'All Visible', desc: 'Every agent gets a visible terminal tab' },
            { value: 'none', label: 'All Hidden', desc: 'All terminals hidden — use Agent Fleet sidebar to inspect' },
          ]}
          onChange={v => onUpdate('session.terminalMode', v)}
        />
      </Card>

      <Card
        title="Polling Interval"
        description="How often the extension refreshes data from the VibeFlow API. Lower values = more responsive Agent Fleet and Work Items, but more API calls. The Activity Feed has its own 5-second poll regardless of this setting."
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="number"
            min={5}
            max={300}
            value={data.pollInterval}
            onChange={e => onUpdate('polling.interval', parseInt(e.target.value) || 30)}
            style={inputStyle}
          />
          <span style={{ fontSize: 11, color: 'var(--feed-muted)' }}>seconds</span>
        </div>
      </Card>

      <Card
        title="Notifications"
        description="Toast notifications that pop up in the corner of VSCode. Useful for staying aware of agent activity without watching the sidebar constantly."
      >
        <ToggleRow
          label="Agent Prompts"
          desc="Show a notification when an agent asks you a question and is waiting for your response"
          checked={data.notifyAgentPrompts}
          onChange={v => onUpdate('notifications.agentPrompts', v)}
        />
        <ToggleRow
          label="Work Item Complete"
          desc="Show a notification when a todo or issue transitions to done status"
          checked={data.notifyWorkComplete}
          onChange={v => onUpdate('notifications.workItemComplete', v)}
        />
      </Card>

      <Card
        title="Worktrees"
        description="Git worktrees let agents work on different branches in parallel without switching your main working directory. The extension creates worktrees in a subdirectory when agents target a branch different from your current one."
      >
        <label style={{ fontSize: 11, color: 'var(--feed-muted)', display: 'block', marginBottom: 4 }}>Base Directory</label>
        <input
          type="text"
          value={data.worktreeBaseDir}
          onChange={e => onUpdate('worktreeBaseDir', e.target.value)}
          placeholder=".claude/worktrees"
          style={{ ...inputStyle, width: '100%' }}
        />
        <div style={{ marginTop: 12 }}>
          <ToggleRow
            label="Auto Create"
            desc="Automatically create a worktree when launching a session on a branch that doesn't have one"
            checked={data.worktreeAutoCreate}
            onChange={v => onUpdate('worktreeAutoCreate', v)}
          />
        </div>
        <div style={{ marginTop: 8 }}>
          <label style={{ fontSize: 11, color: 'var(--feed-muted)', display: 'block', marginBottom: 4 }}>Cleanup on Session Kill</label>
          <select
            value={data.worktreeCleanupOnKill}
            onChange={e => onUpdate('worktreeCleanupOnKill', e.target.value)}
            style={{ ...inputStyle, width: '100%' }}
          >
            <option value="ask">Ask me each time</option>
            <option value="always">Always delete the worktree</option>
            <option value="never">Keep worktrees after sessions end</option>
          </select>
        </div>
      </Card>

      <Card
        title="Debug & Development"
        description="Options for extension developers and troubleshooting. You normally don't need to change these."
      >
        <ToggleRow
          label="Simulate Activity Feed"
          desc="Fill the Activity Feed with randomly generated demo entries (500 initial + 1 every 3 seconds). Useful for testing the UI without real agent sessions."
          checked={data.debugSimulateActivity}
          onChange={v => onUpdate('debug.simulateActivity', v)}
        />
        <ToggleRow
          label="Verbose Logging"
          desc="Log detailed extension lifecycle events to the Developer Tools console (Help > Toggle Developer Tools)"
          checked={data.debugVerboseLogging}
          onChange={v => onUpdate('debugVerboseLogging', v)}
        />
      </Card>

      <Card title="About" description="">
        <div style={{ fontSize: 12, color: 'var(--feed-muted)', lineHeight: 1.8 }}>
          <div><strong style={{ color: 'var(--feed-fg)' }}>VibeFlow for VSCode</strong> v{data.version}</div>
          <div>Multi-persona AI agent orchestration, project management, and governance.</div>
          <div style={{ marginTop: 8, fontSize: 11 }}>
            <a href="https://cloud.axiomstudio.ai" style={{ color: 'var(--feed-link)', textDecoration: 'none' }}>VibeFlow Cloud</a>
            {' · '}
            <a href="https://bitbucket.org/axiom-studio/vscode-vibeflow" style={{ color: 'var(--feed-link)', textDecoration: 'none' }}>Source Code</a>
            {' · '}
            <span>Apache 2.0 License</span>
          </div>
        </div>
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
      {description && <p style={{ margin: '4px 0 14px', fontSize: 11, color: 'var(--feed-muted)', lineHeight: 1.5 }}>{description}</p>}
      {!description && <div style={{ height: 10 }} />}
      {children}
    </div>
  );
}

function ToggleRow({ label, desc, checked, onChange }: {
  label: string; desc: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '8px 0', gap: 16 }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, fontWeight: 500 }}>{label}</div>
        <div style={{ fontSize: 10, color: 'var(--feed-muted)', marginTop: 2, lineHeight: 1.4 }}>{desc}</div>
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  );
}

function RadioGroup({ value, options, onChange }: {
  value: string; options: { value: string; label: string; desc: string }[]; onChange: (v: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {options.map(opt => (
        <label key={opt.value} style={{
          display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px',
          borderRadius: 6, cursor: 'pointer',
          background: value === opt.value ? 'rgba(127,127,127,0.08)' : 'transparent',
          border: value === opt.value ? '1px solid var(--feed-border)' : '1px solid transparent',
        }}>
          <input type="radio" name="terminalMode" checked={value === opt.value} onChange={() => onChange(opt.value)}
            style={{ marginTop: 2, accentColor: 'var(--feed-link)' }} />
          <div>
            <div style={{ fontSize: 12, fontWeight: 500 }}>{opt.label}</div>
            <div style={{ fontSize: 10, color: 'var(--feed-muted)', marginTop: 1 }}>{opt.desc}</div>
          </div>
        </label>
      ))}
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button role="switch" aria-checked={checked} onClick={() => onChange(!checked)} style={{
      position: 'relative', width: 36, height: 20, borderRadius: 10, border: 'none', flexShrink: 0,
      background: checked ? 'var(--feed-link)' : 'var(--feed-border)', cursor: 'pointer',
      transition: 'background 150ms', padding: 0,
    }}>
      <span style={{
        position: 'absolute', top: 2, left: checked ? 18 : 2, width: 16, height: 16,
        borderRadius: '50%', background: 'white', transition: 'left 150ms',
        boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
      }} />
    </button>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '7px 10px', fontSize: 12, borderRadius: 4,
  background: 'var(--feed-input-bg)', border: '1px solid var(--feed-input-border)',
  color: 'var(--feed-fg)', outline: 'none', fontFamily: 'var(--vscode-editor-font-family)', width: 80,
};
