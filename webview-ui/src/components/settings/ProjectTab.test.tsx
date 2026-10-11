import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ProjectTab, eventLabel, policyFromForm, policyToForm } from './ProjectTab';
import type { SettingsCommand } from './settingsTypes';
import type { ProjectSettingsData } from '../../../../src/core/webviewMessages';
import type { PRReviewPolicy } from '../../../../src/api/prReviewTypes';

// Shapes from axiomcloud: GetProjectNotificationSettings rows and
// PRReviewRepositoryPolicy + can_manage (#4036).
const policy: PRReviewPolicy = { mode: 'manual', max_rounds: 4, max_attempts: 3, skip_draft: true, auto_fix: true };

function data(overrides: Partial<ProjectSettingsData> = {}): ProjectSettingsData {
  return {
    canManage: true,
    projectId: 28,
    projectName: 'vscode-vibeflow',
    webUrl: 'https://cloud.example.com/ai/vibeflow?project=28',
    notifications: [{ event_type: 'todo_done', enabled: false }, { event_type: 'issue_created', enabled: true }],
    repositories: [{
      repository: { provider: 'github', provider_host: 'github.com', repository_link_id: 46, repository_name: 'axiom-studio/vscode-vibeflow', webhook_configured: true },
      policy: { provider: 'github', repository_link_id: 46, policy, version: 7, updated_by: 2, updated_at: 0, preferred_runner_id: '', can_manage: true },
    }],
    ...overrides,
  };
}

describe('policy form mapping', () => {
  it('round-trips a policy and keeps fields the form does not edit', () => {
    expect(policyFromForm(policyToForm(policy), policy)).toEqual({ ...policy, max_questions: 20, questions_off: false });
  });

  it('turns questions off at 0 and clamps to the server limits', () => {
    const form = { ...policyToForm(policy), questions: 0, maxRounds: 99 };
    expect(policyFromForm(form, policy)).toMatchObject({ questions_off: true, max_questions: 0, max_rounds: 20 });
    expect(policyFromForm({ ...form, maxRounds: 0, questions: 500 }, policy)).toMatchObject({ max_rounds: 1, max_questions: 200 });
  });

  it('maps "enabled off" to the disabled mode', () => {
    expect(policyFromForm({ ...policyToForm(policy), enabled: false, mode: 'every_update' }, policy).mode).toBe('disabled');
  });

  it('labels notification events readably', () => {
    expect(eventLabel('todo_done')).toBe('Todo done');
    expect(eventLabel('project_archived')).toBe('Project archived');
  });
});

describe('ProjectTab', () => {
  it('saves the full notification list when one toggle changes', () => {
    const sent: SettingsCommand[] = [];
    render(<ProjectTab data={data()} onCommand={c => { sent.push(c); }} />);
    fireEvent.click(screen.getAllByRole('switch')[0]);
    expect(sent).toContainEqual({
      type: 'projectNotificationsSave',
      payload: [{ event_type: 'todo_done', enabled: true }, { event_type: 'issue_created', enabled: true }],
    });
  });

  it('saves a repository policy with its version for the server\'s compare-and-swap', () => {
    const sent: SettingsCommand[] = [];
    render(<ProjectTab data={data()} onCommand={c => { sent.push(c); }} />);
    fireEvent.change(screen.getByLabelText('Maximum review rounds'), { target: { value: '6' } });
    fireEvent.click(screen.getByText('Save review settings'));
    expect(sent).toContainEqual({
      type: 'prReviewPolicySave',
      payload: { provider: 'github', repositoryLinkId: 46, policy: { ...policy, max_rounds: 6, max_questions: 20, questions_off: false }, expectedVersion: 7 },
    });
  });

  it('explains when no repository is linked for reviews', () => {
    render(<ProjectTab data={data({ repositories: [] })} onCommand={() => {}} />);
    expect(screen.getByText(/No repositories are linked for Vera reviews/)).toBeTruthy();
  });
});
