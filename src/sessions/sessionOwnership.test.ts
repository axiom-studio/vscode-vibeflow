import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionOwnershipTracker, isSafePersonaKey } from './sessionOwnership.js';
import type { VibeFlowSession } from '../api/types.js';

let dirs: string[] = [];

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-ownership-'));
  dirs.push(dir);
  return dir;
}

function writeSidecar(dir: string, persona: string, sessionId: string): void {
  fs.writeFileSync(path.join(dir, `.vibeflow-session-${persona}`), `${sessionId}\n`);
}

function session(overrides: Partial<VibeFlowSession>): VibeFlowSession {
  return {
    id: 1,
    session_id: 'session-20260703-000000-aaaaaaaa',
    project_id: 28,
    working_directory: '/nonexistent',
    git_branch: 'main',
    agent_type: 'claude',
    agent_model: 'claude-fable-5',
    persona_key: 'developer',
    created_at: '2026-07-03T00:00:00Z',
    active: true,
    ...overrides,
  };
}

beforeEach(() => { dirs = []; });
afterEach(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('SessionOwnershipTracker', () => {
  it('owns a session whose sidecar in its working_directory matches its id', async () => {
    const workDir = makeDir();
    writeSidecar(workDir, 'developer', 'session-20260703-000000-aaaaaaaa');
    const tracker = new SessionOwnershipTracker(undefined);

    await tracker.refresh([session({ working_directory: workDir })]);

    expect(tracker.isOwned('session-20260703-000000-aaaaaaaa')).toBe(true);
  });

  it('rejects a session whose sidecar carries a different id (another user, same path shape)', async () => {
    const workDir = makeDir();
    writeSidecar(workDir, 'developer', 'session-20260703-000000-bbbbbbbb');
    const tracker = new SessionOwnershipTracker(undefined);

    await tracker.refresh([session({ working_directory: workDir })]);

    expect(tracker.isOwned('session-20260703-000000-aaaaaaaa')).toBe(false);
  });

  it('rejects sessions with no local sidecar (remote machine) and handles missing dirs', async () => {
    const tracker = new SessionOwnershipTracker(undefined);

    await tracker.refresh([
      session({ working_directory: '/no/such/dir/on/this/machine' }),
      session({ session_id: 'session-x', working_directory: makeDir() }), // dir exists, no sidecar
    ]);

    expect(tracker.isOwned('session-20260703-000000-aaaaaaaa')).toBe(false);
    expect(tracker.isOwned('session-x')).toBe(false);
  });

  it('matches the sidecar by persona_key, not any sidecar in the directory', async () => {
    const workDir = makeDir();
    writeSidecar(workDir, 'architect', 'session-20260703-000000-aaaaaaaa');
    const tracker = new SessionOwnershipTracker(undefined);

    // developer session, but only an architect sidecar exists at its cwd
    await tracker.refresh([session({ working_directory: workDir })]);

    expect(tracker.isOwned('session-20260703-000000-aaaaaaaa')).toBe(false);
  });

  it('picks up workspace-root sidecars even when the session is not in the active list', async () => {
    const root = makeDir();
    writeSidecar(root, 'principal_engineer', 'session-20260703-111111-cccccccc');
    const tracker = new SessionOwnershipTracker(root);

    // Dead session: pending prompt exists but /sessions/active no longer lists it.
    await tracker.refresh([]);

    expect(tracker.isOwned('session-20260703-111111-cccccccc')).toBe(true);
  });

  it('ignores malformed root sidecars', async () => {
    const root = makeDir();
    fs.writeFileSync(path.join(root, '.vibeflow-session-developer'), 'not-a-session-id\n');
    const tracker = new SessionOwnershipTracker(root);

    await tracker.refresh([]);

    expect(tracker.isOwned('not-a-session-id')).toBe(false);
  });

  it('keeps ownership after the sidecar disappears (once owned, always owned)', async () => {
    const workDir = makeDir();
    writeSidecar(workDir, 'developer', 'session-20260703-000000-aaaaaaaa');
    const tracker = new SessionOwnershipTracker(undefined);
    const s = session({ working_directory: workDir });

    await tracker.refresh([s]);
    fs.rmSync(path.join(workDir, '.vibeflow-session-developer'));
    await tracker.refresh([s]);

    expect(tracker.isOwned('session-20260703-000000-aaaaaaaa')).toBe(true);
  });

  it('owns worktree sessions via their own working_directory, independent of the workspace root', async () => {
    const root = makeDir();
    const worktree = makeDir();
    writeSidecar(worktree, 'developer', 'session-20260703-222222-dddddddd');
    const tracker = new SessionOwnershipTracker(root);

    await tracker.refresh([
      session({ session_id: 'session-20260703-222222-dddddddd', working_directory: worktree }),
    ]);

    expect(tracker.isOwned('session-20260703-222222-dddddddd')).toBe(true);
  });

  it('treats undefined and unknown ids as not owned', () => {
    const tracker = new SessionOwnershipTracker(undefined);
    expect(tracker.isOwned(undefined)).toBe(false);
    expect(tracker.isOwned('session-unknown')).toBe(false);
  });

  // #3383 — path traversal via cross-user persona_key / working_directory.
  it('rejects a traversal persona_key and never reads outside working_directory (#3383)', async () => {
    const root = makeDir();
    const workDir = path.join(root, 'sub');
    fs.mkdirSync(workDir);
    // Plant a would-be-matching sidecar at the TRAVERSED target: from workDir,
    // `.vibeflow-session-` + `x/../../evil` normalizes to `${root}/evil`.
    fs.writeFileSync(path.join(root, 'evil'), 'session-20260704-000000-eeeeeeee');
    const tracker = new SessionOwnershipTracker(undefined);

    await tracker.refresh([session({
      session_id: 'session-20260704-000000-eeeeeeee',
      working_directory: workDir,
      persona_key: 'x/../../evil',
    })]);

    // Without the fix this session would be marked owned by reading ${root}/evil.
    expect(tracker.isOwned('session-20260704-000000-eeeeeeee')).toBe(false);
  });

  it('skips a non-regular file at the sidecar path (blocking-special-file DoS guard, #3383)', async () => {
    const workDir = makeDir();
    // A directory where the sidecar would be: stat().isFile() is false, so the
    // read is skipped (stands in for a FIFO / /dev/zero that would hang readFile).
    fs.mkdirSync(path.join(workDir, '.vibeflow-session-developer'));
    const tracker = new SessionOwnershipTracker(undefined);

    await tracker.refresh([session({ working_directory: workDir })]);

    expect(tracker.isOwned('session-20260703-000000-aaaaaaaa')).toBe(false);
  });
});

describe('isSafePersonaKey (#3383)', () => {
  it('accepts single lowercase tokens (the real persona keys)', () => {
    for (const key of ['developer', 'architect', 'principal_engineer', 'security_lead', 'qa_lead', 'x', 'a1']) {
      expect(isSafePersonaKey(key)).toBe(true);
    }
  });

  it('rejects anything with a separator, traversal, dot, space, dash, uppercase, or empty', () => {
    for (const key of ['', 'x/../zero', 'a/b', 'a\\b', '..', '.', 'a.b', 'Dev', 'x/../../evil', 'a b', 'a-b']) {
      expect(isSafePersonaKey(key)).toBe(false);
    }
  });
});
