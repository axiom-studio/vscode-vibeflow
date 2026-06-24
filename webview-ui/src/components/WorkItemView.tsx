import { useState, useEffect, useMemo, useCallback, type CSSProperties, type ReactNode } from 'react';
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
 * Work-item detail panel (redesigned, #2568). Modern, native to the VS Code
 * webview theming (feed/vf CSS tokens only), light/dark/high-contrast +
 * reduced-motion safe. The host + wire protocol are UNCHANGED: it sets
 * `data-vf-mode="workitem"` + `data-vf-item-info` JSON on <body>, then drives
 * state by posting `snapshot` messages. Every gesture dispatches the same typed
 * WorkItemPanelClientMessage; the host performs the API mutation via native
 * dialogs and pushes a fresh snapshot.
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
  const [collapsed, setCollapsed] = useState(false);

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
    return <div style={noContextStyle}>No work item context. This panel was opened without an item id.</div>;
  }

  // Header values: prefer the live snapshot, fall back to the initial info we
  // stamped on <body> so the panel renders immediately on mount (no empty flash).
  const status = snapshot?.status ?? itemInfo.status;
  const priority = snapshot?.priority ?? itemInfo.priority;
  const featureName = snapshot?.feature_name ?? itemInfo.featureName ?? '';
  const claimedBy = snapshot?.claimed_by ?? itemInfo.claimedBy ?? '';
  const targetBranch = snapshot?.target_branch ?? '';
  const qaVerified = snapshot?.qa_verified ?? false;
  const securityReviewed = snapshot?.security_reviewed ?? false;
  const complianceTags = snapshot?.compliance_tags ?? [];
  const findings = snapshot?.security_findings ?? [];
  const hasSevereFinding = findings.some((f) => {
    const s = (f.severity ?? '').toLowerCase();
    return s === 'critical' || s === 'high';
  });

  // Action toolbar visibility — UNCHANGED from the verified state machine:
  //   QA Verify: status === 'done' && !qa_verified
  //   QA Reject: status === 'done' (label flips to "Revoke QA" when verified)
  //   Security buttons hidden once security_reviewed
  const showQaVerify = status === 'done' && !qaVerified;
  const showQaReject = status === 'done';
  const qaRejectLabel = qaVerified ? '↩ Revoke QA' : '✕ QA Reject';
  const showSecVerify = !securityReviewed;
  const showSecReject = !securityReviewed;

  // Exactly one filled "primary" — the most likely next action.
  const primary: 'qa' | 'sec' | 'status' =
    (status === 'done' && !qaVerified) ? 'qa' : (!securityReviewed) ? 'sec' : 'status';

  // Left-edge "health spine" — derived entirely from existing fields (decorative).
  const spineColor =
    (status === 'done' && qaVerified && securityReviewed) ? 'var(--feed-success)'
      : hasSevereFinding ? 'var(--feed-error)'
        : (status === 'done' && (!qaVerified || !securityReviewed)) ? 'var(--feed-warning)'
          : 'color-mix(in oklab, var(--feed-link) 40%, transparent)';

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const next = e.currentTarget.scrollTop > 48;
    setCollapsed((prev) => (prev === next ? prev : next));
  };

  return (
    <div
      style={{ ...containerStyle, borderLeft: `3px solid color-mix(in oklab, ${spineColor} 70%, transparent)` }}
      onScroll={onScroll}
    >
      <div style={stickyTopStyle}>
        <header style={collapsed ? { ...headerStyle, ...headerCollapsedStyle } : headerStyle}>
          {!collapsed && (
            <div style={eyebrowStyle}>
              <span style={eyebrowIdStyle}>{itemInfo.type} #{itemInfo.id}</span>
              {featureName && (
                <>
                  <span style={{ opacity: 0.5 }}>·</span>
                  <span>Feature: {featureName}</span>
                </>
              )}
            </div>
          )}

          <div style={titleRowStyle}>
            <h1 style={collapsed ? { ...titleStyle, ...titleCollapsedStyle } : titleStyle}>
              {itemInfo.type} #{itemInfo.id}: {itemInfo.title}
            </h1>

            <div style={toolbarStyle}>
              <ToolButton variant={primary === 'status' ? 'primary' : 'ghost'} title="Change status" onClick={() => send({ type: 'changeStatus' })}>Change…</ToolButton>

              {(showQaVerify || showQaReject) && <Divider />}
              {showQaVerify && (
                <ToolButton variant={primary === 'qa' ? 'primary' : 'affirm'} title="Verify QA" onClick={() => send({ type: 'qaVerify' })}>✓ QA Verify</ToolButton>
              )}
              {showQaReject && (
                <ToolButton variant="danger" title={qaVerified ? 'Revoke QA verification' : 'Reject QA'} onClick={() => send({ type: 'qaReject' })}>{qaRejectLabel}</ToolButton>
              )}

              {(showSecVerify || showSecReject) && <Divider />}
              {showSecVerify && (
                <ToolButton variant={primary === 'sec' ? 'primary' : 'affirm'} title="Approve security review" onClick={() => send({ type: 'securityApprove' })}>✓ Security Verify</ToolButton>
              )}
              {showSecReject && (
                <ToolButton variant="danger" title="Reject security review" onClick={() => send({ type: 'securityReject' })}>✕ Security Reject</ToolButton>
              )}

              <span style={{ marginLeft: 'auto' }} />
              <ToolButton variant="ghost" title="Edit" onClick={() => send({ type: 'edit' })}>Edit</ToolButton>
              {itemInfo.type === 'issue' && (
                <ToolButton variant="danger" title="Archive issue" onClick={() => send({ type: 'archive' })}>Archive</ToolButton>
              )}
              <ToolButton variant="danger" title="Delete" onClick={() => send({ type: 'delete' })}>Delete</ToolButton>
            </div>
          </div>

          <div style={metaRowStyle}>
            <StatusPill status={status} />
            <PriorityDot priority={priority} />
            {targetBranch && <Chip variant="outline" leading="⎇" mono>{targetBranch}</Chip>}
            {claimedBy && <ClaimedChip name={claimedBy} />}
            <Divider tall />
            <SecurityGate reviewed={securityReviewed} severe={hasSevereFinding} count={findings.length} review={snapshot?.security_review} />
            <QaGate verified={qaVerified} statusDone={status === 'done'} review={snapshot?.qa_review} />
            {complianceTags.map((t, i) => (
              <Chip key={i} variant="outline">{(t.framework ?? '').toUpperCase()}</Chip>
            ))}
          </div>
        </header>

        <nav style={tabsStyle} role="tablist">
          <TabButton label="Details" active={tab === 'details'} onClick={() => setTab('details')} />
          <TabButton label="Attachments" badge={snapshot?.attachments.length ?? 0} active={tab === 'attachments'} onClick={() => setTab('attachments')} />
          <TabButton label="Logs" active={tab === 'logs'} onClick={() => setTab('logs')} />
        </nav>
      </div>

      <main style={tabContentStyle}>
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
      </main>
    </div>
  );
}

// ============================================================
// Header primitives
// ============================================================

function StatusPill({ status }: { status: string }) {
  const { tone, glyph } = statusMeta(status);
  return (
    <span style={{ ...pillBase, ...tintStyle(tone) }} title={`Status: ${status}`}>
      <span aria-hidden style={{ fontSize: '0.85em' }}>{glyph}</span>{status}
    </span>
  );
}

function PriorityDot({ priority }: { priority: string }) {
  const color = priorityColor(priority);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title={`Priority: ${priority}`}>
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: 'var(--vf-r-pill)', background: color, boxShadow: `0 0 0 1px color-mix(in oklab, ${color} 35%, transparent)`, flexShrink: 0 }} />
      <span style={{ fontSize: 'var(--vf-text-xs)', color: 'var(--feed-muted)', textTransform: 'capitalize' }}>{priority}</span>
    </span>
  );
}

function Chip({ variant = 'outline', leading, mono, title, children }: {
  variant?: 'outline' | 'solid'; leading?: string; mono?: boolean; title?: string; children: ReactNode;
}) {
  const style: CSSProperties = variant === 'outline'
    ? { ...pillBase, color: 'var(--feed-fg)', background: 'transparent', border: '1px solid var(--feed-border)' }
    : { ...pillBase, ...tintStyle('var(--feed-link)') };
  return (
    <span style={{ ...style, ...(mono ? { fontFamily: 'var(--vf-font-mono)', fontWeight: 'var(--vf-weight-medium)' as CSSProperties['fontWeight'] } : null) }} title={title}>
      {leading && <span aria-hidden style={{ opacity: 0.8 }}>{leading}</span>}{children}
    </span>
  );
}

function ClaimedChip({ name }: { name: string }) {
  const initial = (name.trim()[0] ?? '?').toUpperCase();
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title={`Claimed by ${name}`}>
      <span aria-hidden style={{ width: 16, height: 16, borderRadius: 'var(--vf-r-pill)', background: 'color-mix(in oklab, var(--feed-link) 20%, transparent)', color: 'var(--feed-link)', fontSize: 9, fontWeight: 700, display: 'grid', placeItems: 'center', flexShrink: 0 }}>{initial}</span>
      <span style={{ fontSize: 'var(--vf-text-xs)', color: 'var(--feed-muted)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
    </span>
  );
}

function SecurityGate({ reviewed, severe, count, review }: {
  reviewed: boolean; severe: boolean; count: number; review?: WorkItemPanelSnapshot['security_review'];
}) {
  let tone: string, glyph: string, title: string;
  if (reviewed) {
    tone = 'var(--feed-success)'; glyph = '✓';
    title = `Security reviewed${review?.created_at ? ` ${fmtDate(review.created_at)}` : ''}${review?.review_notes ? ` — ${review.review_notes}` : ''}`;
  } else if (severe) {
    tone = 'var(--feed-error)'; glyph = '✕'; title = `${count} security finding${count === 1 ? '' : 's'} — needs review`;
  } else {
    tone = 'var(--feed-warning)'; glyph = '○'; title = 'Security review pending';
  }
  return (
    <span style={{ ...pillBase, ...tintStyle(tone) }} title={title}>
      <span aria-hidden>{glyph}</span>Security{!reviewed && count > 0 ? <span style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.85 }}>&nbsp;{count}</span> : null}
    </span>
  );
}

function QaGate({ verified, statusDone, review }: {
  verified: boolean; statusDone: boolean; review?: WorkItemPanelSnapshot['qa_review'];
}) {
  let tone: string, glyph: string, title: string;
  if (verified) {
    tone = 'var(--feed-success)'; glyph = '✓';
    title = `QA verified${review?.created_at ? ` ${fmtDate(review.created_at)}` : ''}`;
  } else if (statusDone) {
    tone = 'var(--feed-warning)'; glyph = '○'; title = 'QA verification pending';
  } else {
    tone = 'var(--feed-muted)'; glyph = '○'; title = 'QA not yet applicable';
  }
  return (
    <span style={{ ...pillBase, ...tintStyle(tone) }} title={title}>
      <span aria-hidden>{glyph}</span>QA
    </span>
  );
}

function Divider({ tall }: { tall?: boolean }) {
  return <span aria-hidden style={{ width: 1, height: tall ? 14 : 16, background: 'var(--feed-border)', margin: '0 2px', flexShrink: 0, alignSelf: 'center' }} />;
}

function ToolButton({ variant, onClick, title, children }: {
  variant: 'primary' | 'affirm' | 'ghost' | 'danger'; onClick: () => void; title?: string; children: ReactNode;
}) {
  return (
    <button className={`wiv-btn wiv-btn-${variant}`} onClick={onClick} title={title} aria-label={title}>{children}</button>
  );
}

function TabButton({ label, badge, active, onClick }: { label: string; badge?: number; active: boolean; onClick: () => void }) {
  return (
    <button className="wiv-tab" role="tab" aria-selected={active} onClick={onClick}>
      {label}
      {badge !== undefined && (
        <span style={{
          minWidth: 16, height: 16, padding: '0 5px', borderRadius: 'var(--vf-r-pill)', fontSize: 9.5, fontWeight: 600,
          fontVariantNumeric: 'tabular-nums', display: 'inline-grid', placeItems: 'center',
          border: `1px solid ${active && badge > 0 ? 'color-mix(in oklab, var(--feed-link) 40%, transparent)' : 'var(--feed-border)'}`,
          color: active && badge > 0 ? 'var(--feed-link)' : 'var(--feed-muted)',
          opacity: badge === 0 ? 0.55 : 1,
        }}>{badge}</span>
      )}
    </button>
  );
}

// ============================================================
// Tab content
// ============================================================

function DetailsTab({ snapshot }: { snapshot: WorkItemPanelSnapshot | null }) {
  const description = normalizeEscapedMarkdown(snapshot?.description ?? '').trim();
  return (
    <div>
      <div style={sectionLabelStyle}>Description</div>
      {description ? (
        <div style={descriptionWrapStyle}>
          {/* prose-vf-block + react-markdown gives GFM tables, code, headings. */}
          <div className="prose-vf-block">
            <MarkdownRenderer content={description} inline />
          </div>
        </div>
      ) : (
        <div style={emptyStyle}>No description.</div>
      )}

      <div style={{ ...sectionLabelStyle, marginTop: 'var(--vf-sp-5)' }}>Timeline</div>
      <div style={detailsGridStyle}>
        <span style={labelStyle}>Created</span>
        <span style={numCell}>{fmtDate(snapshot?.created_at) || '—'}</span>
        <span style={labelStyle}>Updated</span>
        <span style={numCell}>{fmtDate(snapshot?.updated_at) || '—'}</span>
        <span style={labelStyle}>Created by</span>
        <span>{snapshot?.user_email || '—'}</span>
        <span style={labelStyle}>Claimed by</span>
        <span>{snapshot?.claimed_by || '—'}</span>
        <span style={labelStyle}>Feature</span>
        <span>{snapshot?.feature_name || '—'}</span>
        <span style={labelStyle}>Branch</span>
        <span style={{ fontFamily: 'var(--vf-font-mono)' }}>{snapshot?.target_branch || '—'}</span>
      </div>
    </div>
  );
}

function AttachmentsTab({ snapshot, onUpload, onDelete }: {
  snapshot: WorkItemPanelSnapshot | null; onUpload: () => void; onDelete: (id: number) => void;
}) {
  const list = snapshot?.attachments ?? [];
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 'var(--vf-sp-3)' }}>
        <button className="wiv-btn wiv-btn-ghost" onClick={onUpload}>+ Attach file…</button>
        <span style={{ marginLeft: 'auto', color: 'var(--feed-muted)', fontSize: 'var(--vf-text-xs)', fontVariantNumeric: 'tabular-nums' }}>Max 32 MB</span>
      </div>
      {list.length === 0 ? (
        <div style={emptyDashedStyle}>No attachments yet.</div>
      ) : (
        list.map((a) => {
          const name = a.asset?.original_name ?? `(linked ${a.attachment_type} #${a.attachment_id})`;
          const size = a.asset?.size ? humanSize(a.asset.size) : '';
          const ct = a.asset?.content_type ?? '';
          const meta = [size, ct].filter(Boolean).join(' · ');
          return (
            <div key={a.id} className="wiv-att-row" style={attachmentStyle}>
              <span aria-hidden style={{ flexShrink: 0 }}>{fileGlyph(ct)}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--feed-fg)' }}>{name}</span>
              {meta && <span style={{ color: 'var(--feed-muted)', fontSize: 'var(--vf-text-xs)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{meta}</span>}
              <button className="wiv-btn wiv-btn-danger wiv-att-remove" style={{ height: 22, padding: '0 8px' }} onClick={() => onDelete(a.id)}>Remove</button>
            </div>
          );
        })
      )}
    </div>
  );
}

function LogsTab({ snapshot, subtab, setSubtab, autoRefresh, setAutoRefresh, onRefresh }: {
  snapshot: WorkItemPanelSnapshot | null;
  subtab: LogsSubtab; setSubtab: (s: LogsSubtab) => void;
  autoRefresh: boolean; setAutoRefresh: (b: boolean) => void; onRefresh: () => void;
}) {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 'var(--vf-sp-3)', gap: 'var(--vf-sp-3)', flexWrap: 'wrap' }}>
        <div style={segmentWrapStyle} role="tablist">
          <button className="wiv-seg" role="tab" aria-selected={subtab === 'security'} onClick={() => setSubtab('security')}>Security Review</button>
          <button className="wiv-seg" role="tab" aria-selected={subtab === 'execution'} onClick={() => setSubtab('execution')}>Execution Logs</button>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 'var(--vf-sp-3)', alignItems: 'center', fontSize: 'var(--vf-text-sm)' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: 'var(--feed-muted)' }}>
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
            Auto-refresh
          </label>
          <button className="wiv-btn wiv-btn-ghost" style={{ height: 24 }} onClick={onRefresh}>↻ Refresh</button>
        </div>
      </div>

      {subtab === 'security'
        ? <SecurityReviewSubtab snapshot={snapshot} />
        : <ExecutionLogsSubtab snapshot={snapshot} autoRefresh={autoRefresh} />}
    </>
  );
}

function SecurityReviewSubtab({ snapshot }: { snapshot: WorkItemPanelSnapshot | null }) {
  const findings = snapshot?.security_findings ?? [];
  const review = snapshot?.security_review;
  const qa = snapshot?.qa_review;

  let qaSummaryNode: ReactNode;
  if (qa) {
    qaSummaryNode = <VerdictLine glyph="✓" tone="var(--feed-success)">QA verified <span style={timeMuted}>{fmtDate(qa.created_at)}</span>{qa.user_id ? ` (user #${qa.user_id})` : ''}</VerdictLine>;
  } else if (snapshot?.qa_verified) {
    qaSummaryNode = <VerdictLine glyph="✓" tone="var(--feed-success)">QA verified</VerdictLine>;
  } else {
    qaSummaryNode = <div style={emptyStyle}>No QA review yet.</div>;
  }

  let secSummaryNode: ReactNode;
  if (review) {
    secSummaryNode = <VerdictLine glyph="✓" tone="var(--feed-success)">Security reviewed <span style={timeMuted}>{fmtDate(review.created_at)}</span>{review.review_notes ? ` — ${review.review_notes}` : ''}</VerdictLine>;
  } else if (findings.length === 0) {
    secSummaryNode = <div style={emptyStyle}>No security review yet.</div>;
  } else {
    secSummaryNode = <VerdictLine glyph="⚠" tone="var(--feed-warning)"><span style={{ fontVariantNumeric: 'tabular-nums' }}>{findings.length}</span> finding{findings.length === 1 ? '' : 's'} reported.</VerdictLine>;
  }

  return (
    <>
      {qaSummaryNode}
      <div style={{ marginTop: 'var(--vf-sp-1)' }}>{secSummaryNode}</div>
      {findings.length > 0 && (
        <div style={{ marginTop: 'var(--vf-sp-3)', borderTop: '1px solid var(--feed-border)', paddingTop: 'var(--vf-sp-3)' }}>
          {findings.map((f) => {
            const sev = (f.severity ?? 'informational').toLowerCase();
            const { tone } = severityMeta(sev);
            const raised = sev === 'critical' || sev === 'high';
            const remed = f.remediation_notes ? `\n\nRemediation: ${f.remediation_notes}` : '';
            return (
              <div key={f.id} style={{ ...findingStyle, background: raised ? `color-mix(in oklab, ${tone} 6%, transparent)` : 'var(--vscode-editor-background)' }}>
                <span aria-hidden style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, borderRadius: 'var(--vf-r-md) 0 0 var(--vf-r-md)', background: tone }} />
                <div style={findingHeaderStyle}>
                  <span style={severityStyle(sev)}>{severityMeta(sev).glyph} {sev}</span>
                  <strong style={{ fontWeight: 'var(--vf-weight-semibold)' as CSSProperties['fontWeight'], color: 'var(--feed-fg)' }}>{f.finding_type ?? 'Finding'}</strong>
                  <span style={{ color: 'var(--feed-muted)', fontSize: 'var(--vf-text-xs)' }}>{f.status ?? ''}</span>
                  {(f.compliance_tags ?? []).map((t, i) => (
                    <Chip key={i} variant="outline">{(t.framework ?? '').toUpperCase()}</Chip>
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

function VerdictLine({ glyph, tone, children }: { glyph: string; tone: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 'var(--vf-text-sm)', padding: '2px 0' }}>
      <span aria-hidden style={{ color: tone, fontWeight: 700, flexShrink: 0 }}>{glyph}</span>
      <span style={{ color: 'var(--feed-fg)' }}>{children}</span>
    </div>
  );
}

function ExecutionLogsSubtab({ snapshot, autoRefresh }: {
  snapshot: WorkItemPanelSnapshot | null; autoRefresh: boolean;
}) {
  // Freeze the rendered list when auto-refresh is off so polling-driven
  // snapshots don't disturb scroll. Re-renders resume when checked again.
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
      {logs.map((log, idx) => <LogEntry key={idx} log={log} />)}
    </div>
  );
}

function LogEntry({ log }: { log: WorkItemPanelSnapshot['execution_logs'][number] }) {
  const [expanded, setExpanded] = useState(false);
  const time = new Date(log.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const type = log.message_type ?? '';
  const icon = LOG_ICONS[type] ?? '📌';
  const dotColor = logTypeColor(type);
  // The content is markdown (publish_*_log summaries) — render it so `**bold**`,
  // `code`, bullets and → don't show as literal noise. normalizeEscapedMarkdown
  // handles agents that double-encoded their newlines (same as the Description).
  const raw = normalizeEscapedMarkdown(log.content ?? '');
  const allLines = raw.split('\n');
  const truncatable = allLines.length > 5;
  // Collapsed default keeps the original 5-line cap; expand reveals the rest.
  const shown = (expanded || !truncatable) ? raw : allLines.slice(0, 5).join('\n');
  return (
    <div style={logEntryStyle}>
      <span aria-hidden style={{ position: 'absolute', left: -12, top: 7, width: 9, height: 9, borderRadius: 'var(--vf-r-pill)', background: 'var(--feed-bg)', border: `1.5px solid ${dotColor}`, boxSizing: 'border-box' }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 3 }}>
          <span aria-hidden style={{ flex: '0 0 auto' }}>{icon}</span>
          {type && (
            <span style={{ ...logTypeChipStyle, color: dotColor, border: `1px solid color-mix(in oklab, ${dotColor} 35%, transparent)` }}>{type.replace(/_/g, ' ')}</span>
          )}
          <span style={{ marginLeft: 'auto', flex: '0 0 auto', fontSize: 'var(--vf-text-xs)', color: 'var(--feed-muted)', fontVariantNumeric: 'tabular-nums' }}>{time}</span>
        </div>
        <div className="prose-vf-block" style={{ fontSize: 'var(--vf-text-sm)', lineHeight: 1.55 }}>
          <MarkdownRenderer content={shown} inline />
        </div>
        {truncatable && (
          <button className="wiv-seg" style={{ marginTop: 'var(--vf-sp-1)', padding: '2px 8px' }} onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Show less' : `Show more (${allLines.length - 5} more lines)`}
          </button>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Helpers (unchanged logic)
// ============================================================

const LOG_ICONS: Record<string, string> = {
  thinking: '🤔',
  action: '⚡',
  observation: '👁',
  summary: '📋',
  diff: '📝',
  test_result: '🧪',
};

function statusMeta(status: string): { tone: string; glyph: string } {
  switch (status) {
    case 'done': return { tone: 'var(--feed-success)', glyph: '●' };
    case 'implementing': case 'in_progress': return { tone: 'var(--feed-link)', glyph: '◐' };
    case 'archived': case 'cancelled': case 'rejected': return { tone: 'var(--feed-muted)', glyph: '▢' };
    case 'planning': case 'ready_to_implement': case 'todo': case 'in_review': return { tone: 'var(--feed-muted)', glyph: '○' };
    default: return { tone: 'var(--feed-link)', glyph: '●' };
  }
}

function priorityColor(p: string): string {
  switch (p) {
    case 'high': return 'var(--feed-error)';
    case 'medium': return 'var(--feed-warning)';
    default: return 'var(--feed-muted)';
  }
}

function severityMeta(sev: string): { tone: string; glyph: string } {
  switch (sev) {
    case 'critical': return { tone: 'var(--feed-error)', glyph: '◆' };
    case 'high': return { tone: 'var(--vscode-charts-orange, var(--feed-warning))', glyph: '▲' };
    case 'medium': return { tone: 'var(--vscode-charts-yellow, var(--feed-warning))', glyph: '■' };
    case 'low': return { tone: 'var(--feed-link)', glyph: '▪' };
    default: return { tone: 'var(--feed-muted)', glyph: '○' };
  }
}

function fileGlyph(ct: string): string {
  if (ct.startsWith('image/')) { return '🖼'; }
  if (ct === 'application/pdf') { return '📄'; }
  if (ct.includes('zip') || ct.includes('tar') || ct.includes('compress')) { return '🗜'; }
  if (ct.startsWith('text/') || ct.includes('json') || ct.includes('xml')) { return '📃'; }
  return '📎';
}

function logTypeColor(t: string): string {
  switch (t) {
    case 'action': case 'summary': return 'var(--feed-link)';
    case 'diff': return 'var(--feed-warning)';
    case 'test_result': return 'var(--feed-success)';
    default: return 'var(--feed-muted)';
  }
}

/**
 * Some descriptions land with literal backslash-escape sequences instead of
 * real newlines (an MCP agent passed an already-JSON-encoded payload). Only
 * unescape when there are zero real newlines but literal `\n` is present, so a
 * legitimate two-char `\n` inside a code example isn't corrupted.
 */
function normalizeEscapedMarkdown(s: string): string {
  if (!s) { return s; }
  if (s.includes('\n')) { return s; }
  if (!s.includes('\\n') && !s.includes('\\t') && !s.includes('\\r')) { return s; }
  return s
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\\t/g, '\t');
}

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

function tintStyle(tone: string): CSSProperties {
  return {
    color: tone,
    background: `color-mix(in oklab, ${tone} 16%, transparent)`,
    border: `1px solid color-mix(in oklab, ${tone} 30%, transparent)`,
  };
}

function severityStyle(sev: string): CSSProperties {
  const { tone } = severityMeta(sev);
  return {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '1px 7px', borderRadius: 'var(--vf-r-sm)',
    fontSize: 'var(--vf-text-xs)', fontWeight: 600, letterSpacing: '0.02em', textTransform: 'uppercase',
    ...tintStyle(tone),
  };
}

// ============================================================
// Styles
// ============================================================

const containerStyle: CSSProperties = {
  fontFamily: 'var(--vscode-font-family)',
  fontSize: 'var(--vscode-font-size)',
  color: 'var(--feed-fg)',
  background: 'var(--feed-bg)',
  height: '100vh',
  overflowY: 'auto',
  position: 'relative',
};
const noContextStyle: CSSProperties = {
  padding: 'var(--vf-sp-5)', color: 'var(--feed-muted)', fontSize: 'var(--vf-text-sm)',
};
const stickyTopStyle: CSSProperties = {
  position: 'sticky', top: 0, zIndex: 20, background: 'var(--feed-bg)', padding: '0 var(--vf-sp-4)',
};
const headerStyle: CSSProperties = {
  paddingTop: 'var(--vf-sp-4)', paddingBottom: 'var(--vf-sp-3)',
  transition: 'padding var(--vf-t-quick) var(--vf-ease)',
};
const headerCollapsedStyle: CSSProperties = {
  paddingTop: 'var(--vf-sp-3)', paddingBottom: 'var(--vf-sp-2)',
  borderBottom: '1px solid var(--feed-border)',
  boxShadow: '0 1px 2px color-mix(in oklab, var(--vscode-foreground) 8%, transparent)',
};
const eyebrowStyle: CSSProperties = {
  display: 'flex', gap: 'var(--vf-sp-2)', alignItems: 'center',
  fontSize: 'var(--vf-text-sm)', color: 'var(--feed-muted)', marginBottom: 'var(--vf-sp-2)',
};
const eyebrowIdStyle: CSSProperties = {
  fontFamily: 'var(--vf-font-mono)', color: 'var(--feed-fg)',
  fontWeight: 'var(--vf-weight-medium)' as CSSProperties['fontWeight'], fontVariantNumeric: 'tabular-nums',
};
const titleRowStyle: CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: 'var(--vf-sp-4)', flexWrap: 'wrap',
};
const titleStyle: CSSProperties = {
  margin: 0, flex: '1 1 280px', minWidth: 0,
  fontFamily: 'var(--vf-font-display)', fontSize: 'var(--vf-text-xl)',
  fontWeight: 'var(--vf-weight-semibold)' as CSSProperties['fontWeight'],
  letterSpacing: 'var(--vf-tracking-tight)', lineHeight: 1.25,
  color: 'var(--feed-fg)',
  transition: 'font-size var(--vf-t-quick) var(--vf-ease)',
};
const titleCollapsedStyle: CSSProperties = { fontSize: 'var(--vf-text-md)' };
const toolbarStyle: CSSProperties = {
  display: 'flex', gap: 'var(--vf-sp-2)', alignItems: 'center', flexWrap: 'wrap', flex: '1 1 auto',
  justifyContent: 'flex-end', minWidth: 0,
};
const metaRowStyle: CSSProperties = {
  display: 'flex', flexWrap: 'wrap', gap: 'var(--vf-sp-2)', alignItems: 'center', marginTop: 'var(--vf-sp-3)',
};
const pillBase: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5, height: 20, padding: '0 8px',
  borderRadius: 'var(--vf-r-sm)', fontSize: 'var(--vf-text-xs)',
  fontWeight: 'var(--vf-weight-semibold)' as CSSProperties['fontWeight'], letterSpacing: '0.02em', whiteSpace: 'nowrap',
};
const tabsStyle: CSSProperties = {
  display: 'flex', gap: 'var(--vf-sp-3)', alignItems: 'stretch',
  borderBottom: '1px solid var(--feed-border)', paddingTop: 'var(--vf-sp-2)',
};
const tabContentStyle: CSSProperties = { padding: 'var(--vf-sp-4)' };
const sectionLabelStyle: CSSProperties = {
  fontFamily: 'var(--vf-font-display)', fontSize: 'var(--vf-text-xs)',
  fontWeight: 'var(--vf-weight-semibold)' as CSSProperties['fontWeight'], letterSpacing: 'var(--vf-tracking-caps)',
  textTransform: 'uppercase', color: 'var(--feed-muted)', marginBottom: 'var(--vf-sp-2)',
};
const descriptionWrapStyle: CSSProperties = {
  padding: 'var(--vf-sp-4)',
  background: 'var(--vscode-textBlockQuote-background)',
  border: '1px solid var(--feed-border)', borderRadius: 'var(--vf-r-md)',
  // No inner scroll cap — the description grows to fit its content and the panel
  // itself scrolls (single scroll context + sticky header), so the whole body is
  // visible without a nested scrollbar. (#2571)
  lineHeight: 1.6,
  boxShadow: 'inset 0 1px 0 color-mix(in oklab, var(--vscode-foreground) 4%, transparent)',
};
const emptyStyle: CSSProperties = {
  color: 'var(--feed-muted)', fontStyle: 'italic', padding: '8px 0', fontSize: 'var(--vf-text-sm)',
};
const emptyDashedStyle: CSSProperties = {
  border: '1px dashed var(--feed-border)', borderRadius: 'var(--vf-r-md)',
  padding: 'var(--vf-sp-4)', textAlign: 'center', color: 'var(--feed-muted)',
  fontStyle: 'italic', fontSize: 'var(--vf-text-sm)',
};
const detailsGridStyle: CSSProperties = {
  display: 'grid', gridTemplateColumns: 'max-content 1fr',
  gap: 'var(--vf-sp-2) var(--vf-sp-4)', fontSize: 'var(--vf-text-base)', alignItems: 'baseline',
};
const labelStyle: CSSProperties = {
  fontSize: 'var(--vf-text-xs)', color: 'var(--feed-muted)',
  fontWeight: 'var(--vf-weight-medium)' as CSSProperties['fontWeight'], textTransform: 'uppercase', letterSpacing: 'var(--vf-tracking-caps)',
};
const numCell: CSSProperties = { fontVariantNumeric: 'tabular-nums' };
const attachmentStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 'var(--vf-sp-3)', height: 36, padding: '0 var(--vf-sp-3)',
  border: '1px solid var(--feed-border)', borderRadius: 'var(--vf-r-sm)', marginBottom: 'var(--vf-sp-2)', fontSize: 'var(--vf-text-sm)',
};
const segmentWrapStyle: CSSProperties = {
  display: 'inline-flex', border: '1px solid var(--feed-border)', borderRadius: 'var(--vf-r-sm)', overflow: 'hidden', padding: 1, gap: 1,
};
const logsContainerStyle: CSSProperties = {
  maxHeight: '50vh', overflowY: 'auto', position: 'relative', paddingLeft: 'var(--vf-sp-4)',
  fontSize: 'var(--vf-text-sm)',
  borderLeft: '1px solid var(--feed-border)', marginLeft: 6,
};
const logEntryStyle: CSSProperties = {
  position: 'relative', display: 'flex', gap: 'var(--vf-sp-2)', padding: '2px 0 var(--vf-sp-3)', alignItems: 'flex-start',
};
const logTypeChipStyle: CSSProperties = {
  fontSize: 9.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
  padding: '0 5px', borderRadius: 'var(--vf-r-sm)', background: 'transparent', flex: '0 0 auto',
};
const findingStyle: CSSProperties = {
  position: 'relative', padding: 'var(--vf-sp-3) var(--vf-sp-3) var(--vf-sp-3) calc(var(--vf-sp-3) + 4px)',
  border: '1px solid var(--feed-border)', borderRadius: 'var(--vf-r-md)', marginBottom: 'var(--vf-sp-2)', maxWidth: 760,
};
const findingHeaderStyle: CSSProperties = {
  display: 'flex', gap: 'var(--vf-sp-2)', alignItems: 'center', flexWrap: 'wrap',
};
const findingDescStyle: CSSProperties = {
  marginTop: 'var(--vf-sp-2)', fontSize: 'var(--vf-text-sm)', color: 'var(--feed-muted)',
  whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxWidth: '72ch',
};
const timeMuted: CSSProperties = { color: 'var(--feed-muted)', fontVariantNumeric: 'tabular-nums' };
