import { describe, it, expect } from 'vitest';
import { buildCliLaunchCommand, parseCliVersion } from './cliCommands.js';

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
