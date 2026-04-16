import { useState, useCallback, useRef, useEffect } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import type { ActivityEntry } from '../types';
import { useMessages, applyEntries } from '../hooks/useMessages';
import { ActivityItem } from './ActivityItem';
import { PinnedPlan, parsePlanFromLog, type PlanStep } from './PinnedPlan';

export function ActivityFeed() {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [atBottom, setAtBottom] = useState(true);
  const [planSteps, setPlanSteps] = useState<PlanStep[]>([]);
  const [planPersona, setPlanPersona] = useState<string>('');
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // Extract plan from the latest summary entry whenever entries change
  useEffect(() => {
    // Find the most recent summary or plan entry
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.messageType === 'summary' && entry.content.includes('PLAN')) {
        const steps = parsePlanFromLog(entry.content);
        if (steps.length > 0) {
          setPlanSteps(steps);
          setPlanPersona(entry.personaName);
          break;
        }
      }
    }
  }, [entries]);

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
      {/* Pinned Plan — doesn't scroll with the feed */}
      <PinnedPlan personaName={planPersona} steps={planSteps} />

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
