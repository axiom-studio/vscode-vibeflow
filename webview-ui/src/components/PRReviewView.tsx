import { useEffect, useState, type CSSProperties } from 'react';
import { getVsCodeApi } from '../vscodeApi';
import { MarkdownRenderer } from './MarkdownRenderer';
import type { PRReviewPageClientMessage, PRReviewPageHostMessage } from '../../../src/core/webviewMessages';
import type { PRReviewActionName, PRReviewFinding, PRReviewSummary } from '../../../src/api/prReviewTypes';

const vscode = getVsCodeApi() as { postMessage: (msg: PRReviewPageClientMessage) => void };

type Data = Extract<PRReviewPageHostMessage, { type: 'prReviewData' }>['payload'];

const TONE_COLOR: Record<Data['display']['tone'], string> = {
  success: 'var(--feed-success)',
  warning: 'var(--vscode-editorWarning-foreground, #cca700)',
  info: 'var(--feed-link)',
  muted: 'var(--feed-muted)',
};
// Labels as the web review panel shows them (PRReviewPanel.jsx).
const FINDING_STATES: Record<string, string> = { present: 'Present', uncertain: 'Uncertain', fixed: 'Verified fixed', dismissed: 'Dismissed' };
const CYCLE = ['Vera review', 'Coder repairs', 'Fresh verification'] as const;

const card: CSSProperties = { border: '1px solid var(--feed-border)', borderRadius: 6, padding: '12px 14px', marginBottom: 12 };
const label: CSSProperties = { fontSize: 10.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--feed-muted)' };
const button: CSSProperties = { padding: '5px 14px', fontSize: 12, background: 'var(--feed-button-bg)', color: 'var(--feed-button-fg)', border: 'none', borderRadius: 4, cursor: 'pointer' };
const linkButton: CSSProperties = { background: 'none', border: 'none', padding: 0, color: 'var(--feed-link)', cursor: 'pointer', fontFamily: 'var(--vscode-editor-font-family)', fontSize: 12 };

type Form =
  | { kind: 'pause' }
  | { kind: 'resume'; minimumRounds: number }
  | { kind: 'dismiss'; findingId: string }
  | { kind: 'reopen'; findingId: string };

/** Which cycle step is active for a display label; -1 when none is. */
export function cycleStep(displayLabel: string): number {
  if (displayLabel === 'Reviewing' || displayLabel === 'Waiting for runner') { return 0; }
  if (displayLabel === 'Fixes queued' || displayLabel === 'Fixing') { return 1; }
  if (displayLabel === 'Verifying fixes') { return 2; }
  return -1;
}

/**
 * Vera review panel (#4040). Presentational: the host loads the summary and
 * findings and pushes them. Vera's text is untrusted and goes through the
 * shared MarkdownRenderer (react-markdown: no raw HTML). A finding's location
 * is sent to the host, which opens it only inside the workspace.
 */
export function PRReviewView() {
  const [data, setData] = useState<Data | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [form, setForm] = useState<Form | undefined>();

  useEffect(() => {
    const handle = (event: MessageEvent<PRReviewPageHostMessage>) => {
      const msg = event.data;
      if (msg.type === 'prReviewData') { setData(msg.payload); setError(undefined); setForm(undefined); }
      if (msg.type === 'prReviewError') { setError(msg.payload.message); }
    };
    window.addEventListener('message', handle);
    vscode.postMessage({ type: 'prReviewLoad' });
    return () => window.removeEventListener('message', handle);
  }, []);

  if (!data) {
    return <div style={{ padding: 24, fontSize: 12, color: error ? 'var(--feed-error)' : 'var(--feed-muted)' }}>{error ?? 'Loading review…'}</div>;
  }

  const { summary, findings, display } = data;
  const job = summary.review;
  const step = cycleStep(display.label);
  const blockers = findings.filter(f => f.severity === 'blocker');
  const advisories = findings.filter(f => f.severity !== 'blocker');

  return (
    <div style={{ fontFamily: 'var(--vscode-font-family)', color: 'var(--feed-fg)', background: 'var(--feed-bg)', minHeight: '100vh', padding: '18px 28px 40px', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>#{job.number}: {job.details.title}</div>
          <div style={{ fontSize: 11, color: 'var(--feed-muted)', marginTop: 2 }}>
            {job.details.base_repository_name || job.details.head_repository_name} · {job.details.head_ref} → {job.details.base_ref}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <button style={{ ...button, background: 'transparent', color: 'var(--feed-fg)', border: '1px solid var(--feed-border)' }} onClick={() => vscode.postMessage({ type: 'prReviewOpenPullRequest' })}>Open PR</button>
          <button style={button} onClick={() => vscode.postMessage({ type: 'prReviewRefresh' })}>Refresh</button>
        </div>
      </div>

      {error && <div style={{ fontSize: 12, color: 'var(--feed-error)', marginTop: 10 }}>{error}</div>}

      <div style={{ ...card, marginTop: 16, borderLeft: `3px solid ${TONE_COLOR[display.tone]}` }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: TONE_COLOR[display.tone] }}>{display.label}</div>
        <div style={{ fontSize: 12, marginTop: 4 }}>{display.description}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, marginTop: 12 }}>
          <Meta name="Review rounds" value={`${job.rounds_started} of ${job.round_limit} used`} />
          <Meta name="Unresolved blockers" value={String(summary.unresolved_blockers)} />
          <Meta name="Head" value={job.head_sha.slice(0, 7) || '—'} mono />
          <Meta name="Base" value={job.base_sha.slice(0, 7) || '—'} mono />
          {summary.question_limit > 0 && <Meta name="Questions" value={`${summary.questions_asked} of ${summary.question_limit}`} />}
        </div>
        <RunnerLine summary={summary} waiting={display.label === 'Waiting for runner'} />
        <ActionBar summary={summary} onForm={setForm} />
        {form && (form.kind === 'pause' || form.kind === 'resume') && (
          <ReasonForm form={form} onCancel={() => setForm(undefined)} onSubmit={(reason, rounds) =>
            vscode.postMessage({ type: 'prReviewControl', payload: { action: form.kind, additionalRounds: rounds, reason } })} />
        )}
        <ol style={{ display: 'flex', gap: 8, listStyle: 'none', padding: 0, margin: '14px 0 0' }} aria-label="Review cycle">
          {CYCLE.map((name, i) => (
            <li key={name} aria-current={i === step ? 'step' : undefined} style={{
              fontSize: 11, padding: '3px 10px', borderRadius: 10,
              border: `1px solid ${i === step ? TONE_COLOR[display.tone] : 'var(--feed-border)'}`,
              color: i === step ? TONE_COLOR[display.tone] : 'var(--feed-muted)', fontWeight: i === step ? 700 : 400,
            }}>{i + 1}. {name}</li>
          ))}
        </ol>
      </div>

      {summary.summary && (
        <section style={card}>
          <div style={label}>Vera's summary</div>
          <div style={{ fontSize: 12.5 }}><MarkdownRenderer content={summary.summary} /></div>
        </section>
      )}

      <div style={{ ...label, margin: '18px 0 8px' }}>
        Findings · {blockers.length} blocker{blockers.length === 1 ? '' : 's'} · {advisories.length} advisor{advisories.length === 1 ? 'y' : 'ies'}
      </div>
      {findings.length === 0 && <div style={{ fontSize: 12, color: 'var(--feed-muted)' }}>No findings.</div>}
      {[...blockers, ...advisories].map(f => (
        <FindingCard key={f.id} finding={f} actions={summary.actions} form={form} onForm={setForm} />
      ))}
      {data.findingsTruncated && (
        <div style={{ fontSize: 11, color: 'var(--feed-muted)' }}>Showing the first {findings.length} findings. Open the PR for the rest.</div>
      )}
    </div>
  );
}

function Meta({ name, value, mono }: { name: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div style={label}>{name}</div>
      <div style={{ fontSize: 12.5, marginTop: 2, fontFamily: mono ? 'var(--vscode-editor-font-family)' : undefined }}>{value}</div>
    </div>
  );
}

function actionAllowed(summary: PRReviewSummary, name: PRReviewActionName): { allowed: boolean; reason: string } {
  const a = summary.actions?.[name];
  return { allowed: !!a?.allowed, reason: a?.reason ?? '' };
}

/** Review controls, enabled exactly as the server allows (summary.actions). */
function ActionBar({ summary, onForm }: { summary: PRReviewSummary; onForm: (f: Form) => void }) {
  const review = actionAllowed(summary, 'review');
  const pause = actionAllowed(summary, 'pause');
  const resume = actionAllowed(summary, 'resume');
  const retry = actionAllowed(summary, 'retry_publication');
  const ghost: CSSProperties = { ...button, background: 'transparent', color: 'var(--feed-fg)', border: '1px solid var(--feed-border)' };
  const off = (allowed: boolean): CSSProperties => (allowed ? {} : { opacity: 0.45, cursor: 'not-allowed' });
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
      <button style={{ ...button, ...off(review.allowed) }} disabled={!review.allowed} title={review.allowed ? '' : review.reason}
        onClick={() => vscode.postMessage({ type: 'prReviewRequest' })}>
        {summary.review.rounds_started > 0 ? 'Re-run review' : 'Review this PR'}
      </button>
      <button style={{ ...ghost, ...off(pause.allowed) }} disabled={!pause.allowed} title={pause.allowed ? '' : pause.reason}
        onClick={() => onForm({ kind: 'pause' })}>Pause</button>
      <button style={{ ...ghost, ...off(resume.allowed) }} disabled={!resume.allowed} title={resume.allowed ? '' : resume.reason}
        onClick={() => onForm({ kind: 'resume', minimumRounds: summary.actions?.resume?.minimum_additional_rounds ?? 0 })}>Continue</button>
      {retry.allowed && (
        <button style={ghost} onClick={() => vscode.postMessage({ type: 'prReviewRetryPublication' })}>Retry PR update</button>
      )}
    </div>
  );
}

function RunnerLine({ summary, waiting }: { summary: PRReviewSummary; waiting: boolean }) {
  const runner = summary.runner;
  return (
    <div style={{ fontSize: 11.5, color: 'var(--feed-muted)', marginTop: 10 }}>
      Runner: {runner?.name || 'none assigned'}{runner?.state ? ` · ${runner.state}` : ''}
      {waiting && <div style={{ marginTop: 2 }}>Start Vera in the VibeFlow CLI: press n, choose VibeFlow, then Vera · Code Reviewer.</div>}
    </div>
  );
}

/** The inputs the server requires: a reason always, rounds for Continue, evidence for Reopen. */
function ReasonForm({ form, onCancel, onSubmit }: { form: Form; onCancel: () => void; onSubmit: (reason: string, rounds: number, evidence: string) => void }) {
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const minRounds = form.kind === 'resume' ? Math.max(form.minimumRounds, 0) : 0;
  const [rounds, setRounds] = useState(Math.max(minRounds, form.kind === 'resume' ? 1 : 0));
  const ready = reason.trim() !== '' && (form.kind !== 'reopen' || evidence.trim() !== '');
  const input: CSSProperties = { width: '100%', boxSizing: 'border-box', fontSize: 12, padding: 6, background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)', border: '1px solid var(--feed-border)', borderRadius: 4 };
  const title = { pause: 'Pause reviews and repairs', resume: 'Continue with additional rounds', dismiss: 'Dismiss this finding', reopen: 'Reopen with evidence' }[form.kind];
  return (
    <form style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }} onSubmit={e => { e.preventDefault(); if (ready) { onSubmit(reason.trim(), rounds, evidence.trim()); } }}>
      <div style={{ fontSize: 12, fontWeight: 600 }}>{title}</div>
      {form.kind === 'resume' && (
        <label style={{ fontSize: 12 }}>Additional review rounds{' '}
          <input type="number" min={minRounds} max={20} value={rounds} onChange={e => setRounds(Math.min(20, Math.max(minRounds, Number(e.target.value) || 0)))} style={{ ...input, width: 70, display: 'inline-block' }} />
        </label>
      )}
      <textarea aria-label="Reason" placeholder="Reason (required)" maxLength={2000} rows={2} value={reason} onChange={e => setReason(e.target.value)} style={input} />
      {form.kind === 'reopen' && (
        <textarea aria-label="Evidence" placeholder="Evidence the finding still applies (required)" maxLength={8192} rows={3} value={evidence} onChange={e => setEvidence(e.target.value)} style={input} />
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" disabled={!ready} style={{ ...button, ...(ready ? {} : { opacity: 0.45 }) }}>Submit</button>
        <button type="button" onClick={onCancel} style={{ ...button, background: 'transparent', color: 'var(--feed-fg)', border: '1px solid var(--feed-border)' }}>Cancel</button>
      </div>
    </form>
  );
}

function FindingCard({ finding: f, actions, form, onForm }: {
  finding: PRReviewFinding;
  actions: PRReviewSummary['actions'];
  form: Form | undefined;
  onForm: (f: Form | undefined) => void;
}) {
  const isBlocker = f.severity === 'blocker';
  const canDismiss = !!actions?.dismiss?.allowed && (f.state === 'present' || f.state === 'uncertain');
  const canReopen = !!actions?.reopen?.allowed && f.state === 'dismissed';
  const editing = form && (form.kind === 'dismiss' || form.kind === 'reopen') && form.findingId === f.id ? form : undefined;
  const location = f.line > 0 ? `${f.path}:${f.line}` : f.path;
  return (
    <article style={{ ...card, opacity: f.state === 'fixed' || f.state === 'dismissed' ? 0.7 : 1 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: isBlocker ? 'var(--feed-error)' : 'var(--feed-muted)' }}>
        {isBlocker ? 'Blocker' : 'Advisory'} · {FINDING_STATES[f.state] ?? f.state}
        {f.repair_issue_id ? <span style={{ fontWeight: 400 }}> · Issue #{f.repair_issue_id}</span> : null}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>{f.title}</div>
      {f.path && (
        <button style={{ ...linkButton, marginTop: 4 }} title="Open in editor"
          onClick={() => vscode.postMessage({ type: 'prReviewOpenLocation', payload: { path: f.path, line: f.line > 0 ? f.line : undefined } })}>
          {location}
        </button>
      )}
      <div style={{ ...label, marginTop: 10 }}>Trigger</div>
      <div style={{ fontSize: 12 }}><MarkdownRenderer content={f.trigger} /></div>
      <div style={{ ...label, marginTop: 6 }}>Impact</div>
      <div style={{ fontSize: 12 }}><MarkdownRenderer content={f.impact} /></div>
      <details style={{ marginTop: 6, fontSize: 12 }}>
        <summary style={{ cursor: 'pointer', color: 'var(--feed-muted)' }}>Evidence and verification</summary>
        <div style={{ ...label, marginTop: 8 }}>Evidence</div>
        <MarkdownRenderer content={f.evidence} />
        <div style={{ ...label, marginTop: 6 }}>Verification</div>
        <MarkdownRenderer content={f.verification} />
      </details>
      {(canDismiss || canReopen) && !editing && (
        <button style={{ ...linkButton, fontFamily: 'inherit', marginTop: 8 }}
          onClick={() => onForm(canDismiss ? { kind: 'dismiss', findingId: f.id } : { kind: 'reopen', findingId: f.id })}>
          {canDismiss ? 'Dismiss finding' : 'Reopen with evidence'}
        </button>
      )}
      {editing && (
        <ReasonForm form={editing} onCancel={() => onForm(undefined)} onSubmit={(reason, _rounds, evidence) =>
          vscode.postMessage({ type: 'prReviewFindingControl', payload: { findingId: f.id, action: editing.kind, reason, ...(editing.kind === 'reopen' ? { evidence } : {}) } })} />
      )}
    </article>
  );
}
