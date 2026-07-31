import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionChatView } from './SessionChatView';
import type { ChatPrompt } from './sessionChat/sessionChatTypes';

/**
 * @mention caret-tracking guard for #2703. The chat textarea snapshots the
 * caret on `onChange` AND on `onKeyUp` / `onClick` / `onSelect`; #2703
 * deliberately KEPT the latter handlers because the element `select`
 * event does not fire on caret-only moves in Chromium, so without them
 * the @mention `cursor` would go stale on arrow-key / click repositioning.
 *
 * This mounts the REAL SessionChatView (the vscode host bridge is the
 * jsdom stub from setup.ts — a transport, not a logic mock) and verifies:
 *  - typing `@` opens the mention kind-chooser (onChange snapshots cursor)
 *  - moving the caret out of the @-token and firing keyUp closes it
 *    (the onKeyUp caret snapshot keeps `cursor` accurate)
 */
describe('SessionChatView @mention caret tracking', () => {
  it('opens the picker on @ and closes it when the caret leaves the token', async () => {
    const user = userEvent.setup();
    render(<SessionChatView />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    await user.click(textarea);
    await user.type(textarea, '@todo');

    // onChange snapshotted the caret (pos 5, inside the @-token) → picker open.
    expect(
      screen.getByRole('listbox', { name: '@mention type' }),
    ).toBeInTheDocument();

    // Move the caret before the '@' WITHOUT changing the text, then fire
    // keyUp — the kept onKeyUp caret snapshot must update `cursor` so the
    // picker recognizes the caret is no longer in an @-token and closes.
    textarea.setSelectionRange(0, 0);
    fireEvent.keyUp(textarea, { key: 'ArrowLeft' });

    expect(
      screen.queryByRole('listbox', { name: '@mention type' }),
    ).toBeNull();
  });
});

/**
 * Load-older UX guard for #2711. When there is more history, clicking (or the
 * auto-scroll trigger firing) "load older" shows a fetching indicator while the
 * chatLoadOlder → chatPrepend round-trip is in flight, then clears it on the
 * prepend. (The scroll-position math is layout-dependent — jsdom has no layout
 * engine — so we assert the state/indicator flow, not pixel positions.)
 */
function userMsg(id: number, text: string): ChatPrompt {
  return {
    id,
    created_at: '2026-06-30T00:00:00Z',
    updated_at: '2026-06-30T00:00:00Z',
    prompt_id: `p${id}`,
    prompt_text: text,
    response_text: '',
    status: 'responded',
    responded_at: '2026-06-30T00:00:00Z',
    source: 'user',
  };
}

function sendHost(type: string, payload: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { type, payload } }));
  });
}

describe('SessionChatView load-older fetching indicator (#2711)', () => {
  it('shows the fetching indicator while loading older history and clears it on prepend', async () => {
    const user = userEvent.setup();
    render(<SessionChatView />);

    // Seed a transcript that reports more history available.
    sendHost('chatTranscript', { messages: [userMsg(10, 'newest')], hasMore: true });

    const btn = await screen.findByRole('button', { name: /load older messages/i });
    await user.click(btn);

    // In flight: indicator visible, the button is replaced.
    expect(screen.getByText(/loading older messages/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load older messages/i })).toBeNull();

    // Older page arrives → indicator clears; no more history → no button.
    sendHost('chatPrepend', { messages: [userMsg(9, 'older')], hasMore: false });

    expect(screen.queryByText(/loading older messages/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /load older messages/i })).toBeNull();
  });
});

/**
 * Optimistic Working bubble guard for #2769 (web-chat parity, asset #1437).
 * Sending a chat message must show the agent-side Working bubble
 * SYNCHRONOUSLY — before the host echoes anything back — and the bubble
 * must survive the own-row `chatAppend` (still pending) and clear the
 * moment the agent's reply lands in the transcript. A send failure
 * (chatError) clears it too.
 */
describe('SessionChatView optimistic Working bubble on send (#2769)', () => {
  function pendingUserMsg(id: number, text: string): ChatPrompt {
    return { ...userMsg(id, text), status: 'pending', responded_at: '', response_text: '' };
  }

  async function renderAndSend() {
    const user = userEvent.setup();
    render(<SessionChatView />);
    sendHost('chatTranscript', { messages: [userMsg(10, 'earlier')], hasMore: false });

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    await user.click(textarea);
    await user.type(textarea, 'hello agent');
    await user.click(screen.getByRole('button', { name: /send/i }));
    return user;
  }

  it('shows the bubble the instant a message is sent and clears when the reply lands', async () => {
    await renderAndSend();

    // Immediately after clicking Send — no host message has arrived yet —
    // the standalone Working bubble (WorkingIndicator aria-label) is visible.
    expect(screen.getAllByLabelText(/^Working for/)).toHaveLength(1);

    // The host echoes the created row (still pending) — the bubble persists
    // and stays the ONLY Working affordance: the user row's old header
    // indicator was removed in #2770 as redundant duplication.
    sendHost('chatAppend', { messages: [pendingUserMsg(11, 'hello agent')] });
    expect(screen.getAllByLabelText(/^Working for/)).toHaveLength(1);

    // The agent's reply lands (row flips to responded with response_text) —
    // every Working affordance clears.
    sendHost('chatAppend', {
      messages: [{ ...userMsg(11, 'hello agent'), response_text: 'done!' }],
    });
    expect(screen.queryAllByLabelText(/^Working for/)).toHaveLength(0);
  });

  it('clears the bubble when the send fails (chatError)', async () => {
    await renderAndSend();
    expect(screen.getByLabelText(/^Working for/)).toBeInTheDocument();

    sendHost('chatError', { message: 'Failed to send: boom' });
    expect(screen.queryByLabelText(/^Working for/)).toBeNull();
  });
});

/**
 * Pin-on-send guard for #2775 (asset #1444): sending must pin the view to
 * the bottom with an INSTANT scroll — the smooth animation #2769 used
 * raced the scroll handler's pinned detection, so the send echo and the
 * Working bubble landed below the fold behind the scroll-down pill. With
 * the pin intact, subsequent appends auto-scroll as messages arrive.
 */
describe('SessionChatView pins to bottom on send (#2775)', () => {
  it('scrolls instantly on send and keeps auto-scrolling on the echo append', async () => {
    const user = userEvent.setup();
    render(<SessionChatView />);
    const scroller = document.querySelector('.chat-scroller') as HTMLElement;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 });

    sendHost('chatTranscript', { messages: [userMsg(10, 'earlier')], hasMore: false });
    // Simulate the user having drifted off the bottom (e.g. a mid-animation
    // scroll sample) before sending.
    scroller.scrollTop = 200;
    fireEvent.scroll(scroller);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    await user.click(textarea);
    await user.type(textarea, 'hello agent');
    await user.click(screen.getByRole('button', { name: /send/i }));

    // send() pins + queues an instant scroll on the next frame.
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    expect(scroller.scrollTop).toBe(1000);

    // The host echo grows the transcript — still pinned, so it auto-scrolls.
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1400 });
    sendHost('chatAppend', {
      messages: [{ ...userMsg(11, 'hello agent'), status: 'pending', responded_at: '', response_text: '' }],
    });
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    expect(scroller.scrollTop).toBe(1400);
  });
});

describe('SessionChatView opens at the bottom (#2712)', () => {
  it('jumps the transcript to the bottom on the initial full-replace load', () => {
    render(<SessionChatView />);
    const scroller = document.querySelector('.chat-scroller') as HTMLElement;
    // jsdom has no layout engine (scrollHeight is 0), so give the scroller a
    // non-zero height to observe the pre-paint open-at-bottom assignment.
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 });
    scroller.scrollTop = 0;

    sendHost('chatTranscript', {
      messages: [userMsg(1, 'a'), userMsg(2, 'b')],
      hasMore: false,
    });

    // The layout effect pinned it to the bottom (scrollTop === scrollHeight)
    // before paint — no visible top→bottom jump.
    expect(scroller.scrollTop).toBe(1000);
  });
});

/**
 * Live Working indicator (#3387). The chat panel must show a Working bubble
 * whenever the agent is active — driven by the host's `chatWorking` relay of
 * the SessionWorkingObserver state — not only optimistically after a user
 * send. It clears when the host reports `working:false` (done/idle).
 */
describe('SessionChatView live Working indicator (#3387)', () => {
  it('shows the Working bubble on chatWorking:true and hides it on chatWorking:false', () => {
    render(<SessionChatView />);
    // Past the loading skeleton with no user-sent message (so any bubble is
    // live-driven, not the optimistic post-send one).
    sendHost('chatTranscript', { messages: [], hasMore: false });
    expect(screen.queryByLabelText(/^Working for/)).toBeNull();

    // Live activity for this session → the Working bubble appears.
    sendHost('chatWorking', { working: true, startedAtMs: Date.now() - 5000 });
    expect(screen.getByLabelText(/^Working for/)).toBeInTheDocument();

    // Agent goes done/idle → the bubble clears.
    sendHost('chatWorking', { working: false });
    expect(screen.queryByLabelText(/^Working for/)).toBeNull();
  });
});

/**
 * A blocked agent is not working (#4203).
 *
 * An agent-authored prompt still `pending` means the agent asked the user
 * something and is waiting — the state that renders "Agent needs your input"
 * and a reply box. The live `chatWorking` signal can still be true (or stale)
 * at that moment, so without an explicit suppression the standalone bubble
 * kept claiming the agent was busy while it was blocked on the human.
 * axiomcloud carries the same rule (`!hasPendingAgentPrompt`, its #3592).
 */
describe('SessionChatView blocked-agent suppression (#4203)', () => {
  function agentPendingMsg(id: number, text: string): ChatPrompt {
    return {
      ...userMsg(id, text),
      source: 'agent',
      status: 'pending',
      responded_at: '',
      response_text: '',
    };
  }

  it('suppresses the Working bubble while an agent prompt awaits the user', () => {
    render(<SessionChatView />);
    sendHost('chatTranscript', {
      messages: [agentPendingMsg(20, 'Which approach do you prefer?')],
      hasMore: false,
    });

    // Even with live working state asserted by the host, a blocked agent
    // must not be reported as working.
    sendHost('chatWorking', { working: true, startedAtMs: Date.now() - 5000 });
    expect(screen.queryAllByLabelText(/^Working for/)).toHaveLength(0);

    // The blocked-state affordance is what should be visible instead.
    expect(screen.getByText('Agent needs your input')).toBeInTheDocument();
  });

  it('shows the Working bubble again once the agent prompt is answered', () => {
    render(<SessionChatView />);
    sendHost('chatTranscript', {
      messages: [agentPendingMsg(21, 'Which approach?')],
      hasMore: false,
    });
    sendHost('chatWorking', { working: true, startedAtMs: Date.now() - 5000 });
    expect(screen.queryAllByLabelText(/^Working for/)).toHaveLength(0);

    // The user replies → the row flips to responded → no longer blocked, so
    // the live working state is free to surface again.
    sendHost('chatAppend', {
      messages: [{ ...agentPendingMsg(21, 'Which approach?'), status: 'responded', response_text: 'ack' }],
    });
    expect(screen.getByLabelText(/^Working for/)).toBeInTheDocument();
  });
});
