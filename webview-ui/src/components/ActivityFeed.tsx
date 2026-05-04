import { useState, useCallback, useRef, useEffect } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import type { ActivityEntry } from '../types';
import { useMessages, applyEntries } from '../hooks/useMessages';
import { ActivityItem } from './ActivityItem';
import { PinnedPlan, type PinnedProgressData } from './PinnedPlan';

export function ActivityFeed() {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [atBottom, setAtBottom] = useState(true);
  const [progress, setProgress] = useState<PinnedProgressData | null>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // Subscribe to host-pushed progress snapshots. Replaces the previous
  // approach of scraping plan steps from log text — the backend already
  // stamps structured progress on each todo/issue and the host poller
  // forwards the freshest one each cycle.
  useEffect(() => {
    function handleMessage(event: MessageEvent<{ type: string; payload: PinnedProgressData | null }>) {
      if (event.data?.type === 'progressIndicator') {
        setProgress(event.data.payload ?? null);
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleEntries = useCallback((incoming: ActivityEntry[], replace?: boolean) => {
    setEntries(prev => applyEntries(prev, incoming, replace ?? false));
  }, []);

  const { respondToPrompt } = useMessages(handleEntries);

  const handleRespond = useCallback((promptId: string) => {
    respondToPrompt(promptId, '');
  }, [respondToPrompt]);

  const scrollToBottom = useCallback(() => {
    virtuosoRef.current?.scrollToIndex({
      index: 'LAST',
      behavior: 'smooth',
    });
  }, []);

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-4 text-center">
        <p className="text-sm text-[var(--feed-muted)]">No activity yet</p>
        <p className="text-xs text-[var(--feed-muted)] mt-1 opacity-70">
          Launch an agent session to see real-time logs here.
        </p>
      </div>
    );
  }

  return (
    <div className="relative h-screen flex flex-col">
      {/* Progress indicator — doesn't scroll with the feed */}
      <PinnedPlan data={progress} />

      {/* Scrolling activity feed */}
      <div className="relative flex-1">
      <Virtuoso
        ref={virtuosoRef}
        data={entries}
        itemContent={(_index, entry) => (
          <ActivityItem
            entry={entry}
            onRespond={entry.messageType === 'prompt' ? handleRespond : undefined}
          />
        )}
        followOutput={atBottom ? 'smooth' : false}
        atBottomStateChange={setAtBottom}
        atBottomThreshold={50}
        overscan={200}
      />

      {/* Jump to bottom button */}
      {!atBottom && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-3 right-3 px-2.5 py-1 text-[11px] rounded-full shadow-md
            bg-[var(--feed-badge-bg)] text-[var(--feed-badge-fg)]
            hover:opacity-90 cursor-pointer border-none outline-none
            transition-opacity"
        >
          ↓ Latest
        </button>
      )}
      </div>
    </div>
  );
}
