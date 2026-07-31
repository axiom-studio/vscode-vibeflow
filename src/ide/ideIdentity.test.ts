import { describe, it, expect } from 'vitest';
import { detectIde, shouldReportIdeUsage } from './ideIdentity.js';

/**
 * These slugs are a WIRE CONTRACT with axiomcloud's `NormalizeIDEID`
 * (database/user_ide_usage.go), which is an exact, case-sensitive map lookup
 * against {vscode, cursor, windsurf, vscodium, other}. If a value here stops
 * matching a key there, the server silently records "other" and still returns
 * 204 — so these assertions are the only thing standing between a typo and a
 * uniformly useless operator breakdown.
 */
describe('detectIde', () => {
  it('maps stock VS Code and its Insiders build', () => {
    expect(detectIde('Visual Studio Code')).toBe('vscode');
    expect(detectIde('Visual Studio Code - Insiders')).toBe('vscode');
  });

  it('maps the VS Code forks that run this same extension', () => {
    expect(detectIde('Cursor')).toBe('cursor');
    expect(detectIde('Windsurf')).toBe('windsurf');
    expect(detectIde('VSCodium')).toBe('vscodium');
  });

  it('maps Kiro', () => {
    expect(detectIde('Kiro')).toBe('kiro');
    expect(detectIde('Kiro - Insiders')).toBe('kiro');
  });

  it('is case-insensitive — appName casing is the fork vendor\'s choice', () => {
    // The server allowlist keys are lowercase and matched exactly, so the
    // client must lowercase. "Cursor" !== "cursor" server-side.
    expect(detectIde('CURSOR')).toBe('cursor');
    expect(detectIde('cursor')).toBe('cursor');
    expect(detectIde('vscodium')).toBe('vscodium');
    expect(detectIde('KIRO')).toBe('kiro');
  });

  /**
   * Sync-by-convention twin of `IDEUsageAllowlist` in axiomcloud's
   * database/user_ide_usage.go. Same contract shape as this repo's RE_COMMIT
   * twins: when one side changes, the other MUST be updated in lockstep.
   *
   * Verified against the merged source at axiomcloud `bf22a11f`.
   */
  const SERVER_ALLOWLIST = ['vscode', 'cursor', 'windsurf', 'vscodium', 'other'];

  it('emits slugs the server actually stores, for every IDE it accepts today', () => {
    // Guards the real failure mode: emitting the display name would file
    // every client under "other" while the endpoint still returned 204.
    for (const appName of [
      'Visual Studio Code', 'Cursor', 'Windsurf', 'VSCodium', 'Some Unknown Fork',
    ]) {
      expect(SERVER_ALLOWLIST).toContain(detectIde(appName));
    }
  });

  it('KNOWN GAP: kiro is not yet in the server allowlist, so it lands as "other"', () => {
    // Intentionally pinning the CURRENT cross-repo state rather than the
    // desired one. The client is forward-compatible — the moment axiomcloud
    // adds "kiro" to IDEUsageAllowlist, existing installs start reporting it
    // with no extension release. Until then Kiro users are counted, just
    // bucketed as "other".
    //
    // When the backend lands it: add 'kiro' to SERVER_ALLOWLIST above, fold
    // 'Kiro' into the test above, and delete this case.
    expect(detectIde('Kiro')).toBe('kiro');
    expect(SERVER_ALLOWLIST).not.toContain('kiro');
  });

  it('prefers the specific fork over the generic VS Code match', () => {
    // Forks often carry "Visual Studio Code" lineage in their naming; the
    // fork identity must win or every fork collapses to `vscode`.
    expect(detectIde('Cursor (Visual Studio Code)')).toBe('cursor');
    expect(detectIde('Windsurf - Visual Studio Code')).toBe('windsurf');
  });

  it('falls back to other for unknown, empty, or missing input', () => {
    expect(detectIde('Some Unknown Fork')).toBe('other');
    expect(detectIde('')).toBe('other');
    expect(detectIde('   ')).toBe('other');
    expect(detectIde(undefined)).toBe('other');
  });
});

describe('shouldReportIdeUsage', () => {
  const now = 1_000_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;

  it('reports on the first run', () => {
    expect(shouldReportIdeUsage(undefined, now)).toBe(true);
  });

  it('does not re-report on a window reload inside 24h', () => {
    expect(shouldReportIdeUsage(now - 60_000, now)).toBe(false);
    expect(shouldReportIdeUsage(now - 23 * 60 * 60 * 1000, now)).toBe(false);
  });

  it('reports again once a day has passed', () => {
    expect(shouldReportIdeUsage(now - DAY, now)).toBe(true);
    expect(shouldReportIdeUsage(now - 5 * DAY, now)).toBe(true);
  });

  it('does not wedge when the system clock moves backwards', () => {
    // A future stamp would otherwise suppress reporting until real time
    // caught up — potentially forever.
    expect(shouldReportIdeUsage(now + 5 * DAY, now)).toBe(true);
  });

  it('reports when the stored stamp is corrupt', () => {
    expect(shouldReportIdeUsage(Number.NaN, now)).toBe(true);
  });
});
