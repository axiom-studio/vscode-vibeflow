import { describe, it, expect } from 'vitest';
import { buildCliLaunchArgs, buildCliLaunchCommand, hasCliLaunchOptions, parseCliVersion } from './cliCommands.js';

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
