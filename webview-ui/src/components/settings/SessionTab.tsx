import type { SettingsData } from './settingsTypes';

interface Props {
  data: SettingsData;
  onUpdate: (key: string, value: unknown) => void;
}

export function SessionTab({ data, onUpdate }: Props) {
  return (
    <div className="space-y-4">
      {/* Worktree */}
      <Section title="Worktree">
        <Field label="Base Directory">
          <input
            type="text"
            value={data.worktreeBaseDir}
            onChange={e => onUpdate('worktreeBaseDir', e.target.value)}
            className="w-full px-2 py-1 text-xs rounded bg-[var(--feed-input-bg)] border border-[var(--feed-input-border)] text-[var(--feed-fg)] outline-none"
          />
        </Field>
        <Toggle label="Auto Create" checked={data.worktreeAutoCreate} onChange={v => onUpdate('worktreeAutoCreate', v)} />
        <Field label="Cleanup on Kill">
          <select
            value={data.worktreeCleanupOnKill}
            onChange={e => onUpdate('worktreeCleanupOnKill', e.target.value)}
            className="w-full px-2 py-1 text-xs rounded bg-[var(--feed-input-bg)] border border-[var(--feed-input-border)] text-[var(--feed-fg)] outline-none"
          >
            <option value="ask">Ask</option>
            <option value="always">Always</option>
            <option value="never">Never</option>
          </select>
        </Field>
      </Section>

      {/* Session */}
      <Section title="Session">
        <Field label="Poll Interval (seconds)">
          <input
            type="number"
            min={1}
            max={300}
            value={data.pollInterval}
            onChange={e => onUpdate('pollInterval', parseInt(e.target.value) || 5)}
            className="w-20 px-2 py-1 text-xs rounded bg-[var(--feed-input-bg)] border border-[var(--feed-input-border)] text-[var(--feed-fg)] outline-none"
          />
        </Field>
        <Field label="View Mode">
          <select
            value={data.viewMode}
            onChange={e => onUpdate('viewMode', e.target.value)}
            className="w-full px-2 py-1 text-xs rounded bg-[var(--feed-input-bg)] border border-[var(--feed-input-border)] text-[var(--feed-fg)] outline-none"
          >
            <option value="flat">Flat</option>
            <option value="grouped">Grouped</option>
          </select>
        </Field>
        <div className="mt-2">
          <Toggle
            label="Skip Permissions"
            checked={data.skipPermissions}
            onChange={v => onUpdate('skipPermissions', v)}
          />
          {data.skipPermissions && (
            <p className="text-[10px] text-[var(--feed-error)] mt-0.5">
              ⚠ Dangerous: agents will auto-approve all tool calls
            </p>
          )}
        </div>
      </Section>

      {/* Notifications */}
      <Section title="Notifications">
        <Toggle label="Agent Prompts" checked={data.notifyAgentPrompts} onChange={v => onUpdate('notifyAgentPrompts', v)} />
        <Toggle label="Work Item Complete" checked={data.notifyWorkComplete} onChange={v => onUpdate('notifyWorkComplete', v)} />
      </Section>

      {/* Error Recovery */}
      <Section title="Error Recovery">
        <Toggle label="Enabled" checked={data.errorRecoveryEnabled} onChange={v => onUpdate('errorRecoveryEnabled', v)} />
        {data.errorRecoveryEnabled && (
          <>
            <Field label="Max Retries">
              <input
                type="number"
                min={1}
                max={50}
                value={data.errorRecoveryMaxRetries}
                onChange={e => onUpdate('errorRecoveryMaxRetries', parseInt(e.target.value) || 10)}
                className="w-20 px-2 py-1 text-xs rounded bg-[var(--feed-input-bg)] border border-[var(--feed-input-border)] text-[var(--feed-fg)] outline-none"
              />
            </Field>
            <Field label="Debounce (seconds)">
              <input
                type="number"
                min={1}
                max={60}
                value={data.errorRecoveryDebounce}
                onChange={e => onUpdate('errorRecoveryDebounce', parseInt(e.target.value) || 5)}
                className="w-20 px-2 py-1 text-xs rounded bg-[var(--feed-input-bg)] border border-[var(--feed-input-border)] text-[var(--feed-fg)] outline-none"
              />
            </Field>
          </>
        )}
      </Section>

      {/* About */}
      <Section title="About">
        <p className="text-[10px] text-[var(--feed-muted)]">
          VibeFlow for VSCode v{data.version}
        </p>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--feed-muted)] mb-1">{title}</h3>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-1.5">
      <label className="block text-[10px] text-[var(--feed-muted)] mb-0.5">{label}</label>
      {children}
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between mt-1.5">
      <span className="text-xs">{label}</span>
      <label className="relative inline-flex items-center cursor-pointer">
        <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="sr-only" />
        <div className={`w-7 h-4 rounded-full transition-colors ${checked ? 'bg-[var(--feed-link)]' : 'bg-[var(--feed-border)]'}`}>
          <div className={`size-3 rounded-full bg-white mt-0.5 transition-transform ${checked ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
        </div>
      </label>
    </div>
  );
}
