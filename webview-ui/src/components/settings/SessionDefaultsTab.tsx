import type { SettingsData } from './settingsTypes';
import { Card, RadioGroup, inputStyle } from './_shared';

interface Props {
  data: SettingsData;
  onUpdate: (key: string, value: unknown) => void;
}

export function SessionDefaultsTab({ data, onUpdate }: Props) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <Card
        title="Terminal Mode"
        description="When you launch agent sessions, this controls which terminals are visible in the Terminal panel. Code agents (Developer, Architect, Principal Engineer) modify files — you usually want to watch them. Advisory agents (QA, Security, PM) don't touch code — hiding them reduces clutter."
      >
        <RadioGroup
          name="terminalMode"
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
        title="Chat — Diff View"
        description="How diff code blocks render inside the Session Chat panel. Either style supports an 'Open in Editor' button that opens VSCode's native diff editor for full-fidelity review."
      >
        <RadioGroup
          name="chatDiffView"
          value={data.chatDiffView ?? 'unified'}
          options={[
            { value: 'unified', label: 'Unified (default)', desc: 'Added / removed lines stacked vertically with +/- gutter' },
            { value: 'split', label: 'Split / Side-by-side', desc: 'Before and after in two columns, aligned by hunk' },
          ]}
          onChange={v => onUpdate('chat.diffView', v)}
        />
      </Card>
    </div>
  );
}
