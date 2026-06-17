import { useState, useEffect, useCallback, useMemo } from 'react';
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
const COLUMNS: Array<{ key: string; label: string; statuses: string[]; primary: string; accent: string }> = [
  { key: 'in_review', label: 'In Review', statuses: ['in_review'], primary: 'in_review', accent: 'var(--vscode-charts-blue, #4e94ce)' },
  { key: 'needs_pm_input', label: 'Needs PM Input', statuses: ['needs_pm_input'], primary: 'needs_pm_input', accent: 'var(--vscode-charts-purple, #c586c0)' },
  { key: 'needs_ux_input', label: 'Needs UX Input', statuses: ['needs_ux_input'], primary: 'needs_ux_input', accent: 'var(--vscode-charts-orange, #d18616)' },
  { key: 'planning', label: 'Planning', statuses: ['planning'], primary: 'planning', accent: 'var(--feed-muted)' },
  { key: 'architecture_review_complete', label: 'Arch Review', statuses: ['architecture_review_complete'], primary: 'architecture_review_complete', accent: 'var(--vscode-charts-blue, #4e94ce)' },
  { key: 'ready_to_implement', label: 'Ready', statuses: ['ready_to_implement'], primary: 'ready_to_implement', accent: 'var(--vscode-charts-green, #89d185)' },
  { key: 'implementing', label: 'In Progress', statuses: ['implementing'], primary: 'implementing', accent: 'var(--feed-warning)' },
  { key: 'done', label: 'Done', statuses: ['done'], primary: 'done', accent: 'var(--feed-success)' },
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

  const cardsByColumn = useMemo(() => {
    const map: Record<string, KanbanCard[]> = {};
    for (const col of COLUMNS) { map[col.key] = []; }
    for (const card of localCards) {
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
  }, [localCards]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Column show/hide control */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 12px 6px', flexShrink: 0 }}>
        <div style={{ position: 'relative' }}>
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
                <span>{col.label}</span>
                <span style={{ fontWeight: 400 }}>{columnCards.length}</span>
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
        <div style={{ fontWeight: 500, lineHeight: 1.3, flex: 1, display: 'flex', alignItems: 'flex-start', gap: 5 }}>
          <span
            title={card.type === 'issue' ? 'Issue' : 'Todo'}
            style={{ display: 'inline-flex', alignItems: 'center', color: card.type === 'issue' ? 'var(--feed-error)' : 'var(--feed-muted)', flexShrink: 0, paddingTop: 1 }}
          >
            {card.type === 'issue' ? <BugIcon size={11} /> : <CheckSquareIcon size={11} />}
          </span>
          <span style={{ color: 'var(--feed-muted)', fontFamily: 'var(--vscode-editor-font-family)', fontSize: 10 }}>
            #{card.id}
          </span>
          <span>{card.title}</span>
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
