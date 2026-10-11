import { useEffect, useState, type CSSProperties } from 'react';
import { getVsCodeApi } from '../vscodeApi';
import { MarkdownRenderer } from './MarkdownRenderer';
import type { PRReviewPageClientMessage, PRReviewPageHostMessage } from '../../../src/core/webviewMessages';
import type { PRReviewFinding } from '../../../src/api/prReviewTypes';

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

  useEffect(() => {
    const handle = (event: MessageEvent<PRReviewPageHostMessage>) => {
      const msg = event.data;
      if (msg.type === 'prReviewData') { setData(msg.payload); setError(undefined); }
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
    <div style={{ fontFamily: 'var(--vscode-font-family)', color: 'var(--feed-fg)', background: 'var(--feed-bg)', height: '100vh', overflowY: 'auto', padding: '18px 28px 40px', boxSizing: 'border-box' }}>
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
          <div style={{ fontSize: 12.5 }}><MarkdownRenderer content={summary.summary} inline /></div>
        </section>
      )}

      <div style={{ ...label, margin: '18px 0 8px' }}>
        Findings · {blockers.length} blocker{blockers.length === 1 ? '' : 's'} · {advisories.length} advisor{advisories.length === 1 ? 'y' : 'ies'}
      </div>
      {findings.length === 0 && <div style={{ fontSize: 12, color: 'var(--feed-muted)' }}>No findings.</div>}
      {[...blockers, ...advisories].map(f => <FindingCard key={f.id} finding={f} />)}
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

function FindingCard({ finding: f }: { finding: PRReviewFinding }) {
  const isBlocker = f.severity === 'blocker';
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
      <div style={{ fontSize: 12 }}><MarkdownRenderer content={f.trigger} inline /></div>
      <div style={{ ...label, marginTop: 6 }}>Impact</div>
      <div style={{ fontSize: 12 }}><MarkdownRenderer content={f.impact} inline /></div>
      <details style={{ marginTop: 6, fontSize: 12 }}>
        <summary style={{ cursor: 'pointer', color: 'var(--feed-muted)' }}>Evidence and verification</summary>
        <div style={{ ...label, marginTop: 8 }}>Evidence</div>
        <MarkdownRenderer content={f.evidence} inline />
        <div style={{ ...label, marginTop: 6 }}>Verification</div>
        <MarkdownRenderer content={f.verification} inline />
      </details>
    </article>
  );
}
