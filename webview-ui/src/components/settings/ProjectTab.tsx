import { useEffect, useState } from 'react';
import type { ProjectSettingsData } from '../../../../src/core/webviewMessages';
import type { PRReviewPolicy, PRReviewRepositoryPolicy, PRReviewRepositorySummary } from '../../../../src/api/prReviewTypes';
import type { SettingsCommand } from './settingsTypes';
import { Card, ToggleRow, inputStyle } from './_shared';

interface Props {
  data: ProjectSettingsData;
  onCommand: (cmd: SettingsCommand) => void;
}

/** `todo_done` → "Todo done". Event types: axiomcloud database.NotificationEventTypes. */
export function eventLabel(eventType: string): string {
  const words = eventType.split('_');
  return [words[0].charAt(0).toUpperCase() + words[0].slice(1), ...words.slice(1)].join(' ');
}

export interface PolicyForm {
  enabled: boolean;
  mode: 'manual' | 'once' | 'every_update';
  maxRounds: number;
  skipDraft: boolean;
  autoFix: boolean;
  /** 0 turns questions off. */
  questions: number;
}

export function policyToForm(policy: PRReviewPolicy): PolicyForm {
  return {
    enabled: policy.mode !== 'disabled',
    mode: policy.mode === 'once' || policy.mode === 'every_update' ? policy.mode : 'manual',
    maxRounds: policy.max_rounds,
    skipDraft: policy.skip_draft,
    autoFix: policy.auto_fix,
    questions: policy.questions_off ? 0 : (policy.max_questions || 20),
  };
}

/**
 * Form → server policy (PRReviewPolicy.Validate: rounds 1-20, attempts 1-5,
 * questions 0-200). Fields the form does not edit (max_attempts) keep their
 * current value; 0 questions maps to the server's explicit `questions_off`.
 */
export function policyFromForm(form: PolicyForm, current: PRReviewPolicy): PRReviewPolicy {
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n) || lo));
  const questions = clamp(form.questions, 0, 200);
  return {
    ...current,
    mode: form.enabled ? form.mode : 'disabled',
    max_rounds: clamp(form.maxRounds, 1, 20),
    skip_draft: form.skipDraft,
    auto_fix: form.autoFix,
    max_questions: questions,
    questions_off: questions === 0,
  };
}

/**
 * Admin-only Project tab (#4036, design doc #627 §3.3). Shown only when the
 * server says the caller can manage project settings. Integrations stay on
 * the web page, linked at the bottom.
 */
export function ProjectTab({ data, onCommand }: Props) {
  const [notifications, setNotifications] = useState(data.notifications);
  // Adopt every reload from the host (after saves, or someone else's change).
  useEffect(() => { setNotifications(data.notifications); }, [data.notifications]);
  const projectId = data.projectId;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      {data.error && <div style={{ fontSize: 12, color: 'var(--feed-error)' }}>{data.error}</div>}
      <Card
        title="Notifications"
        description={`Which events in ${data.projectName ?? 'this project'} send project notifications (Slack and other configured channels).`}
      >
        {notifications.map(n => (
          <ToggleRow
            key={n.event_type}
            label={eventLabel(n.event_type)}
            desc=""
            checked={n.enabled}
            onChange={v => {
              if (projectId == null) { return; }
              const next = notifications.map(x => (x.event_type === n.event_type ? { ...x, enabled: v } : x));
              setNotifications(next);
              onCommand({ type: 'projectNotificationsSave', payload: { projectId, settings: next } });
            }}
          />
        ))}
      </Card>

      {data.repositories.length === 0 && (
        <Card title="PR reviews" description="No repositories are linked for Vera reviews. Link one under Integrations → Source Control on the web.">
          <span />
        </Card>
      )}
      {data.repositories.map(r => (
        // Keyed on the policy version: a newer version (after a 409 or someone
        // else's save) remounts the form with its values, so a retry can never
        // pair stale form fields with the new version.
        <RepositoryPolicyCard key={`${r.repository.provider}-${r.repository.repository_link_id}-${r.policy?.version ?? 'none'}`} projectId={projectId} repository={r.repository} policy={r.policy} error={r.error} onCommand={onCommand} />
      ))}

      {data.webUrl && (
        <a href={data.webUrl} style={{ fontSize: 12, color: 'var(--feed-link)' }}>
          Integrations and other project settings: open VibeFlow on the web ↗
        </a>
      )}
    </div>
  );
}

function RepositoryPolicyCard({ projectId, repository, policy, error, onCommand }: {
  projectId: number | null;
  repository: PRReviewRepositorySummary;
  policy: PRReviewRepositoryPolicy | null;
  error?: string;
  onCommand: (cmd: SettingsCommand) => void;
}) {
  const [form, setForm] = useState<PolicyForm | null>(policy ? policyToForm(policy.policy) : null);
  const title = `PR reviews · ${repository.repository_name}`;
  if (!policy || !form) {
    return <Card title={title} description={error ?? 'Review settings are unavailable.'}><span /></Card>;
  }
  const set = (patch: Partial<PolicyForm>) => setForm({ ...form, ...patch });
  const disabled = !policy.can_manage || projectId == null;
  return (
    <Card
      title={title}
      description="Vera reviews pull requests on a runner in your VibeFlow CLI. On a public repository, or one that accepts outside contributions, anyone who can comment or open a PR can start a review that runs the PR's code on that runner; keep reviews off there or use an isolated runner."
    >
      <ToggleRow label="Enable PR reviews" desc="Turning this off cancels reviews in progress." checked={form.enabled} onChange={v => set({ enabled: v })} />
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginTop: 8 }}>
        <span style={{ width: 150 }}>Review trigger</span>
        <select aria-label="Review trigger" value={form.mode} disabled={disabled || !form.enabled} onChange={e => set({ mode: e.target.value as PolicyForm['mode'] })} style={inputStyle}>
          <option value="manual">Manual</option>
          <option value="once">Once when ready</option>
          <option value="every_update">Every update</option>
        </select>
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginTop: 8 }}>
        <span style={{ width: 150 }}>Maximum review rounds</span>
        <input aria-label="Maximum review rounds" type="number" min={1} max={20} value={form.maxRounds} disabled={disabled} onChange={e => set({ maxRounds: Number(e.target.value) })} style={inputStyle} />
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginTop: 8 }}>
        <span style={{ width: 150 }}>Questions per PR</span>
        <input aria-label="Questions per PR" type="number" min={0} max={200} value={form.questions} disabled={disabled} onChange={e => set({ questions: Number(e.target.value) })} style={inputStyle} />
        <span style={{ fontSize: 11, color: 'var(--feed-muted)' }}>0 turns questions off</span>
      </label>
      <ToggleRow label="Skip drafts for automatic review" desc="" checked={form.skipDraft} onChange={v => set({ skipDraft: v })} />
      <ToggleRow label="Allow coding agents to fix blockers" desc="A coding session on the PR branch claims repair tickets and pushes one fix; a fresh Vera review verifies it." checked={form.autoFix} onChange={v => set({ autoFix: v })} />
      <div style={{ marginTop: 10 }}>
        <button
          disabled={disabled}
          title={disabled ? 'Only the project owner or an org admin can change review settings.' : ''}
          onClick={() => projectId != null && onCommand({
            type: 'prReviewPolicySave',
            payload: { projectId, provider: repository.provider, repositoryLinkId: repository.repository_link_id, policy: policyFromForm(form, policy.policy), expectedVersion: policy.version },
          })}
          style={{ padding: '5px 14px', fontSize: 12, background: 'var(--feed-button-bg)', color: 'var(--feed-button-fg)', border: 'none', borderRadius: 4, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1 }}
        >Save review settings</button>
      </div>
    </Card>
  );
}
