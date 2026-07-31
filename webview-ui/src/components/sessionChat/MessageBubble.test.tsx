import { memo, useCallback, useState } from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { MessageBubble, MessageBubbleImpl } from './MessageBubble';
import type { ChatPrompt } from './sessionChatTypes';

/**
 * Regression guard for #2702 / #2330: `MessageBubble` is `React.memo`'d
 * with default shallow equality, so it must NOT re-render (and re-run
 * react-markdown + rehype-highlight) when an unrelated parent value (the
 * chat draft) changes — as long as every prop passed to it is
 * referentially stable. The known failure mode is an unstable
 * `onRespond` (a plain function recreated each render) silently busting
 * the memo, which is exactly the "slow to type" lag the customer hit.
 *
 * No mocks: we render the REAL `MessageBubbleImpl` (real markdown
 * pipeline) through the SAME default `React.memo` production uses, and a
 * thin counting passthrough lets us observe whether the memo bailed. A
 * negative control proves the assertion has teeth.
 */

// Stable across Harness re-renders so the ONLY variable is `onRespond`.
const MSG: ChatPrompt = {
  id: 1,
  created_at: '2026-06-30T00:00:00Z',
  updated_at: '2026-06-30T00:00:00Z',
  prompt_id: 'p1',
  prompt_text: 'Hello **world** — a chat message with `code`.',
  response_text: '',
  status: 'responded',
  responded_at: '2026-06-30T00:00:00Z',
  source: 'user',
};

let renders = 0;
function Counting(props: Parameters<typeof MessageBubbleImpl>[0]) {
  renders++;
  return <MessageBubbleImpl {...props} />;
}
// memo(Counting) is the same default-shallow-equality wrapper as the
// production `memo(MessageBubbleImpl)` — identical bail behavior on an
// identical prop shape.
const Memoized = memo(Counting);

beforeEach(() => {
  renders = 0;
});

function Harness({ stableOnRespond }: { stableOnRespond: boolean }) {
  const [tick, setTick] = useState(0);
  // Stable variant mirrors production (`respond` wrapped in
  // useCallback(..., [])). Unstable variant reproduces the regression.
  const stable = useCallback((_promptId: string, _text: string) => {}, []);
  const unstable = (_promptId: string, _text: string) => {};
  const onRespond = stableOnRespond ? stable : unstable;
  return (
    <>
      <button data-testid="bump" onClick={() => setTick((t) => t + 1)}>
        bump {tick}
      </button>
      <Memoized
        msg={MSG}
        personaName="Kai"
        personaColor="#ffffff"
        diffView="unified"
        sessionMode="vanilla"
        groupStart
        onRespond={onRespond}
      />
    </>
  );
}

describe('MessageBubble memoization', () => {
  it('exports a React.memo-wrapped component', () => {
    expect((MessageBubble as unknown as { $$typeof: symbol }).$$typeof).toBe(
      Symbol.for('react.memo'),
    );
  });

  it('does NOT re-render when only an unrelated parent value changes and onRespond is stable', () => {
    render(<Harness stableOnRespond />);
    // Sanity: the bubble actually mounted and rendered its markdown.
    expect(screen.getByText('world')).toBeInTheDocument();
    expect(renders).toBe(1); // mount only

    fireEvent.click(screen.getByTestId('bump'));
    fireEvent.click(screen.getByTestId('bump'));

    // Memo held: the parent re-rendered twice but the bubble never did.
    expect(renders).toBe(1);
  });

  it('DOES re-render on a parent change when onRespond is unstable (negative control)', () => {
    // Proves the test above can actually catch the #2702 regression.
    render(<Harness stableOnRespond={false} />);
    expect(renders).toBe(1);

    fireEvent.click(screen.getByTestId('bump'));

    expect(renders).toBeGreaterThan(1);
  });
});

describe('MessageBubble Working affordances (#2704 removed by #4203)', () => {
  const AGENT_RESPONDED: ChatPrompt = {
    ...MSG,
    id: 2,
    source: 'agent',
    status: 'responded',
    response_text: 'ok',
  };

  // The inline indicator on the user's own message is gone: its only trigger
  // was the agent-BLOCKED timestamp (an agent-authored prompt still pending),
  // so it claimed "Working" exactly when the agent was waiting on the human.
  // Re-pointing it at the real working signal would have duplicated the
  // standalone bubble that #2770 settled on, so it was removed outright.
  it('renders no Working indicator on a plain user message', () => {
    render(
      <MessageBubble
        msg={MSG}
        personaName="Kai"
        personaColor="#ffffff"
        diffView="unified"
        sessionMode="vanilla"
        groupStart
      />,
    );
    expect(screen.queryByText('Working')).toBeNull();
  });

  it('renders no Working indicator on a responded agent row', () => {
    render(
      <MessageBubble
        msg={AGENT_RESPONDED}
        personaName="Kai"
        personaColor="#ffffff"
        diffView="unified"
        sessionMode="vanilla"
        groupStart
      />,
    );
    expect(screen.queryByText('Working')).toBeNull();
  });
});

/**
 * Side avatar rail guard for #2772 (web-chat parity, assets #1439/#1440):
 * the group's first row carries a persona portrait beside agent bubbles and
 * a "U" badge beside user bubbles; grouped follow-ups keep an invisible
 * spacer so bubbles stay aligned. The old 20px in-header avatar is gone.
 */
describe('MessageBubble side avatars (#2772)', () => {
  const base = {
    personaName: 'Kai',
    personaColor: '#ffffff',
    diffView: 'unified' as const,
    sessionMode: 'vanilla',
    onRespond: (_p: string, _t: string) => {},
  };

  it('renders the U badge beside a user group-start row', () => {
    const { container } = render(<MessageBubble msg={MSG} groupStart {...base} />);
    const badge = container.querySelector('.msg-side-avatar-user');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe('U');
    expect(container.querySelector('.msg-row')!.className).toContain('msg-user');
  });

  it('renders the persona avatar (fallback glyph when no portrait) beside an agent group-start row', () => {
    const agentMsg: ChatPrompt = { ...MSG, id: 3, source: 'agent', response_text: 'ok' };
    const { container } = render(<MessageBubble msg={agentMsg} groupStart {...base} />);
    const avatar = container.querySelector('.msg-side-avatar');
    expect(avatar).not.toBeNull();
    expect(avatar!.classList.contains('msg-side-avatar-user')).toBe(false);
    expect(avatar!.textContent).toBe('K'); // personaName fallback glyph
    // The replaced in-header avatar must not come back.
    expect(container.querySelector('.msg-header-avatar')).toBeNull();
  });

  it('renders only the alignment spacer on grouped follow-up rows', () => {
    const { container } = render(<MessageBubble msg={MSG} groupStart={false} {...base} />);
    expect(container.querySelector('.msg-side-avatar')).toBeNull();
    expect(container.querySelector('.msg-side-avatar-spacer')).not.toBeNull();
  });

  it('renders the avatar on a mid-group agent PENDING row — any headered row shows its author (#3344)', () => {
    const pendingAgent: ChatPrompt = { ...MSG, id: 4, source: 'agent', status: 'pending', response_text: '' };
    const { container } = render(<MessageBubble msg={pendingAgent} groupStart={false} {...base} />);
    const avatar = container.querySelector('.msg-side-avatar');
    expect(avatar).not.toBeNull();
    expect(avatar!.textContent).toBe('K');
    expect(container.querySelector('.msg-side-avatar-spacer')).toBeNull();
  });
});

/**
 * "Agent needs your input" treatment guard for #2774 (web-chat parity,
 * assets #1442/#1443): an agent-initiated pending prompt must be visually
 * unmistakable — attention class + caps label — and carry the prominent
 * reply box wired to onRespond. Ordinary rows get none of it.
 */
describe('MessageBubble agent-needs-input treatment (#2774)', () => {
  const base = {
    personaName: 'Kai',
    personaColor: '#ffffff',
    diffView: 'unified' as const,
    sessionMode: 'chat_first',
  };
  const pendingAgent: ChatPrompt = { ...MSG, id: 5, prompt_id: 'p5', source: 'agent', status: 'pending', response_text: '' };

  it('marks the row, shows the label, and submits a reply through onRespond', () => {
    const replies: Array<[string, string]> = [];
    const { container } = render(
      <MessageBubble
        msg={pendingAgent}
        groupStart
        onRespond={(p, t) => replies.push([p, t])}
        {...base}
      />,
    );
    expect(container.querySelector('.msg-row')!.className).toContain('msg-needs-input');
    expect(screen.getByText('Agent needs your input')).toBeInTheDocument();

    const input = screen.getByPlaceholderText('Type your response...') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '1' } });
    fireEvent.submit(input.closest('form')!);
    expect(replies).toEqual([['p5', '1']]);
    expect(input.value).toBe('');
  });

  it('applies none of the treatment to an ordinary responded message', () => {
    const { container } = render(
      <MessageBubble msg={MSG} groupStart onRespond={() => {}} {...base} />,
    );
    expect(container.querySelector('.msg-row')!.className).not.toContain('msg-needs-input');
    expect(screen.queryByText('Agent needs your input')).toBeNull();
    expect(screen.queryByPlaceholderText('Type your response...')).toBeNull();
  });
});

/**
 * Markdown-LINKED commit hashes (#3360): the backend's done notification
 * embeds the full hash as a markdown link. A plain anchor dead-ends in
 * the webview, so anchors whose text is a hash must render as the
 * canonical commit chip; ordinary links keep anchor behavior.
 */
describe('MessageBubble markdown-linked commit hashes (#3360)', () => {
  const base = {
    personaName: 'Kai',
    personaColor: '#ffffff',
    diffView: 'unified' as const,
    sessionMode: 'chat_first',
  };
  const FULL = 'c5f6181f1f83db7ab771addacb1b2c603600b52c';

  it('renders a hash-text link as the commit chip, not an anchor', () => {
    const msg: ChatPrompt = {
      ...MSG,
      id: 6,
      prompt_text: `Updated issue #3345 → **done** ([${FULL}](https://cloud.axiomstudio.ai/x/y))`,
    };
    const { container } = render(<MessageBubble msg={msg} groupStart {...base} />);

    const chip = container.querySelector('button.chat-commit-hash');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toBe(FULL.slice(0, 7));
    expect(chip!.getAttribute('data-hash')).toBe(FULL);
    expect(container.querySelector('.msg-content a')).toBeNull();
  });

  it('keeps ordinary links as anchors', () => {
    const msg: ChatPrompt = {
      ...MSG,
      id: 7,
      prompt_text: 'See [the docs](https://example.com/docs) for details.',
    };
    const { container } = render(<MessageBubble msg={msg} groupStart {...base} />);
    const anchor = container.querySelector('.msg-content a') as HTMLAnchorElement;
    expect(anchor).not.toBeNull();
    expect(anchor.textContent).toBe('the docs');
    expect(container.querySelector('button.chat-commit-hash')).toBeNull();
  });
});

/**
 * A blocked agent is not working (#4203).
 *
 * An agent-authored prompt still `pending` means the agent ASKED the user
 * something and is waiting on the answer — the same condition that renders
 * "Agent needs your input" and the reply box. The header used to render a
 * WorkingIndicator on exactly that condition (`status === 'pending' && !isUser`),
 * so the row claimed the agent was busy while it was in fact blocked on the
 * human. axiomcloud suppresses its pill on the same state (its #3592).
 */
describe('MessageBubble blocked-agent row (#4203)', () => {
  const AGENT_PENDING: ChatPrompt = {
    ...MSG,
    id: 3,
    source: 'agent',
    status: 'pending',
    prompt_text: 'Which approach do you prefer?',
    response_text: '',
  };

  it('shows "Agent needs your input" and NO Working indicator', () => {
    render(
      <MessageBubble
        msg={AGENT_PENDING}
        personaName="Kai"
        personaColor="#ffffff"
        diffView="unified"
        sessionMode="vanilla"
        groupStart
      />,
    );
    expect(screen.getByText('Agent needs your input')).toBeInTheDocument();
    expect(screen.queryByText('Working')).toBeNull();
    expect(screen.queryByLabelText(/^Working for/)).toBeNull();
  });
});
