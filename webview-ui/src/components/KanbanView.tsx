import { useState, useEffect, useCallback, useRef } from 'react';
import { getVsCodeApi } from '../vscodeApi';
import type { KanbanClientMessage, KanbanHostMessage } from '../../../src/core/webviewMessages';
import { KanbanBoard, type KanbanCard } from './kanban/KanbanBoard';

const vscode = getVsCodeApi() as { postMessage: (msg: KanbanClientMessage) => void };

interface KanbanState {
  projectName: string;
  cards: KanbanCard[];
  loading: boolean;
  error: string | undefined;
  // Host snapshot time + active auto-refresh cadence → live countdown.
  generatedAt: string | undefined;
  refreshIntervalMs: number;
}

// Auto-refresh options for the live control. 0 = paused. Default 30s (the
// org-wide swimlane is heavy; 10s is the fastest we expose).
const REFRESH_OPTIONS: Array<{ ms: number; label: string }> = [
  { ms: 0, label: 'Off' },
  { ms: 10_000, label: '10s' },
  { ms: 30_000, label: '30s' },
  { ms: 60_000, label: '60s' },
];
const DEFAULT_REFRESH_MS = 30_000;

/**
 * Standalone Kanban panel: a header (project + count + live-refresh controls)
 * over the shared <KanbanBoard>. Board rendering / drag / columns live in
 * KanbanBoard (shared with the dashboard embed); this wrapper owns the host
 * message wiring + the auto-refresh cadence UI.
 */
export function KanbanView() {
  const [state, setState] = useState<KanbanState>({
    projectName: '',
    cards: [],
    loading: true,
    error: undefined,
    generatedAt: undefined,
    refreshIntervalMs: DEFAULT_REFRESH_MS,
  });
  // 1s heartbeat so the "next in Ns" countdown ticks (timestamp math, no drift).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Mount: kick the host to load + start its polling cycle.
  useEffect(() => {
    vscode.postMessage({ type: 'kanbanLoad' });
  }, []);

  useEffect(() => {
    function handleMessage(event: MessageEvent<KanbanHostMessage>) {
      const msg = event.data;
      if (msg?.type === 'kanbanData' && msg.payload) {
        const data = msg.payload as {
          projectName?: string;
          cards?: KanbanCard[];
          generatedAt?: string;
          refreshIntervalMs?: number;
        };
        setState(s => ({
          projectName: data.projectName ?? '',
          cards: data.cards ?? [],
          loading: false,
          error: undefined,
          generatedAt: data.generatedAt,
          refreshIntervalMs: data.refreshIntervalMs ?? s.refreshIntervalMs,
        }));
      } else if (msg?.type === 'kanbanError') {
        setState(s => ({ ...s, loading: false, error: msg.payload.message }));
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // Safety: drop the spinner if the host doesn't respond within 5s.
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

  const setRefreshInterval = useCallback((ms: number) => {
    setState(s => ({ ...s, refreshIntervalMs: ms }));
    vscode.postMessage({ type: 'kanbanSetRefreshInterval', payload: { ms } });
  }, []);

  const onMove = useCallback((itemType: 'todo' | 'issue', itemId: number, newStatus: string) => {
    // Optimistic feedback is handled inside KanbanBoard now; just persist.
    vscode.postMessage({ type: 'kanbanMove', payload: { itemType, itemId, newStatus } });
  }, []);

  const onOpenCard = useCallback((card: KanbanCard) => {
    vscode.postMessage({ type: 'kanbanOpenItem', payload: { itemType: card.type, itemId: card.id, title: card.title } });
  }, []);

  const paused = state.refreshIntervalMs <= 0;
  const nextInSec = (!paused && state.generatedAt)
    ? Math.max(0, Math.ceil((state.refreshIntervalMs - (now - new Date(state.generatedAt).getTime())) / 1000))
    : null;

  return (
    <div style={{ width: '100%', height: '100vh', background: 'var(--feed-bg)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
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
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--feed-fg)' }}>VibeFlow Kanban</span>
          {state.projectName && <span style={{ fontSize: 12, color: 'var(--feed-muted)' }}>· {state.projectName}</span>}
          <span style={{ fontSize: 11, color: 'var(--feed-muted)', marginLeft: 6 }}>
            ({state.cards.length} item{state.cards.length === 1 ? '' : 's'})
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {/* Live status: pulsing dot + countdown (or Paused) */}
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--feed-muted)' }}
            title={paused ? 'Auto-refresh paused — use Refresh or switch focus to update.' : 'Auto-refreshing; also refetches the moment this tab regains focus.'}
          >
            <span
              className={paused ? undefined : 'persona-pulse'}
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                flexShrink: 0,
                background: paused ? 'var(--feed-muted)' : 'var(--feed-success, #3fb950)',
                ...(paused ? {} : { ['--persona-pulse-color' as string]: 'var(--feed-success, #3fb950)' }),
              }}
            />
            {paused ? 'Paused' : `Live${nextInSec != null ? ` · ${nextInSec}s` : ''}`}
          </div>
          {/* Cadence selector */}
          <select
            value={String(state.refreshIntervalMs)}
            onChange={e => setRefreshInterval(Number(e.target.value))}
            title="Auto-refresh interval"
            style={{
              fontSize: 11,
              padding: '3px 6px',
              background: 'var(--feed-bg)',
              color: 'var(--feed-fg)',
              border: '1px solid var(--feed-border)',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            {REFRESH_OPTIONS.map(opt => (
              <option key={opt.ms} value={String(opt.ms)}>
                {opt.ms === 0 ? 'Auto-refresh: Off' : `Refresh: ${opt.label}`}
              </option>
            ))}
          </select>
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

      {/* Board (shared component) */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <KanbanBoard cards={state.cards} loading={state.loading} onMove={onMove} onOpenCard={onOpenCard} />
      </div>
    </div>
  );
}
