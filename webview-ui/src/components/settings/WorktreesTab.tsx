import type { SettingsData } from './settingsTypes';
import { Card, ToggleRow, inputStyle } from './_shared';

interface Props {
  data: SettingsData;
  onUpdate: (key: string, value: unknown) => void;
}

export function WorktreesTab({ data, onUpdate }: Props) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <Card
        title="Worktrees"
        description="Git worktrees let agents work on different branches in parallel without switching your main working directory. The extension creates worktrees in a subdirectory when agents target a branch different from your current one."
      >
        <label style={{ fontSize: 11, color: 'var(--feed-muted)', display: 'block', marginBottom: 4 }}>Base Directory</label>
        <input
          type="text"
          value={data.worktreeBaseDir}
          onChange={e => onUpdate('worktree.baseDir', e.target.value)}
          placeholder=".claude/worktrees"
          style={{ ...inputStyle, width: '100%' }}
        />
        <div style={{ marginTop: 12 }}>
          <ToggleRow
            label="Auto Create"
            desc="Automatically create a worktree when launching a session on a branch that doesn't have one"
            checked={data.worktreeAutoCreate}
            onChange={v => onUpdate('worktree.autoCreate', v)}
          />
        </div>
        <div style={{ marginTop: 8 }}>
          <label style={{ fontSize: 11, color: 'var(--feed-muted)', display: 'block', marginBottom: 4 }}>Cleanup on Session Kill</label>
          <select
            value={data.worktreeCleanupOnKill}
            onChange={e => onUpdate('worktree.cleanupOnKill', e.target.value)}
            style={{ ...inputStyle, width: '100%' }}
          >
            <option value="ask">Ask me each time</option>
            <option value="always">Always delete the worktree</option>
            <option value="never">Keep worktrees after sessions end</option>
          </select>
        </div>
      </Card>
    </div>
  );
}
