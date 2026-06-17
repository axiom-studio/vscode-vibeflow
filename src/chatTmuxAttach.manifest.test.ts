import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Locks the chat-first tmux-attach button contract (todo #2059). The button's
 * visibility is driven by the `vibeflow.chat.showTmuxAttachButton` setting,
 * which must exist in the manifest as a boolean defaulting to ON and scoped to
 * the chat-first Session Chat UI. We assert against the real package.json — no
 * mocks. (This todo's original commit `fa2333f9` was a creds-less session's
 * local-only commit that never reached origin, so the feature was lost and
 * re-implemented; this test guards the manifest half of the wiring.)
 */

interface ConfigProperty {
  type: string;
  default?: unknown;
  description?: string;
}

const manifestPath = join(process.cwd(), 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  contributes: { configuration: { properties: Record<string, ConfigProperty> } };
};
const props = manifest.contributes.configuration.properties;
const KEY = 'vibeflow.chat.showTmuxAttachButton';

describe('chat-first tmux-attach button (todo #2059) — package.json contract', () => {
  it('contributes the showTmuxAttachButton setting', () => {
    expect(props[KEY], `${KEY} must be contributed in package.json`).toBeDefined();
  });

  it('is a boolean defaulting to ON', () => {
    expect(props[KEY]?.type).toBe('boolean');
    // Default-on is an explicit acceptance criterion ("enabled by default").
    expect(props[KEY]?.default).toBe(true);
  });

  it('scopes the description to the chat-first Session Chat UI', () => {
    const desc = (props[KEY]?.description ?? '').toLowerCase();
    expect(desc).toContain('chat-first');
    // Mentions the actual mechanism so the setting is self-documenting.
    expect(desc).toContain('tmux');
  });

  it('lives in the vibeflow.chat.* namespace, co-located with chat.diffView', () => {
    expect(props['vibeflow.chat.diffView'], 'the sibling chat setting must still exist').toBeDefined();
    expect(KEY.startsWith('vibeflow.chat.')).toBe(true);
  });
});
