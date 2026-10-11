import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { PRReviewView, cycleStep } from './PRReviewView';
import { getVsCodeApi } from '../vscodeApi';
import type { PRReviewFinding, PRReviewSummary } from '../../../src/api/prReviewTypes';

/**
 * #4040 — the Vera review panel. Pins: load on mount, the header/state/meta,
 * findings ordered blockers first, jump-to-code intent, and that Vera's
 * untrusted text never renders as raw HTML.
 */

function finding(overrides: Partial<PRReviewFinding> = {}): PRReviewFinding {
  return {
    id: 'f1', job_id: 'j', key: 'k', title: 'Resolve relative roots', severity: 'blocker', path: 'src/commands/cliCommands.ts', line: 38,
    trigger: 'Open CLI with no folder.', impact: 'Misses the running CLI.', evidence: 'cliPidLockPath uses process.cwd().', verification: 'Probe ran.',
    state: 'present', head_sha: 'h', base_sha: 'b', created_at: 0, updated_at: 0, repair_issue_id: 5743, ...overrides,
  };
}

const summary = {
  review: {
    id: 'j', number: 2, head_sha: '0c5467744d85', base_sha: '1911fa560aed', rounds_started: 1, round_limit: 4, state: 'changes_requested',
    details: { title: 'fix(cli): check the PID lock', url: 'https://github.com/o/r/pull/2', head_ref: 'fix/cli-pid-lock-root', base_ref: 'main', head_repository_id: '', head_repository_name: 'o/r', head_clone_url: '', base_repository_name: 'axiom-studio/vscode-vibeflow' },
  },
  summary: 'Changes requested.\n\n<img src=x onerror=alert(1)>',
  unresolved_blockers: 1, questions_asked: 0, question_limit: 20,
  runner: { user_id: 0, state: 'online', name: 'vera-mac', reason: '', checked_at: 0, last_seen_at: 0 },
  actions: {
    review: { allowed: false, reason: 'A review is already queued or running' },
    pause: { allowed: true, reason: '' },
    resume: { allowed: true, reason: '', minimum_additional_rounds: 1 },
    dismiss: { allowed: true, reason: '' },
    reopen: { allowed: true, reason: '' },
  },
} as unknown as PRReviewSummary;

function push(findings: PRReviewFinding[], label = 'Fixes queued') {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'prReviewData',
        payload: { summary, findings, findingsTruncated: false, display: { label, tone: 'info', description: 'Repair tickets are waiting.' }, generatedAt: '' },
      },
    }));
  });
}

describe('cycleStep', () => {
  it('highlights the step the review is in', () => {
    expect(cycleStep('Reviewing')).toBe(0);
    expect(cycleStep('Fixes queued')).toBe(1);
    expect(cycleStep('Verifying fixes')).toBe(2);
    expect(cycleStep('Reviewed')).toBe(-1);
  });
});

describe('PRReviewView', () => {
  it('requests the review on mount', () => {
    const spy = vi.spyOn(getVsCodeApi(), 'postMessage');
    render(<PRReviewView />);
    expect(spy).toHaveBeenCalledWith({ type: 'prReviewLoad' });
    spy.mockRestore();
  });

  it('shows the PR, its state and rounds, with blockers before advisories', () => {
    render(<PRReviewView />);
    push([finding({ id: 'a', severity: 'advisory', title: 'Advisory one' }), finding()]);
    expect(screen.getByText('#2: fix(cli): check the PID lock')).toBeTruthy();
    expect(screen.getByText('Fixes queued')).toBeTruthy();
    expect(screen.getByText('1 of 4 used')).toBeTruthy();
    const titles = screen.getAllByText(/Resolve relative roots|Advisory one/).map(e => e.textContent);
    expect(titles).toEqual(['Resolve relative roots', 'Advisory one']);
  });

  it('asks the host to open a finding at its line', () => {
    const spy = vi.spyOn(getVsCodeApi(), 'postMessage');
    render(<PRReviewView />);
    push([finding()]);
    fireEvent.click(screen.getByText('src/commands/cliCommands.ts:38'));
    expect(spy).toHaveBeenCalledWith({ type: 'prReviewOpenLocation', payload: { path: 'src/commands/cliCommands.ts', line: 38 } });
    spy.mockRestore();
  });

  it('never renders raw HTML from Vera\'s summary', () => {
    const { container } = render(<PRReviewView />);
    push([]);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('No findings.')).toBeTruthy();
  });
});

describe('PRReviewView controls (#4041)', () => {
  it('disables a control the server refuses and shows its reason', () => {
    render(<PRReviewView />);
    push([]);
    const rerun = screen.getByText('Re-run review') as HTMLButtonElement;
    expect(rerun.disabled).toBe(true);
    expect(rerun.title).toBe('A review is already queued or running');
  });

  it('continues with the rounds and reason the user enters', () => {
    const spy = vi.spyOn(getVsCodeApi(), 'postMessage');
    render(<PRReviewView />);
    push([]);
    fireEvent.click(screen.getByText('Continue'));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Ready for another pass' } });
    fireEvent.click(screen.getByText('Submit'));
    expect(spy).toHaveBeenCalledWith({ type: 'prReviewControl', snapshot: '', payload: { action: 'resume', additionalRounds: 1, reason: 'Ready for another pass' } });
    spy.mockRestore();
  });

  it('requires evidence to reopen a dismissed finding', () => {
    const spy = vi.spyOn(getVsCodeApi(), 'postMessage');
    render(<PRReviewView />);
    push([finding({ state: 'dismissed' })]);
    fireEvent.click(screen.getByText('Reopen with evidence'));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Still reproduces' } });
    expect((screen.getByText('Submit') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Evidence'), { target: { value: 'Ran it again on head' } });
    fireEvent.click(screen.getByText('Submit'));
    expect(spy).toHaveBeenCalledWith({ type: 'prReviewFindingControl', snapshot: '', payload: { findingId: 'f1', action: 'reopen', reason: 'Still reproduces', evidence: 'Ran it again on head' } });
    spy.mockRestore();
  });
});
