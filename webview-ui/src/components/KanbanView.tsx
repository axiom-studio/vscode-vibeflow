import { useState, useCallback } from 'react';
import { getVsCodeApi } from '../vscodeApi';

const vscode = getVsCodeApi();

interface KanbanItem {
  id: number;
  type: 'todo' | 'issue';
  title: string;
  status: string;
  priority: string;
  claimedBy?: string;
}

const COLUMNS = [
  { key: 'planning', label: 'Planning', color: 'var(--feed-muted)' },
  { key: 'ready_to_implement', label: 'Ready', color: 'var(--feed-link)' },
  { key: 'implementing', label: 'In Progress', color: 'var(--feed-warning)' },
  { key: 'in_review', label: 'In Review', color: 'var(--feed-muted)' },
  { key: 'done', label: 'Done', color: 'var(--feed-success)' },
];

const PRIORITY_COLORS: Record<string, string> = {
  high: 'var(--feed-error)',
  medium: 'var(--feed-warning)',
  low: 'var(--feed-muted)',
};

/**
 * Kanban Board with drag-and-drop columns.
 * Uses native HTML drag events instead of a DnD library.
 */
export function KanbanView() {
  const [items, setItems] = useState<KanbanItem[]>([]);
  const [draggedItem, setDraggedItem] = useState<KanbanItem | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // Request items from extension on mount
  useState(() => {
    vscode.postMessage({ type: 'kanbanLoad' });
  });

  // Listen for data from extension
  useState(() => {
    function handleMessage(event: MessageEvent) {
      if (event.data?.type === 'kanbanData') {
        setItems(event.data.payload);
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  });

  const onDragStart = useCallback((item: KanbanItem) => {
    setDraggedItem(item);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent, columnKey: string) => {
    e.preventDefault();
    setDropTarget(columnKey);
  }, []);

  const onDragLeave = useCallback(() => {
    setDropTarget(null);
  }, []);

  const onDrop = useCallback((columnKey: string) => {
    if (draggedItem && draggedItem.status !== columnKey) {
      // Optimistic update
      setItems(prev => prev.map(item =>
        item.id === draggedItem.id && item.type === draggedItem.type
          ? { ...item, status: columnKey }
          : item,
      ));
      // Notify extension to call the API
      vscode.postMessage({
        type: 'kanbanMove',
        payload: {
          itemType: draggedItem.type,
          itemId: draggedItem.id,
          newStatus: columnKey,
        },
      });
    }
    setDraggedItem(null);
    setDropTarget(null);
  }, [draggedItem]);

  return (
    <div style={{ width: '100%', height: '100vh', background: 'var(--feed-bg)', overflow: 'hidden' }}>
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--feed-border)',
        fontSize: 14,
        fontWeight: 600,
        color: 'var(--feed-fg)',
      }}>
        VibeFlow Kanban
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${COLUMNS.length}, 1fr)`,
        gap: 8,
        padding: 12,
        height: 'calc(100vh - 56px)',
        overflow: 'hidden',
      }}>
        {COLUMNS.map(col => {
          const columnItems = items.filter(item => item.status === col.key);
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
                background: isDropping
                  ? 'rgba(127,127,127,0.1)'
                  : 'transparent',
                borderRadius: 6,
                border: isDropping
                  ? '2px dashed var(--feed-link)'
                  : '2px solid transparent',
                transition: 'all 120ms',
              }}
            >
              {/* Column header */}
              <div style={{
                padding: '6px 10px',
                fontSize: 11,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                color: col.color,
                borderBottom: `2px solid ${col.color}`,
                display: 'flex',
                justifyContent: 'space-between',
              }}>
                <span>{col.label}</span>
                <span style={{ fontWeight: 400 }}>{columnItems.length}</span>
              </div>

              {/* Cards */}
              <div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
                {columnItems.map(item => (
                  <div
                    key={`${item.type}-${item.id}`}
                    draggable
                    onDragStart={() => onDragStart(item)}
                    style={{
                      margin: '4px 4px',
                      padding: '6px 8px',
                      background: 'var(--vscode-editor-background)',
                      border: '1px solid var(--feed-border)',
                      borderLeft: `3px solid ${PRIORITY_COLORS[item.priority] ?? 'var(--feed-muted)'}`,
                      borderRadius: 4,
                      cursor: 'grab',
                      fontSize: 11,
                    }}
                  >
                    <div style={{ fontWeight: 500, lineHeight: 1.3 }}>
                      #{item.id}: {item.title}
                    </div>
                    {item.claimedBy && (
                      <div style={{ fontSize: 10, color: 'var(--feed-muted)', marginTop: 2 }}>
                        @{item.claimedBy}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
