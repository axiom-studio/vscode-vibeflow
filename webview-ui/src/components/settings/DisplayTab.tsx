import type { SettingsData } from './settingsTypes';
import { Card, RadioGroup, ToggleRow, inputStyle } from './_shared';

interface Props {
  data: SettingsData;
  onUpdate: (key: string, value: unknown) => void;
}

/**
 * Display settings (#4034): how the extension refreshes, renders chat diffs
 * and notifies. The launch-era Terminal Mode and Headless Backing settings
 * were removed with the CLI-first direction (design doc #627 D2).
 */
export function DisplayTab({ data, onUpdate }: Props) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <Card
        title="Refresh rate"
        description="How often the extension refreshes from the VibeFlow API. The live tier (Activity Feed, open session chats & work-item panels, brainstorms) polls faster; background views (trees, status bar, dashboard, compliance, tickets) poll slower. Both pause while the window is unfocused."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 92, fontSize: 12 }}>Live</span>
            <input
              type="number"
              min={2}
              max={60}
              value={data.liveInterval}
              onChange={e => onUpdate('polling.liveInterval', parseInt(e.target.value) || 5)}
              style={inputStyle}
            />
            <span style={{ fontSize: 11, color: 'var(--feed-muted)' }}>seconds</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 92, fontSize: 12 }}>Background</span>
            <input
              type="number"
              min={5}
              max={300}
              value={data.pollInterval}
              onChange={e => onUpdate('polling.interval', parseInt(e.target.value) || 30)}
              style={inputStyle}
            />
            <span style={{ fontSize: 11, color: 'var(--feed-muted)' }}>seconds</span>
          </label>
        </div>
      </Card>

      <Card
        title="Chat — Diff View"
        description="How diff code blocks render inside the Session Chat panel. Either style supports an 'Open in Editor' button that opens VS Code's native diff editor for full-fidelity review."
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
      <Card
        title="Notifications"
        description="Toast notifications that pop up in the corner of VS Code. Useful for staying aware of agent activity without watching the sidebar constantly."
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
    </div>
  );
}
