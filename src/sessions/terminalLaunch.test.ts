import { describe, it, expect } from 'vitest';
import { buildProcessTerminalOptions, type ProcessTerminalOptions } from './terminalLaunch.js';

/**
 * Guards for the process-owned terminal builder (issue #4995).
 *
 * These pin the properties that make the fix a fix: the binary is the
 * terminal process (shellPath), args are argv (never a shell string),
 * and strictEnv opts the terminal out of environment contributions —
 * which is what stops the Python extension's env-collection change from
 * relaunching (killing) a just-started agent.
 */

const base: ProcessTerminalOptions = {
  name: 'VibeFlow: Test',
  binary: 'claude',
  args: ['--dangerously-skip-permissions'],
};

const resolveTo = (p: string | undefined) => (_name: string) => p;

describe('buildProcessTerminalOptions — posix', () => {
  it('spawns the resolved binary as the terminal process with argv intact', () => {
    const o = buildProcessTerminalOptions(base, 'darwin', resolveTo('/usr/local/bin/claude'), {});
    expect(o.shellPath).toBe('/usr/local/bin/claude');
    expect(o.shellArgs).toEqual(['--dangerously-skip-permissions']);
    expect(o.strictEnv).toBe(true);
  });

  it('passes hostile prompt text through as a literal argv element — no escaping, no mangling', () => {
    // The exact class of input the old sendText path had to hand-escape:
    // quotes, newlines, $-expansion, backticks, command separators.
    const prompt = `Initialize 'quoted' "double" \n $HOME \`whoami\`; rm -rf /`;
    const o = buildProcessTerminalOptions(
      { ...base, args: [...base.args, prompt] },
      'linux', resolveTo('/usr/bin/claude'), {},
    );
    expect(o.shellArgs).toEqual(['--dangerously-skip-permissions', prompt]);
  });

  it('uses an absolute binary path verbatim without consulting the resolver', () => {
    const o = buildProcessTerminalOptions(
      { ...base, binary: '/opt/bin/vibeflow' },
      'linux',
      () => { throw new Error('resolver must not be called for absolute paths'); },
      {},
    );
    expect(o.shellPath).toBe('/opt/bin/vibeflow');
  });

  it('falls back to the bare name when resolution fails (VS Code surfaces the launch failure)', () => {
    const o = buildProcessTerminalOptions(base, 'linux', resolveTo(undefined), {});
    expect(o.shellPath).toBe('claude');
  });
});

describe('buildProcessTerminalOptions — windows', () => {
  it('routes .cmd shims through ComSpec /c (CreateProcess cannot exec batch files)', () => {
    const o = buildProcessTerminalOptions(
      base, 'win32',
      resolveTo('C:\\Users\\m\\AppData\\Roaming\\npm\\claude.CMD'),
      { ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe' },
    );
    expect(o.shellPath).toBe('C:\\WINDOWS\\system32\\cmd.exe');
    expect(o.shellArgs).toEqual([
      '/c',
      'C:\\Users\\m\\AppData\\Roaming\\npm\\claude.CMD',
      '--dangerously-skip-permissions',
    ]);
  });

  it('defaults to cmd.exe when ComSpec is absent from the environment', () => {
    const o = buildProcessTerminalOptions(base, 'win32', resolveTo('C:\\x\\y.bat'), {});
    expect(o.shellPath).toBe('cmd.exe');
  });

  it('spawns .exe binaries directly — no interpreter wrap', () => {
    const o = buildProcessTerminalOptions(base, 'win32', resolveTo('C:\\x\\claude.exe'), {});
    expect(o.shellPath).toBe('C:\\x\\claude.exe');
    expect(o.shellArgs).toEqual(['--dangerously-skip-permissions']);
  });
});

describe('buildProcessTerminalOptions — environment', () => {
  it('merges the process env under the caller env, dropping undefined entries', () => {
    const o = buildProcessTerminalOptions(
      { ...base, env: { VIBEFLOW_PERSONA: 'developer', PATH: '/override' } },
      'linux', resolveTo('/usr/bin/claude'),
      { PATH: '/usr/bin', HOME: '/home/m', BROKEN: undefined },
    );
    const env = o.env as Record<string, string>;
    expect(env.HOME).toBe('/home/m');           // inherited
    expect(env.PATH).toBe('/override');          // caller wins
    expect(env.VIBEFLOW_PERSONA).toBe('developer');
    expect('BROKEN' in env).toBe(false);         // undefined filtered
  });

  it('backfills TERM/COLORTERM only when the base env lacks them', () => {
    const bare = buildProcessTerminalOptions(base, 'linux', resolveTo('/x'), {});
    const bareEnv = bare.env as Record<string, string>;
    expect(bareEnv.TERM).toBe('xterm-256color');
    expect(bareEnv.COLORTERM).toBe('truecolor');

    const inherited = buildProcessTerminalOptions(
      base, 'linux', resolveTo('/x'), { TERM: 'screen-256color' },
    );
    expect((inherited.env as Record<string, string>).TERM).toBe('screen-256color');
  });

  it('always sets strictEnv so extension env-collections cannot mark the terminal stale', () => {
    // This flag is the mechanism-(2) half of #4995: a strict-env terminal
    // takes no environment contributions, so a contribution change has
    // nothing to apply and no reason to relaunch the process.
    const o = buildProcessTerminalOptions(base, 'linux', resolveTo('/x'), {});
    expect(o.strictEnv).toBe(true);
  });
});

describe('buildProcessTerminalOptions — passthrough', () => {
  it('forwards name/cwd/hideFromUser/location untouched', () => {
    const o = buildProcessTerminalOptions(
      { ...base, cwd: '/work', hideFromUser: true, location: 1 as never },
      'linux', resolveTo('/x'), {},
    );
    expect(o.name).toBe('VibeFlow: Test');
    expect(o.cwd).toBe('/work');
    expect(o.hideFromUser).toBe(true);
    expect(o.location).toBe(1);
  });
});
