import { useState, useCallback, useRef, useEffect } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import type { ActivityEntry, FeedState } from '../types';
import { useMessages, applyEntries } from '../hooks/useMessages';
import { ActivityItem } from './ActivityItem';
import { PinnedPlan, type PinnedProgressData } from './PinnedPlan';
import { getVsCodeApi } from '../vscodeApi';

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
        <div className="flex-1 flex flex-col items-center justify-center px-4 text-center">
          <p className="text-sm text-[var(--feed-muted)]">No activity yet</p>
          <p className="text-xs text-[var(--feed-muted)] mt-1 opacity-70">
            Launch an agent session to see real-time logs here.
          </p>
        </div>
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
    <div className="flex flex-col items-center justify-center h-full px-4 text-center gap-3">
      <div className="text-3xl" aria-hidden>⚡</div>
      <p className="text-sm text-[var(--feed-muted)]">
        Connect to VibeFlow to see agent activity
      </p>
      <button
        onClick={onRunSetup}
        className="mt-2 px-3 py-1.5 text-xs rounded-sm cursor-pointer
          bg-[var(--vscode-button-background)]
          text-[var(--vscode-button-foreground)]
          hover:bg-[var(--vscode-button-hoverBackground)]
          border-none outline-none transition-colors"
      >
        Run Setup
      </button>
    </div>
  );
}

function NoSessionsState({ onLaunchSession }: { onLaunchSession: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full px-4 text-center gap-3">
      <p className="text-sm text-[var(--feed-muted)]">
        No active agent sessions
      </p>
      <p className="text-xs text-[var(--feed-muted)] opacity-70">
        Launch a session to see activity here
      </p>
      <button
        onClick={onLaunchSession}
        className="mt-2 px-3 py-1.5 text-xs rounded-sm cursor-pointer
          bg-[var(--vscode-button-background)]
          text-[var(--vscode-button-foreground)]
          hover:bg-[var(--vscode-button-hoverBackground)]
          border-none outline-none transition-colors"
      >
        Launch Session
      </button>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-col items-center justify-center h-full px-4 text-center gap-3">
      <Spinner />
      <p className="text-sm text-[var(--feed-muted)]">
        Connecting to agent activity feed...
      </p>
    </div>
  );
}

function DisconnectedBanner() {
  return (
    <div
      role="status"
      className="flex items-center gap-2 px-3 py-1.5 text-xs
        bg-[var(--vscode-inputValidation-warningBackground,rgba(255,165,0,0.15))]
        text-[var(--vscode-inputValidation-warningForeground,inherit)]
        border-b border-[var(--vscode-inputValidation-warningBorder,transparent)]"
    >
      <Spinner small />
      <span>Connection lost. Retrying...</span>
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
