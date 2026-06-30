import { memo, useCallback, useState } from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { SideRail, SideRailImpl } from './SideRail';
import type { SessionMeta, LogEntry } from './sessionChatTypes';

/**
 * Regression guard for #2703: `SideRail` is `React.memo`'d so it must not
 * re-render its activity ledger on every chat keystroke. That only holds
 * if the callbacks it receives (`onStop` / `onRefresh`) are referentially
 * stable — inline arrows in the parent would bust the memo. Same
 * counting-passthrough technique as the MessageBubble test, with a
 * negative control proving the assertion has teeth. No mocks.
 */

const META: SessionMeta = {
  sessionId: 's1',
  personaName: 'Kai',
  personaKey: 'principal_engineer',
  model: 'claude-opus-4-8',
  branch: 'main',
  status: 'active',
  taskTitle: 'Chat perf',
  taskStatus: 'implementing',
  sessionMode: 'vanilla',
};

const LOGS: LogEntry[] = [
  { text: 'claimed work item', time: '00:00', src: 'todo' },
  { text: 'tests green', time: '00:01', src: 'todo' },
];

let renders = 0;
function Counting(props: Parameters<typeof SideRailImpl>[0]) {
  renders++;
  return <SideRailImpl {...props} />;
}
const Memoized = memo(Counting);

beforeEach(() => {
  renders = 0;
});

function Harness({ stableCallbacks }: { stableCallbacks: boolean }) {
  const [tick, setTick] = useState(0);
  const stableStop = useCallback(() => {}, []);
  const stableRefresh = useCallback(() => {}, []);
  const onStop = stableCallbacks ? stableStop : () => {};
  const onRefresh = stableCallbacks ? stableRefresh : () => {};
  return (
    <>
      <button data-testid="bump" onClick={() => setTick((t) => t + 1)}>
        bump {tick}
      </button>
      <Memoized
        meta={META}
        logs={LOGS}
        personaAvatarUrl="http://example.test/a.jpg"
        onStop={onStop}
        onRefresh={onRefresh}
      />
    </>
  );
}

describe('SideRail memoization', () => {
  it('exports a React.memo-wrapped component', () => {
    expect((SideRail as unknown as { $$typeof: symbol }).$$typeof).toBe(
      Symbol.for('react.memo'),
    );
  });

  it('does NOT re-render when an unrelated parent value changes and callbacks are stable', () => {
    render(<Harness stableCallbacks />);
    expect(screen.getByText('Activity')).toBeInTheDocument();
    expect(renders).toBe(1);

    fireEvent.click(screen.getByTestId('bump'));
    fireEvent.click(screen.getByTestId('bump'));

    expect(renders).toBe(1);
  });

  it('DOES re-render when onStop/onRefresh are unstable (negative control)', () => {
    render(<Harness stableCallbacks={false} />);
    expect(renders).toBe(1);

    fireEvent.click(screen.getByTestId('bump'));

    expect(renders).toBeGreaterThan(1);
  });
});
