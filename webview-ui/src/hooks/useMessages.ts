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
 * Oldest entries are evicted when the cap is exceeded.
 */
export function applyEntries(
  current: ActivityEntry[],
  incoming: ActivityEntry[],
  replace: boolean,
): ActivityEntry[] {
  if (replace) {
    return incoming.slice(-MAX_ENTRIES);
  }
  const merged = [...current, ...incoming];
  if (merged.length > MAX_ENTRIES) {
    return merged.slice(merged.length - MAX_ENTRIES);
  }
  return merged;
}
