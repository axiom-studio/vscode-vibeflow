import type { SettingsData } from './settingsTypes';
import { Card, ToggleRow } from './_shared';

interface Props {
  data: SettingsData;
  onUpdate: (key: string, value: unknown) => void;
}

export function NotificationsTab({ data, onUpdate }: Props) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
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
    </div>
  );
}
