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

describe('MessageBubble inline working indicator (#2704)', () => {
  const AGENT_MSG: ChatPrompt = {
    ...MSG,
    id: 2,
    source: 'agent',
    status: 'responded',
    response_text: 'ok',
  };

  it('renders the inline Working indicator on a user message when inlineWorkingSince is set', () => {
    render(
      <MessageBubble
        msg={MSG}
        personaName="Kai"
        personaColor="#ffffff"
        diffView="unified"
        sessionMode="vanilla"
        groupStart
        inlineWorkingSince="2026-06-30T00:00:00Z"
      />,
    );
    expect(screen.getByText('Working')).toBeInTheDocument();
  });

  it('does not render the inline indicator when inlineWorkingSince is unset (cleared together with the standalone row)', () => {
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

  it('is gated on the user message — a non-pending agent row does not render it even if inlineWorkingSince is passed', () => {
    render(
      <MessageBubble
        msg={AGENT_MSG}
        personaName="Kai"
        personaColor="#ffffff"
        diffView="unified"
        sessionMode="vanilla"
        groupStart
        inlineWorkingSince="2026-06-30T00:00:00Z"
      />,
    );
    expect(screen.queryByText('Working')).toBeNull();
  });
});
