import { describe, it, expect } from 'vitest';
import { parseCliVersion } from './cliCommands.js';

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
