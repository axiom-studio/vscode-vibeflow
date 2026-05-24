import { describe, it, expect } from 'vitest';
import { getNonce } from './nonce.js';

describe('getNonce', () => {
  it('returns a 32-char hex string (16 random bytes → 32 hex chars)', () => {
    const n = getNonce();
    expect(n).toHaveLength(32);
    expect(n).toMatch(/^[0-9a-f]{32}$/);
  });

  it('uses crypto.randomBytes — successive calls collide with vanishing probability', () => {
    // 100 calls. Birthday-paradox collision probability over 100 16-byte
    // nonces is ~5e-30 — for practical purposes, NEVER. If this fails
    // someone wired Math.random back in (the historical regression
    // tracked as issue #1566 / #1746). Lock against re-regression.
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) { seen.add(getNonce()); }
    expect(seen.size).toBe(100);
  });

  it('contains no characters outside the lower-hex alphabet', () => {
    // crypto.randomBytes().toString('hex') guarantees [0-9a-f]; if a
    // refactor switched to base64 or another encoding it might admit
    // characters that break a `'nonce-{X}'` CSP source value.
    for (let i = 0; i < 25; i++) {
      const n = getNonce();
      expect(n).toMatch(/^[0-9a-f]+$/);
    }
  });
});
