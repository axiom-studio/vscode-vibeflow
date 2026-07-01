import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { getVsCodeApi } from '../vscodeApi';
import { StatusPill } from './_shared/StatusPill';
import type {
  TicketsClientMessage,
  TicketsHostMessage,
  TicketsMode,
  TicketRow,
} from '../../../src/core/webviewMessages';

const vscode = getVsCodeApi() as { postMessage: (msg: TicketsClientMessage) => void };

/** status → { label, color } for the pills. Color is any CSS color expr. */
const STATUS_META: Record<string, { label: string; color: string }> = {
  planning: { label: 'Planning', color: '#4493f8' },
  ready_to_implement: { label: 'Ready', color: '#4493f8' },
  architecture_review_complete: { label: 'Arch ✓', color: '#39c5cf' },
  implementing: { label: 'In Progress', color: '#d29922' },
  in_review: { label: 'In Review', color: '#bc8cff' },
  needs_pm_input: { label: 'Needs PM', color: '#db6d28' },
  needs_ux_input: { label: 'Needs UX', color: '#db6d28' },
  done: { label: 'Done', color: 'var(--feed-success, #3fb950)' },
  archived: { label: 'Archived', color: 'var(--feed-muted, #8b949e)' },
  rejected: { label: 'Rejected', color: 'var(--feed-error, #f85149)' },
};
const STATUS_ORDER = [
  'implementing', 'planning', 'ready_to_implement', 'architecture_review_complete',
  'in_review', 'needs_pm_input', 'needs_ux_input', 'done', 'archived', 'rejected',
];
const ALL_STATUSES = STATUS_ORDER;

const PRIORITY_COLOR: Record<string, string> = {
  high: '#f85149',
  medium: '#d29922',
  low: '#6e7681',
};

function statusMeta(status: string) {
  return STATUS_META[status] ?? { label: status || '—', color: 'var(--feed-muted, #8b949e)' };
}

type GroupBy = 'none' | 'status' | 'feature';

interface TicketsState {
  mode: TicketsMode;
  title: string;
  projectName: string;
  rows: TicketRow[];
  loading: boolean;
  error: string | undefined;
  hasMore: boolean;
  total: number;
}

export function TicketsView() {
  const initialMode = (document.body.dataset.vfTicketsMode as TicketsMode) ?? 'todos';
  const [state, setState] = useState<TicketsState>({
    mode: initialMode,
    title: '',
    projectName: '',
    rows: [],
    loading: true,
    error: undefined,
    hasMore: false,
    total: 0,
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState('');
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    vscode.postMessage({ type: 'ticketsLoad' });
  }, []);

  useEffect(() => {
    function handleMessage(event: MessageEvent<TicketsHostMessage>) {
      const msg = event.data;
      if (msg?.type === 'ticketsData') {
        setState({
          mode: msg.payload.mode,
          title: msg.payload.title,
          projectName: msg.payload.projectName,
          rows: msg.payload.rows ?? [],
          loading: false,
          error: undefined,
          hasMore: msg.payload.hasMore,
          total: msg.payload.total,
        });
        setLoadingMore(false);
      } else if (msg?.type === 'ticketsAppend') {
        setState(s => ({ ...s, rows: [...s.rows, ...msg.payload.rows], hasMore: msg.payload.hasMore }));
        setLoadingMore(false);
      } else if (msg?.type === 'ticketsError') {
        setState(s => ({ ...s, loading: false, error: msg.payload.message }));
        setLoadingMore(false);
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(() => {
    if (refreshTimer.current) { clearTimeout(refreshTimer.current); }
    setState(s => ({ ...s, loading: true }));
    vscode.postMessage({ type: 'ticketsRefresh' });
    refreshTimer.current = setTimeout(() => setState(s => (s.loading ? { ...s, loading: false } : s)), 5000);
  }, []);

  const openItem = useCallback((row: TicketRow) => {
    vscode.postMessage({ type: 'ticketsOpenItem', payload: { itemType: row.type, itemId: row.id, title: row.title } });
  }, []);

  const changeStatus = useCallback((row: TicketRow, newStatus: string) => {
    setEditingId(null);
    if (row.type === 'feature' || newStatus === row.status) { return; }
    vscode.postMessage({ type: 'ticketsChangeStatus', payload: { itemType: row.type, itemId: row.id, newStatus } });
  }, []);

  const loadMore = useCallback(() => {
    setLoadingMore(true);
    vscode.postMessage({ type: 'ticketsLoadMore' });
  }, []);

  // Distinct statuses present, for the quick-filter pills.
  const presentStatuses = useMemo(() => {
    const set = new Set(state.rows.map(r => r.status));
    return ALL_STATUSES.filter(s => set.has(s));
  }, [state.rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return state.rows.filter(r => {
      if (statusFilter && r.status !== statusFilter) { return false; }
      if (!q) { return true; }
      return (
        r.title.toLowerCase().includes(q) ||
        String(r.id).includes(q) ||
        (r.featureName ?? '').toLowerCase().includes(q) ||
        (r.userEmail ?? '').toLowerCase().includes(q) ||
        (r.claimedBy ?? '').toLowerCase().includes(q)
      );
    });
  }, [state.rows, search, statusFilter]);

  const groups = useMemo(() => {
    if (groupBy === 'none') {
      return [{ key: 'all', label: '', rows: filtered }];
    }
    const map = new Map<string, TicketRow[]>();
    for (const r of filtered) {
      const key = groupBy === 'status' ? r.status : (r.featureName ?? 'No feature');
      (map.get(key) ?? map.set(key, []).get(key)!).push(r);
    }
    const entries = [...map.entries()];
    if (groupBy === 'status') {
      entries.sort((a, b) => STATUS_ORDER.indexOf(a[0]) - STATUS_ORDER.indexOf(b[0]));
    } else {
      entries.sort((a, b) => a[0].localeCompare(b[0]));
    }
    return entries.map(([key, rows]) => ({
      key,
      label: groupBy === 'status' ? statusMeta(key).label : key,
      rows,
    }));
  }, [filtered, groupBy]);

  const isFeatures = state.mode === 'features';
  const showReview = state.mode === 'security' || state.mode === 'qa' || state.mode === 'todos' || state.mode === 'issues' || state.mode === 'backlog';

  return (
    <div style={{ width: '100%', height: '100vh', background: 'var(--feed-bg)', color: 'var(--feed-fg)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--feed-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>{state.title || 'Tickets'}</span>
          {state.projectName && <span style={{ fontSize: 12, color: 'var(--feed-muted)' }}>· {state.projectName}</span>}
          <span style={{ fontSize: 11, color: 'var(--feed-muted)', marginLeft: 4 }}>
            {filtered.length}{filtered.length !== state.rows.length ? ` / ${state.rows.length}` : ''} loaded{state.total > state.rows.length ? ` · ${state.total} total` : ''}
          </span>
        </div>
        <button onClick={refresh} disabled={state.loading} style={btnStyle(state.loading)}>
          {state.loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {/* Toolbar */}
      <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--feed-border)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', flexShrink: 0 }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Filter by title, #id, feature, owner…"
          style={{ flex: '1 1 220px', minWidth: 160, fontSize: 12, padding: '5px 9px', background: 'var(--vscode-input-background, var(--feed-bg))', color: 'var(--feed-fg)', border: '1px solid var(--feed-border)', borderRadius: 5 }}
        />
        <label style={{ fontSize: 11, color: 'var(--feed-muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
          Group
          <select value={groupBy} onChange={e => setGroupBy(e.target.value as GroupBy)} style={selectStyle}>
            <option value="none">None</option>
            <option value="status">Status</option>
            {!isFeatures && <option value="feature">Feature</option>}
          </select>
        </label>
        {/* Quick status filter pills */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
          <FilterChip active={statusFilter === null} onClick={() => setStatusFilter(null)} color="var(--feed-muted)">All</FilterChip>
          {presentStatuses.map(s => (
            <FilterChip key={s} active={statusFilter === s} onClick={() => setStatusFilter(statusFilter === s ? null : s)} color={statusMeta(s).color}>
              {statusMeta(s).label}
            </FilterChip>
          ))}
        </div>
      </div>

      {state.error && (
        <div style={{ padding: '8px 16px', fontSize: 11, background: 'rgba(248,81,73,0.1)', color: 'var(--feed-error)', borderBottom: '1px solid var(--feed-border)' }}>
          {state.error}
        </div>
      )}

      {/* Table */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {filtered.length === 0 && !state.loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--feed-muted)', fontSize: 13 }}>
            {state.rows.length === 0 ? `Nothing in ${state.title || 'this view'}.` : 'No items match your filter.'}
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ position: 'sticky', top: 0, background: 'var(--feed-bg)', zIndex: 1 }}>
                <Th style={{ width: '40%' }}>{isFeatures ? 'Feature' : 'Title'}</Th>
                <Th style={{ width: 130 }}>Status</Th>
                {!isFeatures && <Th style={{ width: 70 }}>Priority</Th>}
                {showReview && <Th style={{ width: 60, textAlign: 'center' }}>Sec / QA</Th>}
                {!isFeatures && <Th style={{ width: 130 }}>Feature</Th>}
                {!isFeatures && <Th style={{ width: 110 }}>Owner</Th>}
                {!isFeatures && <Th style={{ width: 120 }}>Branch</Th>}
                {isFeatures && <Th style={{ width: 140 }}>Updated</Th>}
              </tr>
            </thead>
            <tbody>
              {groups.map(group => (
                <GroupBlock key={group.key} label={groupBy === 'none' ? '' : group.label} count={group.rows.length} colSpan={8}>
                  {group.rows.map(row => {
                    const meta = statusMeta(row.status);
                    const rowKey = `${row.type}-${row.id}`;
                    return (
                      <tr
                        key={rowKey}
                        onClick={() => openItem(row)}
                        style={{ cursor: 'pointer', borderBottom: '1px solid var(--feed-border)' }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.04))')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                      >
                        <Td>
                          <span style={{ color: 'var(--feed-muted)', marginRight: 6 }}>#{row.id}</span>
                          {row.title}
                        </Td>
                        <Td onClick={e => { e.stopPropagation(); if (row.type !== 'feature') { setEditingId(editingId === rowKey ? null : rowKey); } }}>
                          {editingId === rowKey && row.type !== 'feature' ? (
                            <select
                              autoFocus
                              defaultValue={row.status}
                              onClick={e => e.stopPropagation()}
                              onChange={e => changeStatus(row, e.target.value)}
                              onBlur={() => setEditingId(null)}
                              style={selectStyle}
                            >
                              {ALL_STATUSES.map(s => <option key={s} value={s}>{statusMeta(s).label}</option>)}
                            </select>
                          ) : (
                            <StatusPill color={meta.color}>{meta.label}</StatusPill>
                          )}
                        </Td>
                        {!isFeatures && (
                          <Td>
                            {row.priority && (
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                <span style={{ width: 7, height: 7, borderRadius: '50%', background: PRIORITY_COLOR[row.priority] ?? 'var(--feed-muted)' }} />
                                <span style={{ color: 'var(--feed-muted)' }}>{row.priority}</span>
                              </span>
                            )}
                          </Td>
                        )}
                        {showReview && (
                          <Td style={{ textAlign: 'center' }}>
                            <Badge ok={row.securityReviewed} title="Security review" glyph="🛡" />
                            <Badge ok={row.qaVerified} title="QA verified" glyph="✓" />
                          </Td>
                        )}
                        {!isFeatures && <Td style={{ color: 'var(--feed-muted)' }}>{row.featureName ?? ''}</Td>}
                        {!isFeatures && <Td style={{ color: 'var(--feed-muted)' }}>{row.claimedBy ? `@${row.claimedBy}` : (row.userEmail ?? '')}</Td>}
                        {!isFeatures && <Td style={{ color: 'var(--feed-muted)', fontFamily: 'var(--vscode-editor-font-family, monospace)', fontSize: 11 }}>{row.branch ?? ''}</Td>}
                        {isFeatures && <Td style={{ color: 'var(--feed-muted)' }}>{formatDate(row.updatedAt)}</Td>}
                      </tr>
                    );
                  })}
                </GroupBlock>
              ))}
            </tbody>
          </table>
        )}
        {state.hasMore && (
          <div style={{ padding: 16, textAlign: 'center' }}>
            <button onClick={loadMore} disabled={loadingMore} style={btnStyle(loadingMore)}>
              {loadingMore ? 'Loading…' : `Load More (${state.rows.length} of ${state.total})`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function FilterChip({ active, onClick, color, children }: { active: boolean; onClick: () => void; color: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: 10.5,
        padding: '2px 8px',
        borderRadius: 999,
        cursor: 'pointer',
        border: `1px solid ${active ? color : 'var(--feed-border)'}`,
        background: active ? `color-mix(in oklab, ${color} 18%, transparent)` : 'transparent',
        color: active ? color : 'var(--feed-muted)',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
  );
}

function GroupBlock({ label, count, colSpan, children }: { label: string; count: number; colSpan: number; children: React.ReactNode }) {
  return (
    <>
      {label && (
        <tr>
          <td colSpan={colSpan} style={{ padding: '8px 16px 4px', fontSize: 11, fontWeight: 600, color: 'var(--feed-muted)', textTransform: 'uppercase', letterSpacing: 0.4, background: 'var(--feed-bg)' }}>
            {label} <span style={{ opacity: 0.6 }}>· {count}</span>
          </td>
        </tr>
      )}
      {children}
    </>
  );
}

function Badge({ ok, title, glyph }: { ok?: boolean; title: string; glyph: string }) {
  return (
    <span title={`${title}: ${ok ? 'yes' : 'no'}`} style={{ margin: '0 2px', opacity: ok ? 1 : 0.25, color: ok ? 'var(--feed-success, #3fb950)' : 'var(--feed-muted)' }}>
      {glyph}
    </span>
  );
}

function Th({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <th style={{ textAlign: 'left', padding: '7px 12px', fontSize: 10.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--feed-muted)', borderBottom: '1px solid var(--feed-border)', ...style }}>
      {children}
    </th>
  );
}

function Td({ children, style, onClick }: { children: React.ReactNode; style?: React.CSSProperties; onClick?: (e: React.MouseEvent) => void }) {
  return (
    <td onClick={onClick} style={{ padding: '7px 12px', verticalAlign: 'middle', maxWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...style }}>
      {children}
    </td>
  );
}

function btnStyle(loading: boolean): React.CSSProperties {
  return {
    padding: '4px 12px',
    fontSize: 11,
    background: 'var(--feed-button-bg)',
    color: 'var(--feed-button-fg)',
    border: 'none',
    borderRadius: 4,
    cursor: loading ? 'wait' : 'pointer',
    opacity: loading ? 0.6 : 1,
  };
}

const selectStyle: React.CSSProperties = {
  fontSize: 11,
  padding: '3px 6px',
  background: 'var(--vscode-dropdown-background, var(--feed-bg))',
  color: 'var(--feed-fg)',
  border: '1px solid var(--feed-border)',
  borderRadius: 4,
  cursor: 'pointer',
};

function formatDate(iso?: string): string {
  if (!iso) { return ''; }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) { return ''; }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
