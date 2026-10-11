import { describe, expect, it } from 'vitest';
import { cliNeedsWsl } from './cliPlatform.js';

describe('cliNeedsWsl', () => {
  it('blocks a local Windows window: the CLI needs tmux', () => {
    expect(cliNeedsWsl('win32', undefined)).toBe(true);
  });

  it('allows Windows when the window is remote (WSL runs the CLI on Linux)', () => {
    expect(cliNeedsWsl('win32', 'wsl')).toBe(false);
  });

  it('allows macOS and Linux, local or remote', () => {
    expect(cliNeedsWsl('darwin', undefined)).toBe(false);
    expect(cliNeedsWsl('linux', undefined)).toBe(false);
    expect(cliNeedsWsl('linux', 'ssh-remote')).toBe(false);
  });
});
