import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { getVsCodeApi } from '../vscodeApi';
import type { KanbanClientMessage, KanbanHostMessage } from '../../../src/core/webviewMessages';
import { BugIcon, CheckSquareIcon, LockIcon } from './_shared/icons';

const vscode = getVsCodeApi() as { postMessage: (msg: KanbanClientMessage) => void };

interface KanbanCard {
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
 * Five logical columns matching the host's KANBAN_COLUMNS in
 * src/views/kanban/KanbanPanel.ts. The `statuses` array is the set of
 * backend statuses that fall into this column; `primary` is the status
 * we send when an item is dropped here.
 *
 * Keep the two definitions in sync — host validates `primary` against its
 * own allowlist before calling the API, so a webview-host drift just
 * surfaces as a "not a valid target column" error rather than a bad write.
 */
const COLUMNS: Array<{
  key: string;
  label: string;
  statuses: string[];
  primary: string;
  accent: string;
}> = [
  { key: 'planning', label: 'Planning', statuses: ['planning', 'needs_pm_input', 'needs_ux_input'], primary: 'planning', accent: 'var(--feed-muted)' },
  { key: 'ready', label: 'Ready', statuses: ['ready_to_implement', 'architecture_review_complete'], primary: 'ready_to_implement', accent: 'var(--feed-link)' },
  { key: 'implementing', label: 'In Progress', statuses: ['implementing'], primary: 'implementing', accent: 'var(--feed-warning)' },
  { key: 'in_review', label: 'In Review', statuses: ['in_review'], primary: 'in_review', accent: 'var(--feed-muted)' },
  { key: 'done', label: 'Done', statuses: ['done'], primary: 'done', accent: 'var(--feed-success)' },
];

const PRIORITY_COLORS: Record<string, string> = {
  high: 'var(--feed-error)',
  medium: 'var(--feed-warning)',
  low: 'var(--feed-muted)',
};

const SUB_STATUS_LABELS: Record<string, string> = {
  needs_pm_input: 'Needs PM',
  needs_ux_input: 'Needs UX',
  architecture_review_complete: 'Arch Reviewed',
};

interface KanbanState {
  projectName: string;
  cards: KanbanCard[];
  loading: boolean;
  error: string | undefined;
}

/**
 * Kanban Board with drag-and-drop columns. Loads via host postMessage on
 * mount (`kanbanLoad`), receives `kanbanData` updates, and posts
 * `kanbanMove` when the user drags a card to a different column.
 */
export function KanbanView() {
  const [state, setState] = useState<KanbanState>({
    projectName: '',
    cards: [],
    loading: true,
    error: undefined,
  });
  const [draggedCard, setDraggedCard] = useState<KanbanCard | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // Mount: kick the host to load + start its polling cycle.
  useEffect(() => {
    vscode.postMessage({ type: 'kanbanLoad' });
  }, []);

  // Inbound: kanbanData / kanbanError from host. The host's payload type
  // is `unknown` (the wire shape lives in src/views/kanban/KanbanPanel.ts);
  // we narrow at the field level because that boundary is where the
  // unsafe cast belongs — not throughout the React tree below.
  useEffect(() => {
    function handleMessage(event: MessageEvent<KanbanHostMessage>) {
      const msg = event.data;
      if (msg?.type === 'kanbanData' && msg.payload) {
        const data = msg.payload as { projectName?: string; cards?: KanbanCard[] };
        setState({
          projectName: data.projectName ?? '',
          cards: data.cards ?? [],
          loading: false,
          error: undefined,
        });
      } else if (msg?.type === 'kanbanError') {
        setState(s => ({ ...s, loading: false, error: msg.payload.message }));
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // Safety: drop the spinner if the host doesn't respond within 5s
  // (network hung, swimlane composition stuck). The next snapshot push
  // will clear `error` and resume normal rendering.
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(() => {
    if (refreshTimerRef.current) { clearTimeout(refreshTimerRef.current); }
    setState(s => ({ ...s, loading: true, error: undefined }));
    vscode.postMessage({ type: 'kanbanRefresh' });
    refreshTimerRef.current = setTimeout(() => {
      setState(s => (s.loading ? { ...s, loading: false } : s));
    }, 5000);
  }, []);
  useEffect(() => {
    if (!state.loading && refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, [state.loading]);

  const onDragStart = useCallback((card: KanbanCard) => {
    setDraggedCard(card);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent, columnKey: string) => {
    e.preventDefault();
    setDropTarget(columnKey);
  }, []);

  const onDragLeave = useCallback(() => {
    setDropTarget(null);
  }, []);

  const onDrop = useCallback((columnKey: string) => {
    setDropTarget(null);
    const card = draggedCard;
    setDraggedCard(null);
    if (!card) { return; }

    const column = COLUMNS.find(c => c.key === columnKey);
    if (!column) { return; }

    // Same column drop is a no-op (avoid round-tripping the same status).
    if (column.statuses.includes(card.status)) { return; }

    // Optimistic update — host re-broadcasts the truth on success or rolls back.
    setState(s => ({
      ...s,
      cards: s.cards.map(c =>
        c.id === card.id && c.type === card.type
          ? { ...c, status: column.primary }
          : c,
      ),
    }));
    vscode.postMessage({
      type: 'kanbanMove',
      payload: { itemType: card.type, itemId: card.id, newStatus: column.primary },
    });
  }, [draggedCard]);

  const openCard = useCallback((card: KanbanCard) => {
    vscode.postMessage({
      type: 'kanbanOpenItem',
      payload: { itemType: card.type, itemId: card.id, title: card.title },
    });
  }, []);

  const cardsByColumn = useMemo(() => {
    const map: Record<string, KanbanCard[]> = {};
    for (const col of COLUMNS) { map[col.key] = []; }
    for (const card of state.cards) {
      const col = COLUMNS.find(c => c.statuses.includes(card.status));
      if (col) { map[col.key].push(card); }
    }
    // Stable sort: priority desc, then updatedAt desc.
    // `critical`/`urgent` are not in the documented priority set but we
    // bucket them with `high` defensively (and warn so we notice if the
    // backend grows new priority levels we should officially support).
    const PR: Record<string, number> = { critical: 0, urgent: 0, high: 1, medium: 2, low: 3 };
    const warned = new Set<string>();
    for (const k of Object.keys(map)) {
      map[k].sort((a, b) => {
        const pa = PR[a.priority] ?? (warned.add(a.priority), 1);
        const pb = PR[b.priority] ?? (warned.add(b.priority), 1);
        if (pa !== pb) { return pa - pb; }
        return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
      });
    }
    if (warned.size > 0) {
      // Best-effort surfacing for unknown priorities; harmless in prod.
      console.warn('Kanban: unknown priority value(s) sorted as `high`:', [...warned]);
    }
    return map;
  }, [state.cards]);

  return (
    <div style={{ width: '100%', height: '100vh', background: 'var(--feed-bg)', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        padding: '10px 16px',
        borderBottom: '1px solid var(--feed-border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--feed-fg)' }}>
            VibeFlow Kanban
          </span>
          {state.projectName && (
            <span style={{ fontSize: 12, color: 'var(--feed-muted)' }}>
              · {state.projectName}
            </span>
          )}
          <span style={{ fontSize: 11, color: 'var(--feed-muted)', marginLeft: 6 }}>
            ({state.cards.length} item{state.cards.length === 1 ? '' : 's'})
          </span>
        </div>
        <button
          onClick={refresh}
          disabled={state.loading}
          style={{
            padding: '4px 12px',
            fontSize: 11,
            background: 'var(--feed-button-bg)',
            color: 'var(--feed-button-fg)',
            border: 'none',
            borderRadius: 4,
            cursor: state.loading ? 'wait' : 'pointer',
            opacity: state.loading ? 0.6 : 1,
          }}
        >
          {state.loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {state.error && (
        <div style={{
          padding: '8px 16px',
          fontSize: 11,
          background: 'rgba(244,71,71,0.1)',
          color: 'var(--feed-error)',
          borderBottom: '1px solid var(--feed-border)',
        }}>
          {state.error}
        </div>
      )}

      {/* Columns */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${COLUMNS.length}, 1fr)`,
        gap: 8,
        padding: 12,
        height: state.error ? 'calc(100vh - 84px)' : 'calc(100vh - 56px)',
        overflow: 'hidden',
      }}>
        {COLUMNS.map(col => {
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
                background: isDropping ? 'rgba(127,127,127,0.1)' : 'transparent',
                borderRadius: 6,
                border: isDropping ? '2px dashed var(--feed-link)' : '2px solid transparent',
                transition: 'all 120ms',
                minWidth: 0,
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

              <div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
                {columnCards.length === 0 && !state.loading && (
                  <div style={{
                    padding: '12px',
                    fontSize: 11,
                    color: 'var(--feed-muted)',
                    textAlign: 'center',
                    opacity: 0.6,
                  }}>
                    No items
                  </div>
                )}
                {columnCards.map(card => (
                  <Card
                    key={`${card.type}-${card.id}`}
                    card={card}
                    onDragStart={onDragStart}
                    onClick={openCard}
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

function Card({
  card,
  onDragStart,
  onClick,
}: {
  card: KanbanCard;
  onDragStart: (card: KanbanCard) => void;
  onClick: (card: KanbanCard) => void;
}) {
  const subStatus = SUB_STATUS_LABELS[card.status];
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
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        gap: 6,
      }}>
        <div style={{ fontWeight: 500, lineHeight: 1.3, flex: 1, display: 'flex', alignItems: 'flex-start', gap: 5 }}>
          <span
            title={card.type === 'issue' ? 'Issue' : 'Todo'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              color: card.type === 'issue' ? 'var(--feed-error)' : 'var(--feed-muted)',
              flexShrink: 0,
              paddingTop: 1,
            }}
          >
            {card.type === 'issue' ? <BugIcon size={11} /> : <CheckSquareIcon size={11} />}
          </span>
          <span style={{ color: 'var(--feed-muted)', fontFamily: 'var(--vscode-editor-font-family)', fontSize: 10 }}>
            #{card.id}
          </span>
          <span>{card.title}</span>
        </div>
        {card.securityReviewed && (
          <span
            title="Security reviewed"
            style={{ display: 'inline-flex', color: 'var(--feed-success)', opacity: 0.75, flexShrink: 0 }}
          >
            <LockIcon size={11} />
          </span>
        )}
      </div>
      <div style={{
        display: 'flex',
        gap: 6,
        marginTop: 4,
        fontSize: 10,
        color: 'var(--feed-muted)',
        flexWrap: 'wrap',
      }}>
        {card.featureName && (
          <span style={{ opacity: 0.8 }}>{card.featureName}</span>
        )}
        {card.currentPersona && (
          <span style={{
            padding: '0 5px',
            borderRadius: 2,
            background: 'rgba(127,127,127,0.15)',
          }}>
            @{card.currentPersona}
          </span>
        )}
        {subStatus && (
          <span style={{
            padding: '0 5px',
            borderRadius: 2,
            background: 'rgba(220,150,80,0.15)',
            color: 'var(--feed-warning)',
          }}>
            {subStatus}
          </span>
        )}
      </div>
    </div>
  );
}
