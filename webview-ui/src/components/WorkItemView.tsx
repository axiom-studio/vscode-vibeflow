import { useState, useEffect, useMemo, useCallback } from 'react';
import { MarkdownRenderer } from './MarkdownRenderer';
import { getVsCodeApi } from '../vscodeApi';
import type {
  WorkItemPanelClientMessage,
  WorkItemPanelHostMessage,
  WorkItemPanelInfo,
  WorkItemPanelSnapshot,
} from '../../../src/core/webviewMessages';

const vscode = getVsCodeApi() as { postMessage: (msg: WorkItemPanelClientMessage) => void };

type Tab = 'details' | 'attachments' | 'logs';
type LogsSubtab = 'security' | 'execution';

/**
 * Work-item detail panel. Replaces the previous hand-rolled HTML/JS panel
 * (WorkItemPanelManager.getHtml) so the description tab can render
 * markdown — including GFM tables and code highlighting — via the same
 * react-markdown stack used by the document viewer.
 *
 * The host pre-renders no HTML; it sets `data-vf-mode="workitem"` and
 * `data-vf-item-info` JSON on <body>, then drives state by posting
 * `snapshot` messages every poll cycle. All button clicks dispatch typed
 * WorkItemPanelClientMessage values back to the host, which performs the
 * actual API mutation through native VS Code dialogs (showInputBox /
 * showOpenDialog / showWarningMessage) and pushes a fresh snapshot.
 */
export function WorkItemView() {
  const itemInfo = useMemo<WorkItemPanelInfo | null>(() => {
    const raw = document.body.dataset.vfItemInfo;
    if (!raw) { return null; }
    try { return JSON.parse(raw) as WorkItemPanelInfo; }
    catch { return null; }
  }, []);

  const [snapshot, setSnapshot] = useState<WorkItemPanelSnapshot | null>(null);
  const [tab, setTab] = useState<Tab>('details');
  const [logsSubtab, setLogsSubtab] = useState<LogsSubtab>('security');
  const [autoRefresh, setAutoRefresh] = useState(true);

  useEffect(() => {
    function onMessage(event: MessageEvent<WorkItemPanelHostMessage>) {
      const msg = event.data;
      if (msg?.type === 'snapshot') { setSnapshot(msg.payload); }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const send = useCallback((msg: WorkItemPanelClientMessage) => {
    vscode.postMessage(msg);
  }, []);

  if (!itemInfo) {
    return <div style={{ padding: 16 }}>No work item context. This panel was opened without an item id.</div>;
  }

  // Header values: prefer the live snapshot, fall back to the initial info
  // we stamped on <body> so the panel renders immediately on mount before
  // the first snapshot lands (saves a perceptible flash of empty state).
  const status = snapshot?.status ?? itemInfo.status;
  const priority = snapshot?.priority ?? itemInfo.priority;
  const featureName = snapshot?.feature_name ?? itemInfo.featureName ?? '';
  const claimedBy = snapshot?.claimed_by ?? itemInfo.claimedBy ?? '';
  const targetBranch = snapshot?.target_branch ?? '';
  const qaVerified = snapshot?.qa_verified ?? false;
  const securityReviewed = snapshot?.security_reviewed ?? false;
  const complianceTags = snapshot?.compliance_tags ?? [];

  // Action toolbar visibility — mirrors the rules verified against
  // axiomcloud's status state machine on 2026-05-03:
  //   - QA Verify: status === 'done' && !qa_verified
  //   - QA Reject: status === 'done' (label flips to "Revoke QA" when
  //     already verified)
  //   - Security buttons hidden once security_reviewed
  const showQaVerify = status === 'done' && !qaVerified;
  const showQaReject = status === 'done';
  const qaRejectLabel = qaVerified ? '↩ Revoke QA' : '✕ QA Reject';
  const showSecVerify = !securityReviewed;
  const showSecReject = !securityReviewed;

  return (
    <div style={containerStyle}>
      {/* Header */}
      <div style={headerStyle}>
        <h1 style={titleStyle}>{itemInfo.type} #{itemInfo.id}: {itemInfo.title}</h1>
        <div style={metaRowStyle}>
          <span style={pillStyle}>{status}</span>
          <span>Priority: {priority}</span>
          {targetBranch && <span style={tagStyle}>{targetBranch}</span>}
          {featureName && <span>Feature: {featureName}</span>}
          {claimedBy && <span>Claimed: {claimedBy}</span>}
          {qaVerified && <span style={checkStyle}>✓ QA verified</span>}
          {securityReviewed && <span style={checkStyle}>✓ Security reviewed</span>}
          {complianceTags.length > 0 && (
            <span style={{ display: 'flex', gap: 4 }}>
              {complianceTags.map((t, i) => (
                <span key={i} style={tagStyle}>{(t.framework ?? '').toUpperCase()}</span>
              ))}
            </span>
          )}
        </div>

        {/* Toolbar */}
        <div style={toolbarStyle}>
          <ButtonGroup label="Status">
            <button style={btnSecondary} onClick={() => send({ type: 'changeStatus' })}>Change…</button>
          </ButtonGroup>
          <ButtonGroup label="QA">
            {showQaVerify && (
              <button style={btnSuccess} onClick={() => send({ type: 'qaVerify' })}>✓ QA Verify</button>
            )}
            {showQaReject && (
              <button style={btnDanger} onClick={() => send({ type: 'qaReject' })}>{qaRejectLabel}</button>
            )}
          </ButtonGroup>
          <ButtonGroup label="Security">
            {showSecVerify && (
              <button style={btnSuccess} onClick={() => send({ type: 'securityApprove' })}>✓ Security Verify</button>
            )}
            {showSecReject && (
              <button style={btnDanger} onClick={() => send({ type: 'securityReject' })}>✕ Security Reject</button>
            )}
          </ButtonGroup>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button style={btnIcon} onClick={() => send({ type: 'edit' })}>Edit</button>
            {itemInfo.type === 'issue' && (
              <button style={btnIcon} onClick={() => send({ type: 'archive' })}>Archive</button>
            )}
            <button style={btnIcon} onClick={() => send({ type: 'delete' })}>Delete</button>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={tabsStyle}>
        <TabButton label="Details" active={tab === 'details'} onClick={() => setTab('details')} />
        <TabButton
          label={`Attachments ${snapshot?.attachments.length ?? 0}`}
          active={tab === 'attachments'}
          onClick={() => setTab('attachments')}
        />
        <TabButton label="Logs" active={tab === 'logs'} onClick={() => setTab('logs')} />
      </div>

      <div style={tabContentStyle}>
        {tab === 'details' && <DetailsTab snapshot={snapshot} />}
        {tab === 'attachments' && (
          <AttachmentsTab
            snapshot={snapshot}
            onUpload={() => send({ type: 'uploadAttachment' })}
            onDelete={(id) => send({ type: 'deleteAttachment', payload: { attachmentId: id } })}
          />
        )}
        {tab === 'logs' && (
          <LogsTab
            snapshot={snapshot}
            subtab={logsSubtab}
            setSubtab={setLogsSubtab}
            autoRefresh={autoRefresh}
            setAutoRefresh={setAutoRefresh}
            onRefresh={() => send({ type: 'refresh' })}
          />
        )}
      </div>
    </div>
  );
}

// ============================================================
// Tab content
// ============================================================

function DetailsTab({ snapshot }: { snapshot: WorkItemPanelSnapshot | null }) {
  const description = snapshot?.description?.trim() ?? '';
  return (
    <>
      <h2 style={h2Style}>Description</h2>
      {description ? (
        <div style={descriptionWrapStyle}>
          {/* prose-vf-block + react-markdown gives us GFM tables, code
              blocks, headings, and the rest of the markdown surface for
              free — the whole point of the migration. */}
          <div className="prose-vf-block">
            <MarkdownRenderer content={description} inline />
          </div>
        </div>
      ) : (
        <div style={emptyStyle}>No description.</div>
      )}

      <h2 style={h2Style}>Timeline</h2>
      <div style={detailsGridStyle}>
        <span style={labelStyle}>Created</span>
        <span>{fmtDate(snapshot?.created_at) || '—'}</span>
        <span style={labelStyle}>Updated</span>
        <span>{fmtDate(snapshot?.updated_at) || '—'}</span>
        <span style={labelStyle}>Created by</span>
        <span>{snapshot?.user_email || '—'}</span>
        <span style={labelStyle}>Claimed by</span>
        <span>{snapshot?.claimed_by || '—'}</span>
        <span style={labelStyle}>Feature</span>
        <span>{snapshot?.feature_name || '—'}</span>
        <span style={labelStyle}>Branch</span>
        <span>{snapshot?.target_branch || '—'}</span>
      </div>
    </>
  );
}

function AttachmentsTab({
  snapshot,
  onUpload,
  onDelete,
}: {
  snapshot: WorkItemPanelSnapshot | null;
  onUpload: () => void;
  onDelete: (id: number) => void;
}) {
  const list = snapshot?.attachments ?? [];
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <button style={btnSecondary} onClick={onUpload}>+ Attach file…</button>
        <span style={{ marginLeft: 'auto', color: 'var(--feed-muted)', fontSize: '0.8em' }}>Max 32 MB</span>
      </div>
      {list.length === 0 ? (
        <div style={emptyStyle}>No attachments yet.</div>
      ) : (
        list.map((a) => {
          const name = a.asset?.original_name ?? `(linked ${a.attachment_type} #${a.attachment_id})`;
          const size = a.asset?.size ? humanSize(a.asset.size) : '';
          const ct = a.asset?.content_type ?? '';
          const meta = [size, ct].filter(Boolean).join(' · ');
          return (
            <div key={a.id} style={attachmentStyle}>
              <span style={{ flex: 1 }}>{name}</span>
              {meta && <span style={{ color: 'var(--feed-muted)', fontSize: '0.8em' }}>{meta}</span>}
              <button style={btnIcon} onClick={() => onDelete(a.id)}>Remove</button>
            </div>
          );
        })
      )}
    </>
  );
}

function LogsTab({
  snapshot,
  subtab,
  setSubtab,
  autoRefresh,
  setAutoRefresh,
  onRefresh,
}: {
  snapshot: WorkItemPanelSnapshot | null;
  subtab: LogsSubtab;
  setSubtab: (s: LogsSubtab) => void;
  autoRefresh: boolean;
  setAutoRefresh: (b: boolean) => void;
  onRefresh: () => void;
}) {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ display: 'flex' }}>
          <SubtabButton label="Security Review" active={subtab === 'security'} onClick={() => setSubtab('security')} />
          <SubtabButton label="Execution Logs" active={subtab === 'execution'} onClick={() => setSubtab('execution')} />
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, alignItems: 'center', fontSize: '0.85em' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            Auto-refresh
          </label>
          <button style={btnIcon} onClick={onRefresh}>Refresh</button>
        </div>
      </div>

      {subtab === 'security' ? (
        <SecurityReviewSubtab snapshot={snapshot} />
      ) : (
        <ExecutionLogsSubtab snapshot={snapshot} autoRefresh={autoRefresh} />
      )}
    </>
  );
}

function SecurityReviewSubtab({ snapshot }: { snapshot: WorkItemPanelSnapshot | null }) {
  const findings = snapshot?.security_findings ?? [];
  const review = snapshot?.security_review;
  const qa = snapshot?.qa_review;

  // QA review summary text — purely informational; the actual gate is the
  // qa_verified flag, which the toolbar already reflects.
  let qaSummaryNode: React.ReactNode;
  if (qa) {
    qaSummaryNode = (
      <div>✓ QA verified {fmtDate(qa.created_at)}{qa.user_id ? ` (user #${qa.user_id})` : ''}</div>
    );
  } else if (snapshot?.qa_verified) {
    qaSummaryNode = <div>✓ QA verified</div>;
  } else {
    qaSummaryNode = <div style={emptyStyle}>No QA review yet.</div>;
  }

  let secSummaryNode: React.ReactNode;
  if (review) {
    secSummaryNode = (
      <div>✓ Security reviewed {fmtDate(review.created_at)}{review.review_notes ? ` — ${review.review_notes}` : ''}</div>
    );
  } else if (findings.length === 0) {
    secSummaryNode = <div style={emptyStyle}>No security review yet.</div>;
  } else {
    secSummaryNode = <div>{findings.length} finding{findings.length === 1 ? '' : 's'} reported.</div>;
  }

  return (
    <>
      {qaSummaryNode}
      <div style={{ marginTop: 4 }}>{secSummaryNode}</div>
      {findings.length > 0 && (
        <div style={{ marginTop: 12 }}>
          {findings.map((f) => {
            const sev = (f.severity ?? 'informational').toLowerCase();
            const remed = f.remediation_notes ? `\n\nRemediation: ${f.remediation_notes}` : '';
            return (
              <div key={f.id} style={findingStyle}>
                <div style={findingHeaderStyle}>
                  <span style={severityStyle(sev)}>{sev}</span>
                  <strong>{f.finding_type ?? 'Finding'}</strong>
                  <span style={{ color: 'var(--feed-muted)', fontSize: '0.8em' }}>{f.status ?? ''}</span>
                  {(f.compliance_tags ?? []).map((t, i) => (
                    <span key={i} style={tagStyle}>{(t.framework ?? '').toUpperCase()}</span>
                  ))}
                </div>
                <div style={findingDescStyle}>{(f.description ?? '') + remed}</div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function ExecutionLogsSubtab({ snapshot, autoRefresh }: {
  snapshot: WorkItemPanelSnapshot | null;
  autoRefresh: boolean;
}) {
  // When autoRefresh is off, freeze the rendered list at the moment the user
  // unchecked the box so polling-driven snapshots don't disturb their scroll
  // position. Re-renders resume when the box is checked again.
  const [frozenLogs, setFrozenLogs] = useState<WorkItemPanelSnapshot['execution_logs'] | null>(null);
  useEffect(() => {
    if (!autoRefresh) {
      setFrozenLogs(snapshot?.execution_logs ?? []);
    } else {
      setFrozenLogs(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh]);

  const logs = frozenLogs ?? snapshot?.execution_logs ?? [];
  if (logs.length === 0) {
    return <div style={emptyStyle}>No execution logs yet.</div>;
  }
  return (
    <div style={logsContainerStyle}>
      {logs.map((log, idx) => {
        const time = new Date(log.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const icon = LOG_ICONS[log.message_type ?? ''] ?? '📌';
        const lines = (log.content ?? '').split('\n').slice(0, 5).join('\n');
        return (
          <div key={idx} style={logEntryStyle}>
            <span style={{ color: 'var(--feed-muted)', fontSize: '0.85em', marginRight: 8 }}>{time}</span>
            {icon} {lines}
          </div>
        );
      })}
    </div>
  );
}

// ============================================================
// Small UI primitives
// ============================================================

function ButtonGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <span style={groupLabelStyle}>{label}</span>
      {children}
    </div>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: '8px 16px',
        cursor: 'pointer',
        borderBottom: `2px solid ${active ? 'var(--vscode-focusBorder)' : 'transparent'}`,
        fontSize: '0.9em',
        color: active ? 'var(--feed-fg)' : 'var(--feed-muted)',
      }}
    >
      {label}
    </div>
  );
}

function SubtabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: '4px 12px',
        cursor: 'pointer',
        fontSize: '0.85em',
        color: active ? 'var(--feed-fg)' : 'var(--feed-muted)',
        borderBottom: `2px solid ${active ? 'var(--vscode-focusBorder)' : 'transparent'}`,
      }}
    >
      {label}
    </div>
  );
}

// ============================================================
// Helpers
// ============================================================

const LOG_ICONS: Record<string, string> = {
  thinking: '🤔',
  action: '⚡',
  observation: '👁',
  summary: '📋',
  diff: '📝',
  test_result: '🧪',
};

function fmtDate(s: string | undefined): string {
  if (!s) { return ''; }
  const d = new Date(s);
  if (isNaN(d.getTime())) { return s; }
  return d.toLocaleString();
}

function humanSize(n: number): string {
  if (n < 1024) { return `${n} B`; }
  if (n < 1024 * 1024) { return `${(n / 1024).toFixed(1)} KB`; }
  if (n < 1024 * 1024 * 1024) { return `${(n / (1024 * 1024)).toFixed(1)} MB`; }
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ============================================================
// Styles
// ============================================================

const containerStyle: React.CSSProperties = {
  fontFamily: 'var(--vscode-font-family)',
  fontSize: 'var(--vscode-font-size)',
  color: 'var(--feed-fg)',
  padding: 16,
  height: '100vh',
  overflowY: 'auto',
};
const headerStyle: React.CSSProperties = { paddingBottom: 12, borderBottom: '1px solid var(--feed-border)' };
const titleStyle: React.CSSProperties = { margin: '0 0 8px 0', fontSize: '1.2em' };
const metaRowStyle: React.CSSProperties = {
  display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: '0.85em',
  color: 'var(--feed-muted)', alignItems: 'center',
};
const pillStyle: React.CSSProperties = {
  padding: '1px 8px', borderRadius: 3,
  background: 'var(--feed-badge-bg)', color: 'var(--feed-badge-fg)',
  fontSize: '0.8em',
};
const tagStyle: React.CSSProperties = {
  padding: '1px 8px', borderRadius: 3,
  background: 'var(--vscode-textBlockQuote-background)',
  color: 'var(--feed-fg)',
  fontSize: '0.75em',
  border: '1px solid var(--feed-border)',
};
const checkStyle: React.CSSProperties = {
  color: 'var(--feed-success)', fontWeight: 600,
};
const toolbarStyle: React.CSSProperties = {
  display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center',
};
const groupLabelStyle: React.CSSProperties = {
  fontSize: '0.75em', color: 'var(--feed-muted)',
  marginRight: 2, textTransform: 'uppercase', letterSpacing: 0.5,
};
const btnBase: React.CSSProperties = {
  padding: '6px 12px', border: 'none', borderRadius: 4,
  cursor: 'pointer', fontSize: '0.85em',
};
const btnSuccess: React.CSSProperties = { ...btnBase, background: 'var(--feed-success)', color: 'white' };
const btnDanger: React.CSSProperties = { ...btnBase, background: 'var(--feed-error)', color: 'white' };
const btnSecondary: React.CSSProperties = {
  ...btnBase,
  background: 'var(--vscode-button-secondaryBackground)',
  color: 'var(--vscode-button-secondaryForeground)',
};
const btnIcon: React.CSSProperties = {
  ...btnBase,
  background: 'transparent',
  color: 'var(--feed-fg)',
  border: '1px solid var(--feed-border)',
};
const tabsStyle: React.CSSProperties = {
  display: 'flex', gap: 0, marginTop: 16,
  borderBottom: '1px solid var(--feed-border)',
};
const tabContentStyle: React.CSSProperties = { padding: '16px 0' };
const h2Style: React.CSSProperties = { fontSize: '1em', margin: '16px 0 8px 0', color: 'var(--feed-fg)' };
const descriptionWrapStyle: React.CSSProperties = {
  marginTop: 4, padding: 12,
  background: 'var(--vscode-textBlockQuote-background)',
  borderRadius: 4, lineHeight: 1.5,
  maxHeight: '40vh', overflowY: 'auto',
};
const emptyStyle: React.CSSProperties = {
  color: 'var(--feed-muted)', fontStyle: 'italic',
  padding: '8px 0', fontSize: '0.85em',
};
const detailsGridStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'max-content 1fr',
  gap: '6px 16px', fontSize: '0.9em', marginTop: 12,
};
const labelStyle: React.CSSProperties = { color: 'var(--feed-muted)' };
const attachmentStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '6px 12px', border: '1px solid var(--feed-border)',
  borderRadius: 4, marginBottom: 4, fontSize: '0.9em',
};
const logsContainerStyle: React.CSSProperties = {
  maxHeight: '50vh', overflowY: 'auto',
  fontFamily: 'var(--vscode-editor-font-family)', fontSize: '0.9em',
};
const logEntryStyle: React.CSSProperties = {
  padding: '4px 0', borderBottom: '1px solid var(--feed-border)',
  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
};
const findingStyle: React.CSSProperties = {
  padding: '10px 12px', border: '1px solid var(--feed-border)',
  borderRadius: 4, marginBottom: 8,
};
const findingHeaderStyle: React.CSSProperties = {
  display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
};
const findingDescStyle: React.CSSProperties = {
  marginTop: 6, fontSize: '0.9em',
  color: 'var(--feed-muted)', whiteSpace: 'pre-wrap',
};
function severityStyle(sev: string): React.CSSProperties {
  const colors: Record<string, { bg: string; fg: string }> = {
    critical: { bg: 'var(--feed-error)', fg: 'white' },
    high: { bg: 'var(--vscode-charts-red, var(--feed-error))', fg: 'white' },
    medium: { bg: 'var(--vscode-charts-orange, var(--feed-warning))', fg: 'white' },
    low: { bg: 'var(--vscode-charts-yellow, #d4a72c)', fg: 'black' },
    informational: { bg: 'var(--feed-badge-bg)', fg: 'var(--feed-badge-fg)' },
  };
  const c = colors[sev] ?? colors.informational;
  return {
    padding: '1px 8px', borderRadius: 3,
    fontSize: '0.7em', fontWeight: 600,
    textTransform: 'uppercase',
    background: c.bg, color: c.fg,
  };
}
