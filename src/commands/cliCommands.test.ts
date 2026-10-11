import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { buildCliLaunchArgs, buildCliLaunchCommand, cliLaunchCwd, cliPidLockPath, cliRootDir, cliTmuxSocket, hasCliLaunchOptions, parseCliVersion } from './cliCommands.js';

// Mirrors vibeflow-cli PIDLockPath(): <root>/vibeflow.pid with
// --root > VIBEFLOW_ROOT > ~/.vibeflow-cli (issue #5742).
describe('cliPidLockPath', () => {
  const home = path.resolve('/home/u');
  const cwd = path.resolve('/work/repo');

  it('defaults to ~/.vibeflow-cli when no root is set', () => {
    expect(cliPidLockPath(undefined, cwd, {}, home)).toBe(path.join(home, '.vibeflow-cli', 'vibeflow.pid'));
  });

  it('treats a blank root path as unset', () => {
    expect(cliPidLockPath('   ', cwd, {}, home)).toBe(path.join(home, '.vibeflow-cli', 'vibeflow.pid'));
  });

  it('uses VIBEFLOW_ROOT when no root path is configured', () => {
    const envRoot = path.resolve('/srv/vf');
    expect(cliPidLockPath('', cwd, { VIBEFLOW_ROOT: envRoot }, home)).toBe(path.join(envRoot, 'vibeflow.pid'));
  });

  it('prefers the configured root path over VIBEFLOW_ROOT', () => {
    const root = path.resolve('/opt/vf-root');
    expect(cliPidLockPath(root, cwd, { VIBEFLOW_ROOT: path.resolve('/srv/vf') }, home)).toBe(path.join(root, 'vibeflow.pid'));
  });

  it('resolves a relative root against the launch cwd', () => {
    expect(cliPidLockPath('.vf', cwd, {}, home)).toBe(path.join(cwd, '.vf', 'vibeflow.pid'));
  });
  // PR #2 finding: in a window with no folder the terminal starts in $HOME,
  // so a relative root must resolve there, not in the extension host's cwd.
  it('resolves a relative root in an empty window to the terminal home dir', () => {
    const launchCwd = cliLaunchCwd(undefined, home);
    expect(cliPidLockPath('.vibeflow-cli', launchCwd, {}, home)).toBe(path.join(home, '.vibeflow-cli', 'vibeflow.pid'));
  });
});

// #4033: config.yaml and the PID lock live in the same root.
describe('cliRootDir', () => {
  it('is the directory the PID lock lives in', () => {
    const home = path.resolve('/home/u');
    const cwd = path.resolve('/work/repo');
    for (const root of [undefined, '.vf', path.resolve('/opt/vf')]) {
      expect(path.join(cliRootDir(root, cwd, {}, home), 'vibeflow.pid')).toBe(cliPidLockPath(root, cwd, {}, home));
    }
  });
});

describe('cliLaunchCwd', () => {
  const home = path.resolve('/home/u');
  const ws = path.resolve('/work/repo');

  it('uses the workspace root when it exists', () => {
    expect(cliLaunchCwd(ws, home, () => true)).toBe(ws);
  });

  it('falls back to home when there is no workspace folder', () => {
    expect(cliLaunchCwd(undefined, home, () => true)).toBe(home);
  });

  it('falls back to home when the workspace root no longer exists', () => {
    expect(cliLaunchCwd(ws, home, () => false)).toBe(home);
  });
});

describe('parseCliVersion', () => {
  it('extracts the version from the first line of `vibeflow version`', () => {
    const out = 'vibeflow 1.0.10\n  commit: abc1234\n  built:  2026-06-26\n';
    expect(parseCliVersion(out)).toBe('1.0.10');
  });

  it('preserves a v-prefixed version token', () => {
    expect(parseCliVersion('vibeflow v1.2.3\n')).toBe('v1.2.3');
  });

  it('handles the dev build string', () => {
    expect(parseCliVersion('vibeflow dev\n  commit: none\n')).toBe('dev');
  });

  it('returns undefined for unrecognized or empty output', () => {
    expect(parseCliVersion('command not found')).toBeUndefined();
    expect(parseCliVersion('')).toBeUndefined();
  });
});

describe('buildCliLaunchArgs', () => {
  // Since #4995 this argv IS what executes — the TUI binary is spawned as
  // the terminal process; the string form below is display/log only.
  it('emits nothing for blank options and flag pairs for set ones — values verbatim, unquoted', () => {
    expect(buildCliLaunchArgs({ mcpName: ' ', rootPath: '' })).toEqual([]);
    expect(buildCliLaunchArgs({ mcpName: 'team-mcp', rootPath: "/Users/rp/O'Hara Project" }))
      .toEqual(['--mcp', 'team-mcp', '--root', "/Users/rp/O'Hara Project"]);
  });

  it('agrees with buildCliLaunchCommand for hostile values (string derives from argv)', () => {
    const options = { mcpName: 'team;rm', rootPath: "/Users/rp/O'Hara Project" };
    const derived = ['/Users/Foo Bar/bin/vibeflow', ...buildCliLaunchArgs(options)];
    // The shell-quoted display string must be exactly the quoted argv —
    // #3342's "log cannot diverge from execution" invariant, now enforced
    // structurally by derivation.
    expect(buildCliLaunchCommand('/Users/Foo Bar/bin/vibeflow', options, 'darwin'))
      .toBe("'/Users/Foo Bar/bin/vibeflow' --mcp 'team;rm' --root '/Users/rp/O'\\''Hara Project'");
    expect(derived).toEqual(['/Users/Foo Bar/bin/vibeflow', '--mcp', 'team;rm', '--root', "/Users/rp/O'Hara Project"]);
  });
});

describe('buildCliLaunchCommand', () => {
  it('omits optional flags when settings are blank', () => {
    expect(buildCliLaunchCommand('/usr/local/bin/vibeflow', {
      mcpName: ' ',
      rootPath: '',
    }, 'darwin')).toBe('/usr/local/bin/vibeflow');
  });

  it('passes provided MCP name and root path as separate flags', () => {
    expect(buildCliLaunchCommand('/usr/local/bin/vibeflow', {
      mcpName: 'team-mcp',
      rootPath: '/Users/rp/project',
    }, 'darwin')).toBe('/usr/local/bin/vibeflow --mcp team-mcp --root /Users/rp/project');
  });

  it('quotes values that would be unsafe in a shell command', () => {
    expect(buildCliLaunchCommand('/Users/Foo Bar/bin/vibeflow', {
      mcpName: 'team;rm',
      rootPath: "/Users/rp/O'Hara Project",
    }, 'darwin')).toBe("'/Users/Foo Bar/bin/vibeflow' --mcp 'team;rm' --root '/Users/rp/O'\\''Hara Project'");
  });
});

describe('hasCliLaunchOptions', () => {
  it('is false for undefined, empty, and whitespace-only options', () => {
    expect(hasCliLaunchOptions(undefined)).toBe(false);
    expect(hasCliLaunchOptions({})).toBe(false);
    expect(hasCliLaunchOptions({ mcpName: '', rootPath: '' })).toBe(false);
    expect(hasCliLaunchOptions({ mcpName: '  ', rootPath: '\t' })).toBe(false);
  });

  it('is true when either flag would be emitted', () => {
    expect(hasCliLaunchOptions({ mcpName: 'team-mcp' })).toBe(true);
    expect(hasCliLaunchOptions({ rootPath: '/Users/rp/project' })).toBe(true);
    expect(hasCliLaunchOptions({ mcpName: ' ', rootPath: '/x' })).toBe(true);
  });

  it('agrees with buildCliLaunchCommand about when flags appear', () => {
    const none = { mcpName: ' ', rootPath: '' };
    const some = { mcpName: 'team-mcp', rootPath: '' };
    expect(hasCliLaunchOptions(none)).toBe(buildCliLaunchCommand('vibeflow', none, 'darwin') !== 'vibeflow');
    expect(hasCliLaunchOptions(some)).toBe(buildCliLaunchCommand('vibeflow', some, 'darwin') !== 'vibeflow');
  });
});

describe('cliTmuxSocket', () => {
  // vibeflow-cli ResolveTmuxSocket / TmuxSocketName.
  it('uses "vibeflow" for the default root', () => {
    expect(cliTmuxSocket(undefined, undefined, {})).toBe('vibeflow');
  });
  it('derives the socket from the root string for a custom root', () => {
    expect(cliTmuxSocket('/tmp/vf-root', undefined, {})).toBe('vibeflow-2baf4e59');
    expect(cliTmuxSocket(undefined, undefined, { VIBEFLOW_ROOT: '/tmp/vf-root' })).toBe('vibeflow-2baf4e59');
  });
  it('prefers the tmux_socket pinned in the CLI config', () => {
    expect(cliTmuxSocket('/tmp/vf-root', 'pinned', {})).toBe('pinned');
  });
});
