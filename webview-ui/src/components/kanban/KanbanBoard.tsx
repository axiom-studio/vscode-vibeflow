import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { BugIcon, CheckSquareIcon, LockIcon } from '../_shared/icons';

/**
 * Shared, presentational Kanban board — drag-and-drop columns over a flat
 * card list. Used by both the standalone Kanban panel (`KanbanView`) and the
 * dashboard embed (`DashboardView`). Data + actions come in via props; the
 * board owns only view state (drag + column visibility). Fills its parent's
 * height — the parent decides how tall it is.
 */

export interface KanbanCard {
  type: 'todo' | 'issue';
  id: number;
  title: string;
  status: string;
  priority: string;
  featureName?: string;
  currentPersona?: string;
  securityReviewed: boolean;
  updatedAt: string;
}

/**
 * Eight columns — one per backend status — kept in sync with the host's
 * KANBAN_COLUMNS (src/views/kanban/kanbanData.ts). `statuses` is the status
 * set shown here; `primary` is the status sent on drop (host re-validates).
 */
/**
 * Per-swimlane explainer (#2896) — what the status means, which persona acts on
 * it, and where the ticket moves next. Persona ownership verified against the
 * backend's `personaDefaultIntakeStatuses` (axiomcloud mcp/vibeflow_tools.go):
 * `in_review` has NO agent intake (human triage); PM owns `needs_pm_input`;
 * code agents own `ready_to_implement` (one per branch); security_lead + qa_lead
 * intake `done`. Persona dot colors mirror the dashboard PERSONA_COLORS.
 */
interface ColumnInfo {
  what: string;
  who: string;
  whoColor: string;
  next: string;
}

const COLUMNS: Array<{ key: string; label: string; statuses: string[]; primary: string; accent: string; info: ColumnInfo }> = [
  { key: 'in_review', label: 'In Review', statuses: ['in_review'], primary: 'in_review', accent: 'var(--vscode-charts-blue, #4e94ce)',
    info: { what: 'Triage inbox — new or returned items waiting to be routed.', who: 'Human triage — no agent auto-picks these', whoColor: 'var(--feed-muted)', next: 'Needs PM/UX Input · Planning · Rejected' } },
  { key: 'needs_pm_input', label: 'Needs PM Input', statuses: ['needs_pm_input'], primary: 'needs_pm_input', accent: 'var(--vscode-charts-purple, #c586c0)',
    info: { what: 'Needs a spec, PRD, or product decision.', who: 'Aria · Product Manager', whoColor: '#ff9a3d', next: 'Planning · Ready' } },
  { key: 'needs_ux_input', label: 'Needs UX Input', statuses: ['needs_ux_input'], primary: 'needs_ux_input', accent: 'var(--vscode-charts-orange, #d18616)',
    info: { what: 'Needs design input — flows, wireframes, UX review.', who: 'Dana · UX Designer', whoColor: '#ff70c4', next: 'Needs PM Input · Planning' } },
  { key: 'planning', label: 'Planning', statuses: ['planning'], primary: 'planning', accent: 'var(--feed-muted)',
    info: { what: 'Claimed by an agent and being scoped / planned.', who: 'The claiming agent', whoColor: 'var(--feed-muted)', next: 'Ready to Implement' } },
  { key: 'architecture_review_complete', label: 'Arch Review', statuses: ['architecture_review_complete'], primary: 'architecture_review_complete', accent: 'var(--vscode-charts-blue, #4e94ce)',
    info: { what: "Architect's design pass is done; ready for a builder.", who: 'Morgan · Architect → a code agent', whoColor: '#b483ff', next: 'Ready · In Progress' } },
  { key: 'ready_to_implement', label: 'Ready', statuses: ['ready_to_implement'], primary: 'ready_to_implement', accent: 'var(--vscode-charts-green, #89d185)',
    info: { what: 'Ready to build — picked up by one code agent per branch.', who: 'Developer / Architect / Principal Eng · 1 per branch', whoColor: '#4d9fff', next: 'In Progress' } },
  { key: 'implementing', label: 'In Progress', statuses: ['implementing'], primary: 'implementing', accent: 'var(--feed-warning)',
    info: { what: 'Actively being built; this agent holds the branch lock.', who: 'Code agent (the branch holder)', whoColor: '#4d9fff', next: 'Done' } },
  { key: 'done', label: 'Done', statuses: ['done'], primary: 'done', accent: 'var(--feed-success)',
    info: { what: 'Built; awaiting Security then QA review.', who: 'Sophie · Security → Quinn · QA', whoColor: '#ff5d5d', next: 'Archived · Rejected' } },
];

const PRIORITY_COLORS: Record<string, string> = {
  high: 'var(--feed-error)',
  medium: 'var(--feed-warning)',
  low: 'var(--feed-muted)',
};

export function KanbanBoard({ cards, loading, onMove, onOpenCard }: {
  cards: KanbanCard[];
  loading: boolean;
  /** Move an item to a column's primary status (host re-validates + persists). */
  onMove: (itemType: 'todo' | 'issue', itemId: number, newStatus: string) => void;
  onOpenCard: (card: KanbanCard) => void;
}) {
  const [draggedCard, setDraggedCard] = useState<KanbanCard | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // Optimistic overlay so a drag moves the card INSTANTLY (the host round-trip
  // — esp. the dashboard's full snapshot re-fetch — is too slow to feel
  // responsive). Reconciled to the host truth whenever fresh `cards` arrive:
  // a server-rejected move simply snaps back on the next broadcast.
  const [localCards, setLocalCards] = useState<KanbanCard[]>(cards);
  useEffect(() => { setLocalCards(cards); }, [cards]);
  // Client-side filters (#2881) — over the cards already sent, no host call.
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'todo' | 'issue'>('all');
  const [featureFilter, setFeatureFilter] = useState<string>(''); // '' = all features
  // Column show/hide (view-only, in-memory). Stores HIDDEN keys so the
  // default (empty set) shows all 8.
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(() => new Set());
  const [showColumnMenu, setShowColumnMenu] = useState(false);
  const toggleColumn = useCallback((key: string) => {
    setHiddenColumns(prev => {
      const next = new Set(prev);
      if (next.has(key)) { next.delete(key); } else { next.add(key); }
      return next;
    });
  }, []);
  const visibleColumns = useMemo(() => COLUMNS.filter(c => !hiddenColumns.has(c.key)), [hiddenColumns]);

  const onDragStart = useCallback((card: KanbanCard) => setDraggedCard(card), []);
  const onDragOver = useCallback((e: React.DragEvent, columnKey: string) => {
    e.preventDefault();
    setDropTarget(columnKey);
  }, []);
  const onDragLeave = useCallback(() => setDropTarget(null), []);
  const onDrop = useCallback((columnKey: string) => {
    setDropTarget(null);
    const card = draggedCard;
    setDraggedCard(null);
    if (!card) { return; }
    const column = COLUMNS.find(c => c.key === columnKey);
    if (!column) { return; }
    if (column.statuses.includes(card.status)) { return; } // same-column drop = no-op
    // Optimistic: move the card now; the host re-broadcast reconciles (or reverts).
    setLocalCards(prev => prev.map(c => (c.id === card.id && c.type === card.type ? { ...c, status: column.primary } : c)));
    onMove(card.type, card.id, column.primary);
  }, [draggedCard, onMove]);

  // Distinct feature names present — the extension's "tag" axis (the board is
  // already single-project, so feature is the only useful tag dimension).
  const featureOptions = useMemo(() => {
    const set = new Set<string>();
    for (const c of localCards) { if (c.featureName) { set.add(c.featureName); } }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [localCards]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return localCards.filter(c => {
      if (typeFilter !== 'all' && c.type !== typeFilter) { return false; }
      if (featureFilter && c.featureName !== featureFilter) { return false; }
      if (q && !(`#${c.id}`.includes(q) || c.title.toLowerCase().includes(q))) { return false; }
      return true;
    });
  }, [localCards, search, typeFilter, featureFilter]);

  const cardsByColumn = useMemo(() => {
    const map: Record<string, KanbanCard[]> = {};
    for (const col of COLUMNS) { map[col.key] = []; }
    for (const card of filtered) {
      const col = COLUMNS.find(c => c.statuses.includes(card.status));
      if (col) { map[col.key].push(card); }
    }
    const PR: Record<string, number> = { critical: 0, urgent: 0, high: 1, medium: 2, low: 3 };
    for (const k of Object.keys(map)) {
      map[k].sort((a, b) => {
        const pa = PR[a.priority] ?? 1;
        const pb = PR[b.priority] ?? 1;
        if (pa !== pb) { return pa - pb; }
        return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
      });
    }
    return map;
  }, [filtered]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Filters (search · type · feature) + column show/hide */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px 6px', flexShrink: 0, flexWrap: 'wrap' }}>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search items…"
          style={{
            flex: '1 1 160px',
            minWidth: 120,
            maxWidth: 280,
            fontSize: 11,
            padding: '4px 8px',
            background: 'var(--vscode-input-background, var(--feed-bg))',
            color: 'var(--vscode-input-foreground, var(--feed-fg))',
            border: '1px solid var(--feed-border)',
            borderRadius: 4,
          }}
        />
        {/* Type tabs */}
        <div style={{ display: 'inline-flex', border: '1px solid var(--feed-border)', borderRadius: 4, overflow: 'hidden', flexShrink: 0 }}>
          {(['all', 'todo', 'issue'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTypeFilter(t)}
              style={{
                fontSize: 11,
                padding: '4px 9px',
                border: 'none',
                cursor: 'pointer',
                background: typeFilter === t ? 'var(--feed-button-bg)' : 'transparent',
                color: typeFilter === t ? 'var(--feed-button-fg)' : 'var(--feed-muted)',
              }}
            >
              {t === 'all' ? 'All' : t === 'todo' ? 'Todos' : 'Issues'}
            </button>
          ))}
        </div>
        {/* Feature ("tag") filter */}
        {featureOptions.length > 0 && (
          <select
            value={featureFilter}
            onChange={e => setFeatureFilter(e.target.value)}
            title="Filter by feature"
            style={{
              fontSize: 11,
              padding: '3px 6px',
              maxWidth: 180,
              background: 'var(--feed-bg)',
              color: 'var(--feed-fg)',
              border: '1px solid var(--feed-border)',
              borderRadius: 4,
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <option value="">All features</option>
            {featureOptions.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
        )}
        {/* Column show/hide control (right-aligned) */}
        <div style={{ position: 'relative', marginLeft: 'auto', flexShrink: 0 }}>
          <button
            onClick={() => setShowColumnMenu(v => !v)}
            title="Show or hide columns"
            style={{
              fontSize: 11,
              padding: '4px 8px',
              background: 'var(--feed-bg)',
              color: 'var(--feed-fg)',
              border: '1px solid var(--feed-border)',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            Columns ({visibleColumns.length}/{COLUMNS.length}) ▾
          </button>
          {showColumnMenu && (
            <div style={{
              position: 'absolute',
              top: 'calc(100% + 4px)',
              right: 0,
              zIndex: 20,
              background: 'var(--vscode-menu-background, var(--feed-bg))',
              border: '1px solid var(--vscode-menu-border, var(--feed-border))',
              borderRadius: 6,
              boxShadow: '0 6px 20px rgba(0,0,0,0.4)',
              padding: '4px 0',
              minWidth: 184,
            }}>
              {COLUMNS.map(c => (
                <label key={c.key} style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '5px 12px',
                  fontSize: 12,
                  color: 'var(--feed-fg)',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}>
                  <input type="checkbox" checked={!hiddenColumns.has(c.key)} onChange={() => toggleColumn(c.key)} />
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: c.accent, flexShrink: 0 }} />
                  {c.label}
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Lanes — horizontally scrollable row of fixed-width columns. */}
      <div style={{
        display: 'flex',
        gap: 8,
        padding: '0 12px 12px',
        flex: 1,
        minHeight: 0,
        overflowX: 'auto',
        overflowY: 'hidden',
        alignItems: 'stretch',
      }}>
        {visibleColumns.length === 0 && (
          <div style={{ margin: 'auto', fontSize: 12, color: 'var(--feed-muted)' }}>
            All columns hidden — use “Columns” above to show some.
          </div>
        )}
        {visibleColumns.map(col => {
          const columnCards = cardsByColumn[col.key] ?? [];
          const isDropping = dropTarget === col.key;
          return (
            <div
              key={col.key}
              onDragOver={(e) => onDragOver(e, col.key)}
              onDragLeave={onDragLeave}
              onDrop={() => onDrop(col.key)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                flex: '0 0 232px',
                minWidth: 232,
                minHeight: 0,
                background: isDropping ? 'rgba(127,127,127,0.1)' : 'transparent',
                borderRadius: 6,
                border: isDropping ? '2px dashed var(--feed-link)' : '2px solid transparent',
                transition: 'all 120ms',
              }}
            >
              <div style={{
                padding: '6px 10px',
                fontSize: 11,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                color: col.accent,
                borderBottom: `2px solid ${col.accent}`,
                display: 'flex',
                justifyContent: 'space-between',
              }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{col.label}</span>
                  <ColumnInfoIcon label={col.label} info={col.info} accent={col.accent} />
                </span>
                <span style={{ fontWeight: 400, flexShrink: 0 }}>{columnCards.length}</span>
              </div>

              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 0' }}>
                {columnCards.length === 0 && !loading && (
                  <div style={{ padding: '12px', fontSize: 11, color: 'var(--feed-muted)', textAlign: 'center', opacity: 0.6 }}>
                    No items
                  </div>
                )}
                {columnCards.map(card => (
                  <Card
                    key={`${card.type}-${card.id}`}
                    card={card}
                    onDragStart={onDragStart}
                    onClick={onOpenCard}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Per-column explainer popover (#2896). The `ⓘ` glyph in each swimlane header
 * reveals what the status is, which persona owns it, and where the ticket goes
 * next. Portal-rendered with `position: fixed` so the board's horizontal-scroll
 * `overflow` never clips it (the same escape-the-overflow trick the dashboard's
 * persona hover cards use).
 */
function ColumnInfoIcon({ label, info, accent }: { label: string; info: ColumnInfo; accent: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const show = () => { if (ref.current) { setRect(ref.current.getBoundingClientRect()); } };
  const hide = () => setRect(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={(e) => { e.stopPropagation(); show(); }}
        aria-label={`${label}: ${info.what} Handled by ${info.who}. Moves next to ${info.next}.`}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 14, height: 14, padding: 0, flexShrink: 0,
          border: 'none', background: 'transparent', color: 'var(--feed-muted)',
          cursor: 'help', opacity: 0.65,
        }}
      >
        <InfoGlyph />
      </button>
      {rect && createPortal(
        <div
          role="tooltip"
          style={{
            position: 'fixed',
            top: rect.bottom + 6,
            left: Math.max(8, Math.min(rect.left - 6, window.innerWidth - 256)),
            width: 240,
            zIndex: 9999,
            background: 'var(--vscode-editorHoverWidget-background, var(--feed-bg))',
            border: '1px solid var(--vscode-editorHoverWidget-border, var(--feed-border))',
            borderRadius: 6,
            padding: '9px 11px',
            boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
            // Reset the header's uppercase + letter-spacing inheritance.
            textTransform: 'none', letterSpacing: 0, fontWeight: 400,
            fontSize: 11, lineHeight: 1.5, color: 'var(--feed-fg)',
            pointerEvents: 'none',
          }}
        >
          <div style={{ fontWeight: 700, color: accent, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 5 }}>{label}</div>
          <div style={{ color: 'var(--feed-muted)', marginBottom: 7 }}>{info.what}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: info.whoColor, flexShrink: 0 }} aria-hidden />
            <span style={{ fontWeight: 500 }}>{info.who}</span>
          </div>
          <div style={{ color: 'var(--feed-muted)' }}>
            <span style={{ opacity: 0.7 }}>Moves next → </span>{info.next}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function InfoGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <circle cx="8" cy="8" r="6.4" />
      <line x1="8" y1="7.2" x2="8" y2="11.2" strokeLinecap="round" />
      <circle cx="8" cy="4.7" r="0.55" fill="currentColor" stroke="none" />
    </svg>
  );
}

function Card({ card, onDragStart, onClick }: {
  card: KanbanCard;
  onDragStart: (card: KanbanCard) => void;
  onClick: (card: KanbanCard) => void;
}) {
  return (
    <div
      draggable
      onDragStart={() => onDragStart(card)}
      onClick={() => onClick(card)}
      style={{
        margin: '4px 4px',
        padding: '6px 8px',
        background: 'var(--vscode-editor-background)',
        border: '1px solid var(--feed-border)',
        borderLeft: `3px solid ${PRIORITY_COLORS[card.priority] ?? 'var(--feed-muted)'}`,
        borderRadius: 4,
        cursor: 'grab',
        fontSize: 11,
        userSelect: 'none',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 }}>
        <div style={{ fontWeight: 500, lineHeight: 1.3, flex: 1, minWidth: 0, display: 'flex', alignItems: 'flex-start', gap: 5 }}>
          <span
            title={card.type === 'issue' ? 'Issue' : 'Todo'}
            style={{ display: 'inline-flex', alignItems: 'center', color: card.type === 'issue' ? 'var(--feed-error)' : 'var(--feed-muted)', flexShrink: 0, paddingTop: 1 }}
          >
            {card.type === 'issue' ? <BugIcon size={11} /> : <CheckSquareIcon size={11} />}
          </span>
          <span style={{ color: 'var(--feed-muted)', fontFamily: 'var(--vscode-editor-font-family)', fontSize: 10 }}>
            #{card.id}
          </span>
          <span style={{ minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{card.title}</span>
        </div>
        {card.securityReviewed && (
          <span title="Security reviewed" style={{ display: 'inline-flex', color: 'var(--feed-success)', opacity: 0.75, flexShrink: 0 }}>
            <LockIcon size={11} />
          </span>
        )}
      </div>
      {(card.featureName || card.currentPersona) && (
        <div style={{ display: 'flex', gap: 6, marginTop: 4, fontSize: 10, color: 'var(--feed-muted)', flexWrap: 'wrap' }}>
          {card.featureName && <span style={{ opacity: 0.8 }}>{card.featureName}</span>}
          {card.currentPersona && (
            <span style={{ padding: '0 5px', borderRadius: 2, background: 'rgba(127,127,127,0.15)' }}>
              @{card.currentPersona}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
