import { useEffect, useCallback, useRef } from 'react';
import type { ActivityEntry, ExtensionMessage, WebviewMessage } from '../types';
import { getVsCodeApi } from '../vscodeApi';

const MAX_ENTRIES = 500;

const vscode = getVsCodeApi() as {
  postMessage: (msg: WebviewMessage) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
};

/**
 * Typed postMessage hook — the abstraction layer between the webview and extension host.
 * All communication flows through this hook. Transport can be swapped to gRPC later
 * by changing only this file.
 */
export function useMessages(onEntries: (entries: ActivityEntry[], replace?: boolean) => void) {
  const onEntriesRef = useRef(onEntries);
  onEntriesRef.current = onEntries;

  useEffect(() => {
    function handleMessage(event: MessageEvent<ExtensionMessage>) {
      const msg = event.data;
      switch (msg.type) {
        case 'activityEntry':
          onEntriesRef.current([msg.payload]);
          break;
        case 'activityEntries':
          onEntriesRef.current(msg.payload, true);
          break;
        case 'clearActivity':
          onEntriesRef.current([], true);
          break;
      }
    }

    window.addEventListener('message', handleMessage);
    vscode.postMessage({ type: 'ready', payload: undefined });

    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const respondToPrompt = useCallback((promptId: string, response: string) => {
    vscode.postMessage({
      type: 'respondToPrompt',
      payload: { promptId, response },
    });
  }, []);

  return { respondToPrompt };
}

/**
 * Manages the entry list with the 500-entry cap.
 *
 * - `replace=false`: append. Used by the per-entry `activityEntry`
 *   message stream.
 * - `replace=true` + empty incoming: clear. Used by `clearActivity`.
 * - `replace=true` + non-empty incoming: **merge by id**, not replace.
 *   This is the host's snapshot of history (`activityEntries`); when the
 *   webview already has rehydrated entries from `vscode.getState()`,
 *   a hard replace would discard the rehydrated tail if the host's
 *   replay buffer is smaller (extension was restarted; buffer is
 *   fresh empty). Merge-by-id preserves whichever side has more.
 *
 * On collision, incoming wins (host is the source of truth for the
 * authoritative shape). Sort by timestamp for stable order regardless
 * of which set contributed each entry.
 */
export function applyEntries(
  current: ActivityEntry[],
  incoming: ActivityEntry[],
  replace: boolean,
): ActivityEntry[] {
  if (replace) {
    if (incoming.length === 0) { return []; }
    const byId = new Map<string, ActivityEntry>();
    for (const e of current) { byId.set(e.id, e); }
    for (const e of incoming) { byId.set(e.id, e); }
    const merged = Array.from(byId.values())
      .sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
    return merged.length > MAX_ENTRIES ? merged.slice(merged.length - MAX_ENTRIES) : merged;
  }
  const merged = [...current, ...incoming];
  if (merged.length > MAX_ENTRIES) {
    return merged.slice(merged.length - MAX_ENTRIES);
  }
  return merged;
}
