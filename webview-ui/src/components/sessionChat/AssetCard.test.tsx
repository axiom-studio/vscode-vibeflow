import { describe, it, expect } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { AssetCard } from './AssetCard';

/**
 * Resolve-retry guard for #3345: after a panel/extension restart the
 * mount-time asset resolve can fail transiently (auth/connection still
 * restoring), and the old card had no retry path — a permanent FAILED
 * chip. The failed chip is now click-to-retry (auto-retry backoff also
 * exists but is time-based; the manual round-trip is what we pin here,
 * per the no-fake-timers policy).
 */
function resolve(payload: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'chatAssetUriResolved', payload },
    }));
  });
}

describe('AssetCard resolve retry (#3345)', () => {
  it('recovers from a failed resolve via click-to-retry', () => {
    render(<AssetCard id={7} name="shot.png" />);

    // Host errors — e.g. 'Not authenticated' while auth restores at startup.
    resolve({ id: 7, error: 'Not authenticated' });
    const chip = screen.getByRole('button', { name: /failed — retry/i });
    expect(chip).toHaveAttribute('title', 'Not authenticated — click to retry');

    // Click-to-retry: the chip clears back to the loading state (a fresh
    // resolve request was posted by the re-run effect)…
    fireEvent.click(chip);
    expect(screen.queryByRole('button', { name: /failed — retry/i })).toBeNull();

    // …and the now-successful resolution renders the image.
    resolve({ id: 7, uri: 'https://example.test/asset.png' });
    const img = screen.getByRole('img', { name: 'shot.png' }) as HTMLImageElement;
    expect(img.src).toBe('https://example.test/asset.png');
  });

  it('ignores resolutions addressed to other asset ids', () => {
    render(<AssetCard id={8} name="doc.pdf" />);
    resolve({ id: 9, error: 'nope' });
    expect(screen.queryByRole('button', { name: /failed — retry/i })).toBeNull();
  });
});
