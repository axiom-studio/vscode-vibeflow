import type { SettingsData } from './settingsTypes';
import { Card, ToggleRow } from './_shared';

interface Props {
  data: SettingsData;
  onUpdate: (key: string, value: unknown) => void;
}

export function AdvancedTab({ data, onUpdate }: Props) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
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
    </div>
  );
}
