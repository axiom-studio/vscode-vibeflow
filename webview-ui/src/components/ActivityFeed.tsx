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
        <div className="flex-1 flex flex-col items-center justify-center px-6 text-center gap-2.5">
          <InboxIcon />
          <p className="text-[13px] font-medium tracking-[-0.005em]">No activity yet</p>
          <p className="text-[11.5px] text-[var(--feed-muted)] max-w-[260px] leading-relaxed">
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
    <div className="flex flex-col items-center justify-center h-full px-6 text-center gap-3">
      <BoltIcon />
      <div className="flex flex-col gap-1.5">
        <p className="text-[13px] font-medium tracking-[-0.005em]">Connect to VibeFlow</p>
        <p className="text-[11.5px] text-[var(--feed-muted)] max-w-[260px] leading-relaxed">
          Sign in to see your agents work in real time.
        </p>
      </div>
      <button
        onClick={onRunSetup}
        className="mt-1 px-3.5 py-1.5 text-[12px] font-medium rounded-sm cursor-pointer
          bg-[var(--vscode-button-background)]
          text-[var(--vscode-button-foreground)]
          hover:bg-[var(--vscode-button-hoverBackground)]
          border-none outline-none
          transition-all duration-150 ease-out active:scale-[0.97]"
      >
        Run Setup
      </button>
    </div>
  );
}

function NoSessionsState({ onLaunchSession }: { onLaunchSession: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full px-6 text-center gap-3">
      <InboxIcon />
      <div className="flex flex-col gap-1.5">
        <p className="text-[13px] font-medium tracking-[-0.005em]">No active sessions</p>
        <p className="text-[11.5px] text-[var(--feed-muted)] max-w-[260px] leading-relaxed">
          Launch an agent session to see activity here.
        </p>
      </div>
      <button
        onClick={onLaunchSession}
        className="mt-1 px-3.5 py-1.5 text-[12px] font-medium rounded-sm cursor-pointer
          bg-[var(--vscode-button-background)]
          text-[var(--vscode-button-foreground)]
          hover:bg-[var(--vscode-button-hoverBackground)]
          border-none outline-none
          transition-all duration-150 ease-out active:scale-[0.97]"
      >
        Launch Session
      </button>
    </div>
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

// Inline SVG icons for empty states. Stroke uses currentColor so the icon
// inherits the muted-foreground via the wrapping span's `color` style —
// adapts cleanly to light/dark/high-contrast themes.
function BoltIcon() {
  return (
    <span aria-hidden style={{ color: 'var(--feed-muted)', opacity: 0.85 }}>
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
      </svg>
    </span>
  );
}

function InboxIcon() {
  return (
    <span aria-hidden style={{ color: 'var(--feed-muted)', opacity: 0.85 }}>
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
        <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
      </svg>
    </span>
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
