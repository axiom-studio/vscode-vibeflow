import { useState, useEffect, useCallback, useMemo } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { getVsCodeApi } from '../vscodeApi';
import type { VibeFlowComplianceFinding } from '../types';
import { EmptyState } from './_shared/EmptyState';
import { StatusPill } from './_shared/StatusPill';
import { ChevronIcon, InboxIcon, SpinnerIcon } from './_shared/icons';

interface ComplianceClientMessage {
  type: 'complianceLoad' | 'complianceRefresh' | 'complianceOpenWorkItem' | 'complianceExportCsv';
  payload?: unknown;
}

const vscode = getVsCodeApi() as { postMessage: (msg: ComplianceClientMessage) => void };

// ============================================================
// Framework allowlist — mirrors axiomcloud's
// `VibeflowComplianceFramework.IsValid`. Display labels use the
// industry-standard casing.
// ============================================================
const FRAMEWORKS = ['hipaa', 'pcidss', 'soc2', 'iso27001', 'gdpr', 'cmmc', 'fedramp'] as const;
type Framework = typeof FRAMEWORKS[number];
const FRAMEWORK_LABEL: Record<Framework, string> = {
  hipaa: 'HIPAA',
  pcidss: 'PCI-DSS',
  soc2: 'SOC 2',
  iso27001: 'ISO 27001',
  gdpr: 'GDPR',
  cmmc: 'CMMC',
  fedramp: 'FedRAMP',
};

type Severity = VibeFlowComplianceFinding['severity'];
type Status = VibeFlowComplianceFinding['status'];

const SEVERITY_COLOR: Record<Severity, string> = {
  critical: 'var(--feed-error)',
  high: 'var(--feed-error)',
  medium: 'var(--feed-warning)',
  low: 'var(--feed-muted)',
  informational: 'var(--feed-link)',
};
const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0, high: 1, medium: 2, low: 3, informational: 4,
};
const STATUS_COLOR: Record<Status, string> = {
  open: 'var(--feed-error)',
  in_progress: 'var(--feed-warning)',
  resolved: 'var(--feed-success)',
  accepted_risk: 'var(--feed-muted)',
};
const STATUS_LABEL: Record<Status, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  resolved: 'Resolved',
  accepted_risk: 'Accepted',
};

// ============================================================
// Snapshot mirror (matches CompliancePanel.ts shape)
// ============================================================
interface FrameworkSummary {
  framework: Framework;
  label: string;
  total: number;
  open: number;
  in_progress: number;
  resolved: number;
  accepted_risk: number;
}
interface TopStats {
  total: number; open: number; resolved: number; high: number;
  items_reviewed: number; awaiting_review: number;
}
interface ComplianceSnapshot {
  projectId: number;
  projectName: string;
  generatedAt: string;
  findings: VibeFlowComplianceFinding[];
  summary: Record<Framework, FrameworkSummary>;
  topStats: TopStats;
  errors: string[];
}
interface ComplianceState {
  snapshot: ComplianceSnapshot | undefined;
  loading: boolean;
  error: string | undefined;
}

type FrameworkFilter = Framework | 'all' | 'untagged';
interface Filters {
  severity: Severity | 'all';
  status: Status | 'all';
  framework: FrameworkFilter;
  search: string;
}
const DEFAULT_FILTERS: Filters = { severity: 'all', status: 'all', framework: 'all', search: '' };

// ============================================================
// Top-level view
// ============================================================
export function ComplianceView() {
  const [state, setState] = useState<ComplianceState>({ snapshot: undefined, loading: true, error: undefined });
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  useEffect(() => {
    vscode.postMessage({ type: 'complianceLoad' });
  }, []);

  useEffect(() => {
    function onMessage(event: MessageEvent<{ type: string; payload: unknown }>) {
      const msg = event.data;
      if (msg?.type === 'complianceData' && msg.payload) {
        setState({ snapshot: msg.payload as ComplianceSnapshot, loading: false, error: undefined });
      } else if (msg?.type === 'complianceError') {
        const payload = msg.payload as { message: string };
        setState(s => ({ ...s, loading: false, error: payload.message }));
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const refresh = useCallback(() => {
    setState(s => ({ ...s, loading: true }));
    vscode.postMessage({ type: 'complianceRefresh' });
  }, []);

  const openWorkItem = useCallback((workItemType: string, workItemId: number) => {
    vscode.postMessage({
      type: 'complianceOpenWorkItem',
      payload: { workItemType, workItemId },
    });
  }, []);

  const toggleExpanded = useCallback((id: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
  }, []);

  const filtered = useMemo(() => {
    const findings = state.snapshot?.findings ?? [];
    const search = filters.search.trim().toLowerCase();
    return findings
      .filter(f => filters.severity === 'all' || f.severity === filters.severity)
      .filter(f => {
        if (filters.status === 'all') { return true; }
        const status = (f.effective_status ?? f.status).toLowerCase();
        return status === filters.status;
      })
      .filter(f => {
        if (filters.framework === 'all') { return true; }
        const tags = f.compliance_tags ?? [];
        if (filters.framework === 'untagged') { return tags.length === 0; }
        return tags.some(t => t.framework === filters.framework);
      })
      .filter(f => {
        if (!search) { return true; }
        const hay = [
          f.finding_type ?? '',
          f.description ?? '',
          f.remediation_notes ?? '',
          `${f.work_item_type}#${f.work_item_id}`,
          f.source_item_type ? `${f.source_item_type}#${f.source_item_id}` : '',
          ...((f.compliance_tags ?? []).map(t => `${t.framework} ${t.section_reference ?? ''}`)),
        ].join(' ').toLowerCase();
        return hay.includes(search);
      })
      .sort((a, b) => {
        const sev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
        if (sev !== 0) { return sev; }
        const aOpen = (a.effective_status ?? a.status) === 'open' ? 0 : 1;
        const bOpen = (b.effective_status ?? b.status) === 'open' ? 0 : 1;
        if (aOpen !== bOpen) { return aOpen - bOpen; }
        return (b.created_at ?? '').localeCompare(a.created_at ?? '');
      });
  }, [state.snapshot, filters]);

  const populatedFrameworks = useMemo(() => {
    if (!state.snapshot) { return []; }
    return FRAMEWORKS
      .map(fw => state.snapshot!.summary[fw])
      .filter(s => s.total > 0)
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [state.snapshot]);

  const exportCsv = useCallback(() => {
    if (!state.snapshot) { return; }
    const header = ['Date', 'Type', 'Severity', 'Frameworks', 'Section Ref', 'Source Item', 'Addressed By', 'Compat', 'Status', 'Description', 'Remediation Notes'];
    const rows: string[][] = [header];
    for (const f of filtered) {
      const status = (f.effective_status ?? f.status) as Status;
      const tags = f.compliance_tags ?? [];
      const frameworks = tags.map(t => FRAMEWORK_LABEL[t.framework as Framework] ?? t.framework).join('; ');
      const sectionRefs = tags.map(t => t.section_reference ?? '').filter(Boolean).join('; ');
      rows.push([
        formatDate(f.created_at),
        f.finding_type,
        f.severity,
        frameworks,
        sectionRefs,
        `${f.work_item_type} #${f.work_item_id}`,
        f.source_item_type ? `${f.source_item_type} #${f.source_item_id}` : '',
        f.backward_compatible === true ? 'yes' : f.backward_compatible === false ? 'no' : '',
        STATUS_LABEL[status],
        f.description ?? '',
        f.remediation_notes ?? '',
      ]);
    }
    const safeName = `compliance-${state.snapshot.projectName.replace(/[^A-Za-z0-9._-]/g, '_')}-${todayIso()}.csv`;
    vscode.postMessage({
      type: 'complianceExportCsv',
      payload: { rows, defaultName: safeName },
    });
  }, [state.snapshot, filtered]);

  return (
    <div style={{
      width: '100%',
      minHeight: '100dvh',
      background: 'var(--feed-bg)',
      overflow: 'auto',
      display: 'flex',
      flexDirection: 'column',
    }}>
      <Header
        snapshot={state.snapshot}
        loading={state.loading}
        onRefresh={refresh}
      />

      {state.error && <Banner kind="error" message={state.error} />}
      {state.snapshot && state.snapshot.errors.length > 0 && (
        <Banner kind="warning" message={`Partial data: ${state.snapshot.errors.join(' · ')}`} />
      )}

      <TopStatsBar stats={state.snapshot?.topStats} loading={state.loading} />

      <FrameworkRow
        cards={populatedFrameworks}
        loading={state.loading}
        activeFilter={filters.framework}
        onPickFramework={(fw) => setFilters(prev => ({ ...prev, framework: fw }))}
      />

      <FilterBar
        filters={filters}
        setFilters={setFilters}
        onExportCsv={exportCsv}
        canExport={filtered.length > 0}
      />

      <FindingsTable
        findings={filtered}
        totalUnfiltered={state.snapshot?.topStats.total ?? 0}
        loading={state.loading}
        expanded={expanded}
        onToggle={toggleExpanded}
        onOpenWorkItem={openWorkItem}
      />

      <div style={{ flex: 1 }} />
    </div>
  );
}

// ============================================================
// Header
// ============================================================
function Header({ snapshot, loading, onRefresh }: {
  snapshot: ComplianceSnapshot | undefined;
  loading: boolean;
  onRefresh: () => void;
}) {
  const generated = snapshot?.generatedAt
    ? new Date(snapshot.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '';
  return (
    <div style={{
      padding: '12px 18px',
      borderBottom: '1px solid var(--feed-border)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      flexShrink: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
        <span style={{
          fontSize: 14,
          fontWeight: 600,
          color: 'var(--feed-fg)',
          letterSpacing: '-0.005em',
        }}>
          Compliance
        </span>
        {snapshot?.projectName && (
          <span style={{ fontSize: 12, color: 'var(--feed-muted)' }}>
            · {snapshot.projectName}
          </span>
        )}
        {generated && (
          <span style={{
            fontSize: 11,
            color: 'var(--feed-muted)',
            opacity: 0.7,
            fontVariantNumeric: 'tabular-nums',
          }}>
            updated {generated}
          </span>
        )}
      </div>
      <button
        onClick={onRefresh}
        disabled={loading}
        className="transition-all duration-150 ease-out active:scale-[0.97]"
        style={{
          padding: '5px 12px',
          fontSize: 11,
          fontWeight: 500,
          background: 'var(--feed-button-bg)',
          color: 'var(--feed-button-fg)',
          border: 'none',
          borderRadius: 4,
          cursor: loading ? 'wait' : 'pointer',
          opacity: loading ? 0.7 : 1,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        {loading && <SpinnerIcon size={11} />}
        {loading ? 'Loading' : 'Refresh'}
      </button>
    </div>
  );
}

function Banner({ kind, message }: { kind: 'error' | 'warning'; message: string }) {
  const fg = kind === 'error' ? 'var(--feed-error)' : 'var(--feed-warning)';
  return (
    <div style={{
      padding: '6px 18px',
      fontSize: 11,
      background: `color-mix(in oklab, ${fg} 12%, transparent)`,
      color: fg,
      borderBottom: '1px solid var(--feed-border)',
    }}>
      {message}
    </div>
  );
}

// ============================================================
// Top stats row (6 numeric tiles)
// ============================================================
function TopStatsBar({ stats, loading }: { stats: TopStats | undefined; loading: boolean }) {
  if (!stats && loading) {
    return (
      <div style={{
        padding: '14px 18px',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
        gap: 10,
        borderBottom: '1px solid var(--feed-border)',
      }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="shimmer" style={{ height: 64, borderRadius: 8 }} />
        ))}
      </div>
    );
  }
  if (!stats) { return null; }
  const tiles: Array<{ label: string; value: number; accent?: string }> = [
    { label: 'Total Findings', value: stats.total },
    { label: 'Open', value: stats.open, accent: stats.open > 0 ? 'var(--feed-error)' : undefined },
    { label: 'Resolved', value: stats.resolved, accent: stats.resolved > 0 ? 'var(--feed-success)' : undefined },
    { label: 'High', value: stats.high, accent: stats.high > 0 ? 'var(--feed-error)' : undefined },
    { label: 'Items Reviewed', value: stats.items_reviewed, accent: 'var(--feed-success)' },
    { label: 'Awaiting Review', value: stats.awaiting_review, accent: stats.awaiting_review > 0 ? 'var(--feed-warning)' : undefined },
  ];
  return (
    <div style={{
      padding: '14px 18px',
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
      gap: 10,
      borderBottom: '1px solid var(--feed-border)',
    }}>
      {tiles.map(tile => (
        <StatTile key={tile.label} label={tile.label} value={tile.value} accent={tile.accent} />
      ))}
    </div>
  );
}

function StatTile({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div style={{
      padding: '12px 14px',
      borderRadius: 8,
      background: 'var(--vscode-editor-background)',
      border: '1px solid var(--feed-border)',
      boxShadow: '0 1px 2px color-mix(in oklab, var(--vscode-foreground) 8%, transparent)',
      minWidth: 0,
    }}>
      <div style={{
        fontSize: 25,
        fontWeight: 600,
        color: accent ?? 'var(--feed-fg)',
        fontVariantNumeric: 'tabular-nums',
        letterSpacing: '-0.018em',
        lineHeight: 1.05,
      }}>
        {value}
      </div>
      <div style={{
        fontSize: 10.5,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        color: 'var(--feed-muted)',
        marginTop: 4,
      }}>
        {label}
      </div>
    </div>
  );
}

// ============================================================
// Framework row — only populated frameworks, alpha sorted
// ============================================================
function FrameworkRow({ cards, loading, activeFilter, onPickFramework }: {
  cards: FrameworkSummary[];
  loading: boolean;
  activeFilter: FrameworkFilter;
  onPickFramework: (fw: FrameworkFilter) => void;
}) {
  if (loading && cards.length === 0) {
    return (
      <div style={{
        padding: '0 18px 14px',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: 10,
      }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="shimmer" style={{ height: 78, borderRadius: 8 }} />
        ))}
      </div>
    );
  }
  if (cards.length === 0) {
    return null; // nothing to show; the empty-state inside FindingsTable covers the zero case
  }
  return (
    <div style={{
      padding: '0 18px 14px',
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
      gap: 10,
    }}>
      {cards.map(card => {
        const fw = card.framework;
        const isActive = activeFilter === fw;
        return (
          <button
            key={fw}
            type="button"
            onClick={() => onPickFramework(isActive ? 'all' : fw)}
            title={`Filter findings by ${card.label}`}
            className="transition-all duration-150 ease-out active:scale-[0.99]"
            style={{
              textAlign: 'left',
              padding: '12px 14px',
              borderRadius: 8,
              background: 'var(--vscode-editor-background)',
              border: isActive
                ? '1px solid color-mix(in oklab, var(--feed-link) 60%, transparent)'
                : '1px solid var(--feed-border)',
              cursor: 'pointer',
              color: 'var(--feed-fg)',
              boxShadow: isActive
                ? 'inset 0 0 0 1px color-mix(in oklab, var(--feed-link) 20%, transparent), 0 1px 3px color-mix(in oklab, var(--vscode-foreground) 10%, transparent)'
                : '0 1px 2px color-mix(in oklab, var(--vscode-foreground) 8%, transparent)',
            }}
          >
            <div style={{
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--feed-fg)',
              letterSpacing: '-0.005em',
            }}>
              {card.label}
            </div>
            <div style={{
              fontSize: 11,
              color: 'var(--feed-muted)',
              marginTop: 4,
              fontVariantNumeric: 'tabular-nums',
              lineHeight: 1.5,
            }}>
              <div>{card.total} {card.total === 1 ? 'finding' : 'findings'}</div>
              <div>{card.open} open</div>
              <div>{card.resolved} resolved</div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ============================================================
// Filter bar + Export CSV
// ============================================================
function FilterBar({ filters, setFilters, onExportCsv, canExport }: {
  filters: Filters;
  setFilters: (f: Filters) => void;
  onExportCsv: () => void;
  canExport: boolean;
}) {
  const selectStyle: CSSProperties = {
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    border: '1px solid var(--vscode-input-border, var(--feed-border))',
    borderRadius: 4,
    fontSize: 11,
    padding: '4px 8px',
    minHeight: 28,
    cursor: 'pointer',
  };
  const hasActive = filters.search || filters.severity !== 'all' || filters.status !== 'all' || filters.framework !== 'all';
  return (
    <div style={{
      padding: '12px 18px',
      borderBottom: '1px solid var(--feed-border)',
      display: 'flex',
      flexWrap: 'wrap',
      gap: 8,
      alignItems: 'center',
    }}>
      <input
        type="search"
        value={filters.search}
        onChange={e => setFilters({ ...filters, search: e.target.value })}
        placeholder="Search findings…"
        style={{
          flex: '1 1 220px',
          minWidth: 200,
          maxWidth: 360,
          padding: '5px 10px',
          fontSize: 11.5,
          background: 'var(--vscode-input-background)',
          color: 'var(--vscode-input-foreground)',
          border: '1px solid var(--vscode-input-border, var(--feed-border))',
          borderRadius: 4,
          outline: 'none',
        }}
      />
      <select
        value={filters.framework}
        onChange={e => setFilters({ ...filters, framework: e.target.value as FrameworkFilter })}
        style={selectStyle}
        aria-label="Filter by framework"
      >
        <option value="all">All Frameworks</option>
        {FRAMEWORKS.map(fw => <option key={fw} value={fw}>{FRAMEWORK_LABEL[fw]}</option>)}
        <option value="untagged">Untagged</option>
      </select>
      <select
        value={filters.severity}
        onChange={e => setFilters({ ...filters, severity: e.target.value as Filters['severity'] })}
        style={selectStyle}
        aria-label="Filter by severity"
      >
        <option value="all">All Severities</option>
        <option value="critical">Critical</option>
        <option value="high">High</option>
        <option value="medium">Medium</option>
        <option value="low">Low</option>
        <option value="informational">Informational</option>
      </select>
      <select
        value={filters.status}
        onChange={e => setFilters({ ...filters, status: e.target.value as Filters['status'] })}
        style={selectStyle}
        aria-label="Filter by status"
      >
        <option value="all">All Statuses</option>
        <option value="open">Open</option>
        <option value="in_progress">In Progress</option>
        <option value="resolved">Resolved</option>
        <option value="accepted_risk">Accepted Risk</option>
      </select>
      {hasActive && (
        <button
          type="button"
          onClick={() => setFilters(DEFAULT_FILTERS)}
          className="transition-all duration-150 ease-out active:scale-[0.97]"
          style={{ ...selectStyle, background: 'transparent', color: 'var(--feed-muted)' }}
        >
          Clear filters
        </button>
      )}
      <span style={{ flex: 1 }} />
      <button
        type="button"
        onClick={onExportCsv}
        disabled={!canExport}
        className="transition-all duration-150 ease-out active:scale-[0.97]"
        style={{
          padding: '5px 12px',
          fontSize: 11,
          fontWeight: 500,
          background: 'var(--feed-button-bg)',
          color: 'var(--feed-button-fg)',
          border: 'none',
          borderRadius: 4,
          cursor: canExport ? 'pointer' : 'not-allowed',
          opacity: canExport ? 1 : 0.5,
        }}
      >
        Export CSV
      </button>
    </div>
  );
}

// ============================================================
// Findings table — axiomcloud-mirror layout
// ============================================================

const COLUMN_WIDTHS = {
  expand: '28px',
  date: '92px',
  type: 'minmax(180px, 1.4fr)',
  severity: '110px',
  frameworks: 'minmax(140px, 1fr)',
  section: 'minmax(120px, 1fr)',
  source: '120px',
  addressed: '120px',
  compat: '64px',
  status: '110px',
};

function FindingsTable({ findings, totalUnfiltered, loading, expanded, onToggle, onOpenWorkItem }: {
  findings: VibeFlowComplianceFinding[];
  totalUnfiltered: number;
  loading: boolean;
  expanded: Set<number>;
  onToggle: (id: number) => void;
  onOpenWorkItem: (workItemType: string, workItemId: number) => void;
}) {
  if (loading && findings.length === 0) {
    return (
      <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="shimmer" style={{ height: 44, borderRadius: 6 }} />
        ))}
      </div>
    );
  }
  if (findings.length === 0) {
    if (totalUnfiltered === 0) {
      return (
        <div style={{ padding: '32px 18px' }}>
          <EmptyState
            icon={<InboxIcon size={28} />}
            headline="No compliance findings yet"
            subtext="When agents file findings during security review or compliance checks, they'll show up here."
          />
        </div>
      );
    }
    return (
      <div style={{ padding: '24px 18px' }}>
        <EmptyState
          icon={<InboxIcon size={22} />}
          headline="No findings match these filters"
          subtext="Try a broader severity, status, or framework."
        />
      </div>
    );
  }

  const gridTemplate = [
    COLUMN_WIDTHS.expand,
    COLUMN_WIDTHS.date,
    COLUMN_WIDTHS.type,
    COLUMN_WIDTHS.severity,
    COLUMN_WIDTHS.frameworks,
    COLUMN_WIDTHS.section,
    COLUMN_WIDTHS.source,
    COLUMN_WIDTHS.addressed,
    COLUMN_WIDTHS.compat,
    COLUMN_WIDTHS.status,
  ].join(' ');

  return (
    <div style={{ padding: '0 18px 18px' }}>
      <div
        role="table"
        aria-label="Compliance findings"
        style={{
          border: '1px solid var(--feed-border)',
          borderRadius: 8,
          overflow: 'hidden',
          background: 'var(--vscode-editor-background)',
        }}
      >
        <TableHeaderRow gridTemplate={gridTemplate} />
        {findings.map(finding => (
          <FindingRow
            key={finding.id}
            finding={finding}
            gridTemplate={gridTemplate}
            isExpanded={expanded.has(finding.id)}
            onToggle={() => onToggle(finding.id)}
            onOpenWorkItem={onOpenWorkItem}
          />
        ))}
      </div>
    </div>
  );
}

function TableHeaderRow({ gridTemplate }: { gridTemplate: string }) {
  const cellStyle: CSSProperties = {
    padding: '8px 10px',
    fontSize: 10.5,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    color: 'var(--feed-muted)',
    borderBottom: '1px solid var(--feed-border)',
    background: 'color-mix(in oklab, var(--vscode-foreground) 4%, transparent)',
    whiteSpace: 'nowrap',
  };
  return (
    <div role="row" style={{ display: 'grid', gridTemplateColumns: gridTemplate, alignItems: 'center' }}>
      <div style={cellStyle} />
      <div style={cellStyle}>Date</div>
      <div style={cellStyle}>Type</div>
      <div style={cellStyle}>Severity</div>
      <div style={cellStyle}>Frameworks</div>
      <div style={cellStyle}>Section Ref</div>
      <div style={cellStyle}>Source Item</div>
      <div style={cellStyle}>Addressed By</div>
      <div style={cellStyle}>Compat</div>
      <div style={cellStyle}>Status</div>
    </div>
  );
}

function FindingRow({ finding, gridTemplate, isExpanded, onToggle, onOpenWorkItem }: {
  finding: VibeFlowComplianceFinding;
  gridTemplate: string;
  isExpanded: boolean;
  onToggle: () => void;
  onOpenWorkItem: (workItemType: string, workItemId: number) => void;
}) {
  const status = (finding.effective_status ?? finding.status) as Status;
  const isCriticalOpen = (finding.severity === 'critical' || finding.severity === 'high') && status === 'open';
  const cellStyle: CSSProperties = {
    padding: '9px 10px',
    fontSize: 11.5,
    color: 'var(--feed-fg)',
    borderBottom: '1px solid color-mix(in oklab, var(--feed-border) 60%, transparent)',
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
  };
  const tags = finding.compliance_tags ?? [];
  const sectionRefs = tags.map(t => t.section_reference).filter(Boolean) as string[];

  return (
    <>
      <div
        role="row"
        style={{
          display: 'grid',
          gridTemplateColumns: gridTemplate,
          alignItems: 'stretch',
          background: isCriticalOpen
            ? 'color-mix(in oklab, var(--feed-error) 5%, transparent)'
            : undefined,
          borderLeft: isCriticalOpen
            ? '2px solid color-mix(in oklab, var(--feed-error) 55%, transparent)'
            : '2px solid transparent',
          cursor: 'pointer',
          transition: 'background 120ms ease-out',
        }}
        className="hover:bg-[var(--vscode-list-hoverBackground)]"
        onClick={onToggle}
      >
        <div style={cellStyle}>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggle(); }}
            aria-label={isExpanded ? 'Collapse details' : 'Expand details'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 18,
              height: 18,
              padding: 0,
              border: 'none',
              background: 'transparent',
              color: 'var(--feed-muted)',
              cursor: 'pointer',
              borderRadius: 3,
            }}
          >
            <span style={{
              display: 'inline-flex',
              transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 160ms cubic-bezier(0.23, 1, 0.32, 1)',
            }}>
              <ChevronIcon size={11} />
            </span>
          </button>
        </div>
        <div style={{ ...cellStyle, fontVariantNumeric: 'tabular-nums', color: 'var(--feed-muted)' }}>
          {formatDate(finding.created_at)}
        </div>
        <div style={{ ...cellStyle, fontWeight: 500, letterSpacing: '-0.005em' }} title={finding.finding_type}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {finding.finding_type}
          </span>
        </div>
        <div style={cellStyle}>
          <StatusPill color={SEVERITY_COLOR[finding.severity]} size="md">
            {finding.severity}
          </StatusPill>
        </div>
        <div style={cellStyle}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
            {tags.length === 0
              ? <span style={{ fontSize: 10.5, color: 'var(--feed-muted)', opacity: 0.7 }}>none</span>
              : tags.map((t, i) => <FrameworkBadge key={`${t.framework}-${i}`} framework={t.framework} />)}
          </div>
        </div>
        <div style={{ ...cellStyle, color: 'var(--feed-muted)' }}>
          <span style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: sectionRefs.length > 0 ? 'var(--vscode-editor-font-family)' : undefined,
            fontSize: sectionRefs.length > 0 ? 10.5 : undefined,
          }}>
            {sectionRefs.length > 0 ? sectionRefs.join(', ') : '—'}
          </span>
        </div>
        <div style={cellStyle}>
          <WorkItemLink
            workItemType={finding.work_item_type}
            workItemId={finding.work_item_id}
            onOpen={onOpenWorkItem}
          />
        </div>
        <div style={cellStyle}>
          {finding.source_item_type && finding.source_item_id !== undefined
            ? <WorkItemLink
                workItemType={finding.source_item_type}
                workItemId={finding.source_item_id}
                onOpen={onOpenWorkItem}
              />
            : <span style={{ fontSize: 10.5, color: 'var(--feed-muted)', opacity: 0.7 }}>—</span>}
        </div>
        <div style={{ ...cellStyle, justifyContent: 'center', color: 'var(--feed-muted)' }}>
          {finding.backward_compatible === true
            ? <span style={{ color: 'var(--feed-success)', fontWeight: 600 }} title="Backward compatible">✓</span>
            : finding.backward_compatible === false
              ? <span style={{ color: 'var(--feed-warning)', fontWeight: 600 }} title="Not backward compatible">✗</span>
              : <span style={{ opacity: 0.5 }}>—</span>}
        </div>
        <div style={cellStyle}>
          <StatusPill color={STATUS_COLOR[status]} size="md">
            {STATUS_LABEL[status]}
          </StatusPill>
        </div>
      </div>
      {isExpanded && (
        <ExpandedDetails finding={finding} />
      )}
    </>
  );
}

function ExpandedDetails({ finding }: { finding: VibeFlowComplianceFinding }) {
  return (
    <div
      role="row"
      style={{
        padding: '14px 18px 16px 50px',
        borderBottom: '1px solid color-mix(in oklab, var(--feed-border) 60%, transparent)',
        background: 'color-mix(in oklab, var(--vscode-foreground) 2%, transparent)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      {finding.description && (
        <DetailField label="Description" body={finding.description} />
      )}
      {finding.remediation_notes && (
        <DetailField label="Remediation Notes" body={finding.remediation_notes} />
      )}
      {finding.resolution_commit && (
        <DetailField
          label="Resolution Commit"
          body={
            <span style={{
              fontFamily: 'var(--vscode-editor-font-family)',
              fontSize: 11.5,
            }}>
              {finding.resolution_commit}
            </span>
          }
        />
      )}
      {(finding.resolved_at || finding.resolved_by) && (
        <div style={{ fontSize: 11, color: 'var(--feed-muted)' }}>
          Resolved
          {finding.resolved_at && <> on <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatDate(finding.resolved_at)}</span></>}
          {finding.resolved_by && <> by {finding.resolved_by}</>}
        </div>
      )}
      {!finding.description && !finding.remediation_notes && !finding.resolution_commit && !finding.resolved_at && (
        <div style={{ fontSize: 11.5, color: 'var(--feed-muted)', fontStyle: 'italic' }}>
          No additional details recorded.
        </div>
      )}
    </div>
  );
}

function DetailField({ label, body }: { label: string; body: ReactNode }) {
  return (
    <div>
      <div style={{
        fontSize: 10,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        color: 'var(--feed-muted)',
        marginBottom: 4,
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 11.5,
        color: 'var(--feed-fg)',
        lineHeight: 1.5,
        maxWidth: '95ch',
        whiteSpace: 'pre-wrap',
      }}>
        {body}
      </div>
    </div>
  );
}

function FrameworkBadge({ framework }: { framework: string }) {
  const fw = framework as Framework;
  const label = (fw in FRAMEWORK_LABEL) ? FRAMEWORK_LABEL[fw] : framework;
  return (
    <span
      style={{
        fontSize: 9.5,
        fontWeight: 600,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        padding: '1px 5px',
        borderRadius: 3,
        background: 'color-mix(in oklab, var(--feed-link) 14%, transparent)',
        color: 'var(--feed-link)',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}

function WorkItemLink({ workItemType, workItemId, onOpen }: {
  workItemType: string;
  workItemId: number;
  onOpen: (workItemType: string, workItemId: number) => void;
}) {
  const label = `${workItemType} #${workItemId}`;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onOpen(workItemType, workItemId); }}
      title={`Open ${label}`}
      className="transition-colors duration-100 ease-out"
      style={{
        fontSize: 11,
        fontFamily: 'var(--vscode-editor-font-family)',
        padding: '2px 6px',
        borderRadius: 3,
        background: 'color-mix(in oklab, var(--vscode-foreground) 8%, transparent)',
        color: 'var(--feed-link)',
        border: 'none',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}

// ============================================================
// Utils
// ============================================================
function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) { return ''; }
    return d.toLocaleDateString([], { month: 'numeric', day: 'numeric', year: 'numeric' });
  } catch { return ''; }
}

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
