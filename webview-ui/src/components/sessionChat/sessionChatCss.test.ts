import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Stylesheet guard for the chat message bodies.
 *
 * Why a source assertion instead of a render assertion: the webview vitest
 * config sets `css: false`, so jsdom never parses the stylesheet and
 * `getComputedStyle` would report nothing for these rules. Asserting on the
 * CSS source is the only check here that actually fails when the rule is
 * removed — same reasoning as `scripts/check-security-guards.mjs`.
 *
 * What it protects: `.msg-response` (the agent body) repeatedly gets missed
 * when a rule is added to `.msg-content` (the user body). It happened for
 * tables (#2325) and again for text wrapping — a long file path in a
 * `.chat-path-ref` chip overflowed the agent bubble because `.msg-response`
 * inherited no `overflow-wrap`.
 */

const CSS = fs.readFileSync(
  path.join(__dirname, 'sessionChat.css'),
  'utf8',
);

/**
 * Comments are stripped before parsing — the rationale comments in this
 * stylesheet mention the very selectors and properties being asserted, so a
 * naive substring search would pass on prose alone and guard nothing.
 */
const CSS_NO_COMMENTS = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** Declaration text of every rule whose selector list includes `selector`. */
function declarationsFor(selector: string): string[] {
  const blocks: string[] = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(CSS_NO_COMMENTS)) !== null) {
    const selectors = (m[1] ?? '').split(',').map(s => s.trim());
    if (selectors.includes(selector)) { blocks.push(m[2] ?? ''); }
  }
  return blocks;
}

const hasDeclaration = (selector: string, prop: string, value: string) =>
  declarationsFor(selector).some(d =>
    new RegExp(`${prop}\\s*:\\s*${value}\\s*(;|$)`).test(d),
  );

describe('sessionChat.css — agent body parity with the user body', () => {
  it('wraps long unbreakable tokens in BOTH bodies', () => {
    // The actual bug: without this on .msg-response, a long path chip runs
    // past the agent bubble's border.
    expect(hasDeclaration('.msg-response', 'overflow-wrap', 'anywhere')).toBe(true);
    expect(hasDeclaration('.msg-content', 'overflow-wrap', 'anywhere')).toBe(true);
  });

  it('styles inline code in BOTH bodies', () => {
    expect(declarationsFor('.msg-response code').length).toBeGreaterThan(0);
    expect(declarationsFor('.msg-content code').length).toBeGreaterThan(0);
  });

  it('styles fenced code blocks in BOTH bodies', () => {
    expect(declarationsFor('.msg-response pre').length).toBeGreaterThan(0);
    expect(declarationsFor('.msg-content pre').length).toBeGreaterThan(0);
  });

  it('keeps atomic chips unbreakable', () => {
    // Commit hashes and work-item refs are short and atomic — `overflow-wrap`
    // must never split them. `white-space: nowrap` is what makes the
    // body-level `anywhere` safe to apply.
    expect(hasDeclaration('.chat-commit-hash', 'white-space', 'nowrap')).toBe(true);
    expect(hasDeclaration('.chat-workitem-ref', 'white-space', 'nowrap')).toBe(true);
  });

  it('leaves path chips breakable', () => {
    // Paths are the high-frequency reference and are long; they must wrap.
    expect(hasDeclaration('.chat-path-ref', 'white-space', 'nowrap')).toBe(false);
  });
});
