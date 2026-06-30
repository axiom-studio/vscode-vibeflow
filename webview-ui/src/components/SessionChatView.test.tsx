import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionChatView } from './SessionChatView';

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
