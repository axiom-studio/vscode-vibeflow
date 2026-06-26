import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  detectExternalAuth,
  validateProviderKey,
  buildProvidersWithAvailability,
  runLaunchGuarded,
  findActiveSession,
} from './sessionCommands.js';
import type { VibeFlowSession } from '../api/types.js';

/**
 * Tests for the pure-function helpers added in #2174 / #2179.
 *
 * External boundaries we stub / restore (per project test policy):
 *   - `process.env[X]` — set/delete via beforeEach/afterEach, restoring
 *     the original value. NOT a mock — real env reads, just real
 *     state-and-restore so tests don't leak.
 *   - `os.homedir()` via `HOME` env override — same pattern.
 *   - The `vscode` module — aliased to a no-op stub in vitest.config.ts
 *     so `sessionCommands.ts`'s top-level `import * as vscode from
 *     'vscode'` doesn't crash the module loader. Tests never reach
 *     vscode-using code paths.
 *   - `isBinaryOnPath` calls into `child_process.execFileSync('which',
 *     [name])`. Tests use REAL universally-available binaries (`sh`,
 *     `node`) and clearly-absent names — no mock. The whichBinary
 *     module memoizes per process, so we call `clearWhichBinaryCache`
 *     in beforeEach if needed (none of these tests change PATH so
 *     memoization is fine).
 */

describe('detectExternalAuth', () => {
  const ENV_VAR = 'TEST_VIBEFLOW_KEY_PROBE';
  let prevValue: string | undefined;
  let prevHome: string | undefined;
  let tmpDir: string | undefined;
  // The 'MCP_TOKEN'-probe test below asserts detectExternalAuth('MCP_TOKEN')
  // is null, but this var is exported in real VibeFlow agent shells (the MCP
  // connection token), which made the test non-hermetic — it passed on CI yet
  // failed inside an agent session. Save/clear/restore it like ENV_VAR + HOME.
  let prevMcpToken: string | undefined;

  beforeEach(() => {
    prevValue = process.env[ENV_VAR];
    delete process.env[ENV_VAR];
    prevHome = process.env.HOME;
    prevMcpToken = process.env.MCP_TOKEN;
    delete process.env.MCP_TOKEN;
  });

  afterEach(() => {
    if (prevValue === undefined) { delete process.env[ENV_VAR]; }
    else { process.env[ENV_VAR] = prevValue; }
    if (prevHome === undefined) { delete process.env.HOME; }
    else { process.env.HOME = prevHome; }
    if (prevMcpToken === undefined) { delete process.env.MCP_TOKEN; }
    else { process.env.MCP_TOKEN = prevMcpToken; }
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* fine */ }
      tmpDir = undefined;
    }
  });

  it('returns null when no env var and no credentials file', () => {
    // Point HOME at an empty temp dir to guarantee no ~/.gemini/credentials.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfauth-'));
    process.env.HOME = tmpDir;
    expect(detectExternalAuth(ENV_VAR)).toBeNull();
  });

  it('returns env-source when the env var is set', () => {
    process.env[ENV_VAR] = 'some-token-value';
    const r = detectExternalAuth(ENV_VAR);
    expect(r).not.toBeNull();
    expect(r?.source).toContain(ENV_VAR);
    expect(r?.source).toMatch(/shell environment/i);
  });

  it('returns env-source even when env var value is whitespace (truthy)', () => {
    process.env[ENV_VAR] = ' ';
    expect(detectExternalAuth(ENV_VAR)).not.toBeNull();
  });

  it('returns gemini-credentials source when ~/.gemini/credentials exists (GEMINI_API_KEY only)', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfauth-'));
    fs.mkdirSync(path.join(tmpDir, '.gemini'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.gemini', 'credentials'), 'fake');
    process.env.HOME = tmpDir;
    const r = detectExternalAuth('GEMINI_API_KEY');
    expect(r).not.toBeNull();
    expect(r?.source).toContain('~/.gemini/credentials');
  });

  it('does NOT consult the credentials file for non-Gemini env names', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfauth-'));
    fs.mkdirSync(path.join(tmpDir, '.gemini'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.gemini', 'credentials'), 'fake');
    process.env.HOME = tmpDir;
    // MCP_TOKEN — credentials file existence shouldn't matter.
    expect(detectExternalAuth('MCP_TOKEN')).toBeNull();
  });

  it('env-source takes precedence over credentials-file fallback', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfauth-'));
    fs.mkdirSync(path.join(tmpDir, '.gemini'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.gemini', 'credentials'), 'fake');
    process.env.HOME = tmpDir;
    process.env.GEMINI_API_KEY = 'env-wins';
    const r = detectExternalAuth('GEMINI_API_KEY');
    expect(r?.source).toMatch(/shell environment/i);
    delete process.env.GEMINI_API_KEY;
  });

  // Added 2026-05-24 (user-reported via agent-prompt 8db1893f) — the
  // pre-fix detect only checked ~/.gemini/credentials, but the help
  // message told users to run `gcloud auth application-default login`
  // which writes to ~/.config/gcloud/. Users following the help text
  // ended up at the "no API key found" error anyway.

  it('returns gcloud-ADC source when ~/.config/gcloud/application_default_credentials.json exists', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfauth-'));
    fs.mkdirSync(path.join(tmpDir, '.config', 'gcloud'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.config', 'gcloud', 'application_default_credentials.json'),
      '{}',
    );
    process.env.HOME = tmpDir;
    const r = detectExternalAuth('GEMINI_API_KEY');
    expect(r).not.toBeNull();
    expect(r?.source).toMatch(/application_default_credentials\.json/);
  });

  it('returns gcloud-legacy source when ~/.config/gcloud/legacy_credentials/ exists', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfauth-'));
    fs.mkdirSync(path.join(tmpDir, '.config', 'gcloud', 'legacy_credentials'), { recursive: true });
    process.env.HOME = tmpDir;
    const r = detectExternalAuth('GEMINI_API_KEY');
    expect(r).not.toBeNull();
    expect(r?.source).toMatch(/legacy_credentials/);
  });

  it('~/.gemini/credentials takes precedence over gcloud ADC (most specific wins)', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfauth-'));
    fs.mkdirSync(path.join(tmpDir, '.gemini'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.gemini', 'credentials'), 'gemini-cli');
    fs.mkdirSync(path.join(tmpDir, '.config', 'gcloud'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.config', 'gcloud', 'application_default_credentials.json'),
      '{}',
    );
    process.env.HOME = tmpDir;
    const r = detectExternalAuth('GEMINI_API_KEY');
    expect(r?.source).toContain('~/.gemini/credentials');
  });
});

describe('validateProviderKey', () => {
  it('rejects empty input as "Key is empty"', () => {
    const r = validateProviderKey('GEMINI_API_KEY', '');
    expect(r).toEqual({ ok: false, reason: 'Key is empty.' });
  });

  it('rejects whitespace-only input as empty (post-trim)', () => {
    const r = validateProviderKey('GEMINI_API_KEY', '    \t\n');
    expect(r.ok).toBe(false);
  });

  it('trims surrounding quote characters before evaluating (paste hygiene)', () => {
    // Pasting from a .env file often brings `"` or `'`. Should be
    // treated as the same key — locks the trim regex.
    const key = 'A'.repeat(40);
    const r = validateProviderKey('GEMINI_API_KEY', `"${key}"`);
    expect(r).toEqual({ ok: true, value: key });
  });

  it('trims surrounding brackets (matches vibeflow-cli paste hygiene)', () => {
    const key = 'B'.repeat(40);
    const r = validateProviderKey('GEMINI_API_KEY', `[${key}]`);
    expect(r).toEqual({ ok: true, value: key });
  });

  it('trims mixed surrounding whitespace + quote chars', () => {
    const key = 'C'.repeat(40);
    const r = validateProviderKey('GEMINI_API_KEY', ` " ${key} " `);
    expect(r).toEqual({ ok: true, value: key });
  });

  it('rejects GEMINI_API_KEY below the 20-char floor (catches "abc123" / typos)', () => {
    const r = validateProviderKey('GEMINI_API_KEY', 'abc123');
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.reason).toMatch(/too short/i); }
  });

  it('accepts GEMINI_API_KEY at exactly 20 chars (floor boundary)', () => {
    const key = 'A'.repeat(20);
    expect(validateProviderKey('GEMINI_API_KEY', key)).toEqual({ ok: true, value: key });
  });

  it('rejects GEMINI_API_KEY at 19 chars (one below floor)', () => {
    expect(validateProviderKey('GEMINI_API_KEY', 'A'.repeat(19)).ok).toBe(false);
  });

  it('rejects MCP_TOKEN below the 16-char floor', () => {
    expect(validateProviderKey('MCP_TOKEN', 'abc').ok).toBe(false);
  });

  it('accepts MCP_TOKEN at exactly 16 chars', () => {
    const key = 'X'.repeat(16);
    expect(validateProviderKey('MCP_TOKEN', key)).toEqual({ ok: true, value: key });
  });

  it('rejects MCP_TOKEN at 15 chars', () => {
    expect(validateProviderKey('MCP_TOKEN', 'X'.repeat(15)).ok).toBe(false);
  });

  it('accepts any non-empty value for unknown env names (no rule = no floor)', () => {
    // Defensive: if a caller passes an unrecognized env name, the
    // function shouldn't reject — just pass it through (trimmed).
    const r = validateProviderKey('NEW_PROVIDER_TOKEN', 'short');
    expect(r).toEqual({ ok: true, value: 'short' });
  });

  it('returns the trimmed value (length-check uses trimmed, not raw)', () => {
    const key = 'D'.repeat(20);
    const r = validateProviderKey('GEMINI_API_KEY', `   "${key}"   `);
    expect(r).toEqual({ ok: true, value: key });
  });

  it('rejects a string that passes the length floor only because of surrounding quotes', () => {
    // A 20-char floor input padded with quotes is < 20 after trim.
    const r = validateProviderKey('GEMINI_API_KEY', '"' + 'A'.repeat(15) + '"');
    expect(r.ok).toBe(false);
  });
});

describe('buildProvidersWithAvailability', () => {
  it('returns the four hardcoded providers in stable order', () => {
    const list = buildProvidersWithAvailability();
    expect(list.map(p => p.value)).toEqual(['claude', 'codex', 'gemini', 'cursor']);
  });

  it('every entry has label / description / value / available', () => {
    for (const p of buildProvidersWithAvailability()) {
      expect(typeof p.label).toBe('string');
      expect(typeof p.description).toBe('string');
      expect(typeof p.value).toBe('string');
      expect(typeof p.available).toBe('boolean');
    }
  });

  it('appends `not installed` tag to description when binary is absent', () => {
    // We can't force a specific provider's binary to be missing without
    // controlling PATH. But for the providers that aren't normally
    // installed on every CI machine (codex / cursor), AT LEAST ONE
    // should be marked unavailable on a typical dev box. Lock the
    // tagging mechanism by asserting either every entry that's
    // unavailable shows the tag, OR every entry that's available
    // doesn't.
    for (const p of buildProvidersWithAvailability()) {
      if (p.available) {
        expect(p.description).not.toMatch(/not installed/);
      } else {
        expect(p.description).toMatch(/not installed/);
      }
    }
  });
});

/**
 * Tests for the launch-guard wrapper added in #3195.
 *
 * Regression target: the Agent Fleet play button invoked `launchSession` /
 * `openCli` without `await`/`.catch`, so an un-try/caught throw inside the
 * wizard became an unhandled promise rejection — the session silently never
 * started ("pressed play, nothing happened" in a demo). `runLaunchGuarded`
 * must catch every failure mode and route it to one actionable message.
 *
 * No mocks: the error reporter is a real closure that records calls; actions
 * are real async functions that succeed / throw / reject.
 */
describe('runLaunchGuarded', () => {
  it('runs the action and reports nothing on success (returns null)', async () => {
    const reported: string[] = [];
    let ran = false;
    const result = await runLaunchGuarded(
      'Launch Session',
      async () => { ran = true; },
      msg => reported.push(msg),
    );
    expect(ran).toBe(true);
    expect(result).toBeNull();
    expect(reported).toEqual([]);
  });

  it('catches a thrown Error, reports one actionable message, and returns it (never re-throws)', async () => {
    const reported: string[] = [];
    const boom = new Error('git not found');
    const result = await runLaunchGuarded(
      'Launch Session',
      async () => { throw boom; },
      msg => reported.push(msg),
    );
    expect(result).toBe(boom);
    expect(reported).toEqual(['VibeFlow: Launch Session failed — git not found']);
  });

  it('wraps a non-Error throw (string) into an Error and still reports', async () => {
    const reported: string[] = [];
    const result = await runLaunchGuarded(
      'Open CLI',
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      async () => { throw 'kaboom'; },
      msg => reported.push(msg),
    );
    expect(result).toBeInstanceOf(Error);
    expect(result?.message).toBe('kaboom');
    expect(reported).toEqual(['VibeFlow: Open CLI failed — kaboom']);
  });

  it('handles a rejected promise identically to a synchronous throw', async () => {
    const reported: string[] = [];
    const result = await runLaunchGuarded(
      'Launch Session',
      () => Promise.reject(new Error('boom')),
      msg => reported.push(msg),
    );
    expect(result?.message).toBe('boom');
    expect(reported).toHaveLength(1);
  });

  it('reports exactly once per failure (no duplicate toasts)', async () => {
    const reported: string[] = [];
    await runLaunchGuarded(
      'Launch Session',
      async () => { throw new Error('e'); },
      msg => reported.push(msg),
    );
    expect(reported).toHaveLength(1);
  });

  it('embeds the label so the user can tell which action failed', async () => {
    const reported: string[] = [];
    await runLaunchGuarded('Open CLI', async () => { throw new Error('x'); }, msg => reported.push(msg));
    expect(reported[0]).toContain('Open CLI');
  });
});

/**
 * `findActiveSession` is the pure "is this persona registered?" predicate
 * shared by both launch watchdogs (chat-first panel-open + the #3196
 * default-path registration warning). Real arrays, no mocks — exactly the
 * decision logic the watchdogs branch on.
 */
describe('findActiveSession', () => {
  const mk = (over: Partial<VibeFlowSession>): VibeFlowSession => ({
    id: 1,
    session_id: 'session-x',
    project_id: 7,
    working_directory: '/w',
    git_branch: 'main',
    agent_type: 'claude',
    agent_model: 'claude-opus-4-8',
    persona_key: 'developer',
    created_at: '2026-06-26T00:00:00Z',
    active: true,
    ...over,
  });

  it('returns the session matching persona + branch + active', () => {
    const sessions = [
      mk({ session_id: 's-dev', persona_key: 'developer', git_branch: 'main' }),
      mk({ session_id: 's-arch', persona_key: 'architect', git_branch: 'main' }),
    ];
    expect(findActiveSession(sessions, 'developer', 'main')?.session_id).toBe('s-dev');
  });

  it('does not match when the branch differs (per-branch isolation)', () => {
    const sessions = [mk({ persona_key: 'developer', git_branch: 'feature-x' })];
    expect(findActiveSession(sessions, 'developer', 'main')).toBeUndefined();
  });

  it('does not match an inactive (un-registered / dead) session', () => {
    const sessions = [mk({ persona_key: 'developer', git_branch: 'main', active: false })];
    expect(findActiveSession(sessions, 'developer', 'main')).toBeUndefined();
  });

  it('returns undefined on an empty list (the never-registered case the warning fires on)', () => {
    expect(findActiveSession([], 'developer', 'main')).toBeUndefined();
  });

  it('requires both persona AND branch to match', () => {
    const sessions = [mk({ persona_key: 'architect', git_branch: 'main' })];
    expect(findActiveSession(sessions, 'developer', 'main')).toBeUndefined();
  });
});
