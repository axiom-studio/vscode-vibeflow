import { useState, useCallback, useRef, useEffect } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import type { ActivityEntry, FeedState } from '../types';
import { useMessages, applyEntries } from '../hooks/useMessages';
import { ActivityItem } from './ActivityItem';
import { PinnedPlan, type PinnedProgressData } from './PinnedPlan';
import { getVsCodeApi } from '../vscodeApi';
import { EmptyState } from './_shared/EmptyState';
import { BoltIcon, InboxIcon } from './_shared/icons';

const vscode = getVsCodeApi() as {
  postMessage: (msg: { type: string; payload?: unknown }) => void;
};

export function ActivityFeed() {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [atBottom, setAtBottom] = useState(true);
  const [progress, setProgress] = useState<PinnedProgressData | null>(null);
  const [feedState, setFeedState] = useState<FeedState | undefined>(undefined);
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // Subscribe to host-pushed progress + feed-state snapshots. Both are
  // host-driven and replace-on-write, so a single listener with a switch
  // is enough — no need for two effects.
  useEffect(() => {
    function handleMessage(event: MessageEvent<{ type: string; payload: unknown }>) {
      const msg = event.data;
      if (!msg) { return; }
      if (msg.type === 'progressIndicator') {
        setProgress((msg.payload as PinnedProgressData | null) ?? null);
      } else if (msg.type === 'feedState') {
        setFeedState(msg.payload as FeedState);
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

  const runSetup = useCallback(() => {
    vscode.postMessage({ type: 'runSetup', payload: undefined });
  }, []);
  const launchSession = useCallback(() => {
    vscode.postMessage({ type: 'launchSession', payload: undefined });
  }, []);

  // Render order, per Design Spec Doc #224 §"Activity Feed States":
  // 1. unauthenticated  → CTA → Run Setup
  // 2. noSessions       → CTA → Launch Session
  // 3. sessionsActive + entries.length === 0 → spinner ("Connecting…")
  // 4. sessionsActive + entries.length > 0   → live feed
  // disconnected is overlaid as a top banner regardless (entries persist
  // underneath so a transient outage doesn't blank the screen).
  if (feedState?.kind === 'unauthenticated') {
    return <UnauthenticatedState onRunSetup={runSetup} />;
  }
  if (feedState?.kind === 'noSessions') {
    return <NoSessionsState onLaunchSession={launchSession} />;
  }
  if (entries.length === 0 && feedState?.kind === 'sessionsActive') {
    return <LoadingState />;
  }
  if (entries.length === 0) {
    // Race-safe fallback: feedState hasn't arrived yet (or is
    // disconnected with no prior entries). Match the disconnected banner
    // so the UI never goes blank during a stale-data window.
    return (
      <div className="relative h-screen flex flex-col">
        {feedState?.kind === 'disconnected' && <DisconnectedBanner />}
        <EmptyState
          icon={<InboxIcon />}
          headline="No activity yet"
          subtext="Launch an agent session to see real-time logs here."
          className="flex-1 flex flex-col items-center justify-center px-6 text-center gap-2.5"
        />
      </div>
    );
  }

  return (
    <div className="relative h-screen flex flex-col">
      {feedState?.kind === 'disconnected' && <DisconnectedBanner />}

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
          aria-label="Scroll to latest activity"
          className="absolute bottom-3 right-3 px-2.5 py-[5px] text-[11px] font-medium rounded-full
            bg-[var(--feed-badge-bg)] text-[var(--feed-badge-fg)]
            hover:opacity-90 cursor-pointer border-none outline-none
            transition-all duration-150 ease-out active:scale-[0.96]"
          style={{
            boxShadow: '0 2px 8px color-mix(in oklab, var(--vscode-foreground) 18%, transparent)',
          }}
        >
          ↓ Latest
        </button>
      )}
      </div>
    </div>
  );
}

// ============================================================
// Empty-state subcomponents
// ============================================================
//
// The three full-screen states share a layout (centered column, icon,
// headline, optional subtext, primary action) but differ enough in copy
// and behavior that a single component with branching props would be
// less readable than three small ones. Kept inline so they live next to
// the parent component that owns them.

function UnauthenticatedState({ onRunSetup }: { onRunSetup: () => void }) {
  return (
    <EmptyState
      icon={<BoltIcon />}
      headline="Connect to VibeFlow"
      subtext="Sign in to see your agents work in real time."
      action={{ label: 'Run Setup', onClick: onRunSetup }}
    />
  );
}

function NoSessionsState({ onLaunchSession }: { onLaunchSession: () => void }) {
  return (
    <EmptyState
      icon={<InboxIcon />}
      headline="No active sessions"
      subtext="Launch an agent session to see activity here."
      action={{ label: 'Launch Session', onClick: onLaunchSession }}
    />
  );
}

function LoadingState() {
  return (
    <div className="flex flex-col items-center justify-center h-full px-6 text-center gap-3">
      <Spinner />
      <p className="text-[11.5px] text-[var(--feed-muted)] tracking-[0.005em]">
        Connecting to agent activity…
      </p>
    </div>
  );
}

function DisconnectedBanner() {
  return (
    <div
      role="status"
      className="flex items-center gap-2 px-3 py-[5px] text-[11px]
        bg-[var(--vscode-inputValidation-warningBackground,rgba(255,165,0,0.12))]
        text-[var(--vscode-inputValidation-warningForeground,inherit)]
        border-b border-[var(--vscode-inputValidation-warningBorder,transparent)]"
    >
      <Spinner small />
      <span>Connection lost. Retrying…</span>
    </div>
  );
}

function Spinner({ small = false }: { small?: boolean }) {
  const size = small ? 12 : 24;
  // Pure CSS spinner via Tailwind's `animate-spin`; uses the active
  // foreground color so it adapts to light/dark/high-contrast themes.
  return (
    <span
      aria-label="Loading"
      role="presentation"
      style={{ width: size, height: size, borderWidth: small ? 1.5 : 2 }}
      className="inline-block rounded-full animate-spin
        border-[var(--vscode-foreground)] border-t-transparent"
    />
  );
}
