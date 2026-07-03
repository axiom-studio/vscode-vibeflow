import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { enhanceLeafText, type ChatTokenDispatch } from './chatTokens';

/**
 * Work-item reference tokenization (#3350) + its interplay with the
 * pre-existing commit-hash tokenizer. Rendered through the REAL
 * enhanceLeafText — no mocks; dispatch fns are plain recorders.
 */

function recordingDispatch() {
  const opened: Array<{ kind: 'issue' | 'todo'; id: number }> = [];
  const commits: string[] = [];
  const dispatch: ChatTokenDispatch = {
    openCommit: hash => { commits.push(hash); },
    openPath: () => {},
    openWorkItem: (kind, id) => { opened.push({ kind, id }); },
  };
  return { dispatch, opened, commits };
}

describe('chatTokens — work-item references (#3350)', () => {
  it('tokenizes issue and todo refs into per-kind chips and dispatches on click', () => {
    const { dispatch, opened } = recordingDispatch();
    const { container } = render(
      <p>{enhanceLeafText('Fixed by todo #2776 after issue #3348 was filed.', dispatch)}</p>,
    );

    const todoBtn = container.querySelector('button.chat-workitem-todo');
    const issueBtn = container.querySelector('button.chat-workitem-issue');
    expect(todoBtn?.textContent).toBe('todo #2776');
    expect(issueBtn?.textContent).toBe('issue #3348');

    fireEvent.click(todoBtn!);
    fireEvent.click(issueBtn!);
    expect(opened).toEqual([
      { kind: 'todo', id: 2776 },
      { kind: 'issue', id: 3348 },
    ]);
  });

  it('matches case-insensitively but preserves the original label text', () => {
    const { dispatch, opened } = recordingDispatch();
    const { container } = render(
      <p>{enhanceLeafText('Updated Issue #3347 to done.', dispatch)}</p>,
    );
    const btn = container.querySelector('button.chat-workitem-issue');
    expect(btn?.textContent).toBe('Issue #3347');
    fireEvent.click(btn!);
    expect(opened).toEqual([{ kind: 'issue', id: 3347 }]);
  });

  it('leaves bare #N and keyword-less numbers as plain text', () => {
    const { dispatch } = recordingDispatch();
    const { container } = render(
      <p>{enhanceLeafText('See #123 and PR #456 for details.', dispatch)}</p>,
    );
    expect(container.querySelector('button.chat-workitem-ref')).toBeNull();
    expect(container.textContent).toBe('See #123 and PR #456 for details.');
  });

  it('ignores refs whose number runs into letters', () => {
    const { dispatch } = recordingDispatch();
    const { container } = render(
      <p>{enhanceLeafText('todo #123abc is not a ref', dispatch)}</p>,
    );
    expect(container.querySelector('button.chat-workitem-ref')).toBeNull();
  });

  it('falls back to plain text when the dispatch has no openWorkItem handler', () => {
    const dispatch: ChatTokenDispatch = { openCommit: () => {}, openPath: () => {} };
    const { container } = render(
      <p>{enhanceLeafText('todo #2776 stays text', dispatch)}</p>,
    );
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toBe('todo #2776 stays text');
  });

  it('coexists with commit-hash tokenization in one leaf (done-notification shape)', () => {
    const { dispatch, opened, commits } = recordingDispatch();
    const text = 'Updated issue #3347 → done (575542919a42a19aaa654a5d0c1a8a6232d0e8dd)';
    const { container } = render(<p>{enhanceLeafText(text, dispatch)}</p>);

    const issueBtn = container.querySelector('button.chat-workitem-issue');
    const hashBtn = container.querySelector('button.chat-commit-hash');
    expect(issueBtn?.textContent).toBe('issue #3347');
    expect(hashBtn?.textContent).toBe('5755429'); // shortened display, full hash dispatched

    fireEvent.click(hashBtn!);
    fireEvent.click(issueBtn!);
    expect(commits).toEqual(['575542919a42a19aaa654a5d0c1a8a6232d0e8dd']);
    expect(opened).toEqual([{ kind: 'issue', id: 3347 }]);
  });
});
