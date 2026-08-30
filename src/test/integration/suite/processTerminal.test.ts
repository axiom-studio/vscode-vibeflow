// Process-terminal spawn round-trip (#4995).
//
// The unit cohort proves `buildProcessTerminalOptions` produces the right
// TerminalOptions shape. This suite proves the shape WORKS: a real VS Code
// terminal created via `createProcessTerminal` actually runs the target
// binary as the terminal process and delivers argv + env byte-exact —
// including the hostile characters (quotes, newlines, `$`, backticks,
// `;`) that the old sendText path had to hand-escape for a shell.
//
// The "agent binary" is the real `node` from PATH, resolved by the
// helper itself the same way agent binaries are (bare name → which) —
// so the test also exercises the resolution path for real. (Not
// Electron-as-Node: VS Code sanitizes ELECTRON_RUN_AS_NODE out of
// terminal environments, so process.execPath can't be repurposed.) The
// child writes its received argv + selected env to a temp file; the
// test polls for it.
//
// What this deliberately does NOT cover: the env-collection relaunch
// half of #4995 (mechanism 2). Driving that requires an
// ExtensionContext.environmentVariableCollection from a second extension
// (the Python extension in the field); the harness runs with
// --disable-extensions. That verification is the QA gate on the issue.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { createProcessTerminal } from '../../../sessions/terminalLaunch.js';
import { resolveBinaryPath } from '../../../utils/whichBinary.js';

/** Poll for `file` until `deadline`; on timeout, fail with pty diagnostics. */
async function waitForFile(file: string, terminal: vscode.Terminal, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) {
      const pid = await Promise.race([
        terminal.processId,
        new Promise<undefined>(r => setTimeout(() => r(undefined), 1000)),
      ]);
      assert.fail(
        `child never wrote ${file} — spawn failed ` +
        `(pid=${String(pid)}, exit=${JSON.stringify(terminal.exitStatus)}, ` +
        `node@PATH=${String(resolveBinaryPath('node'))})`,
      );
    }
    await new Promise(r => setTimeout(r, 200));
  }
  // Tiny settle so the write is complete before we read.
  await new Promise(r => setTimeout(r, 200));
}

const HOSTILE_PROMPT = [
  "Initialize a vibeflow session with 'single' and \"double\" quotes,",
  'a newline, $HOME, `whoami`, ; rm -rf /tmp/nope, and a trailing space ',
].join('\n');

suite('createProcessTerminal spawn round-trip (#4995)', () => {
  test('control: spawns an absolute-path binary as the terminal process', async function () {
    this.timeout(25_000);
    const outFile = path.join(
      await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vibeflow-4995-ctl-')),
      'touched',
    );
    const terminal = createProcessTerminal({
      name: 'VibeFlow: #4995 control',
      binary: '/usr/bin/touch',
      args: [outFile],
      hideFromUser: true,
    });
    try {
      await waitForFile(outFile, terminal, 15_000);
    } finally {
      terminal.dispose();
      await fs.promises.rm(path.dirname(outFile), { recursive: true, force: true });
    }
  });

  test('delivers argv and env to the spawned process byte-exact, no shell interpretation', async function () {
    this.timeout(25_000);

    const outFile = path.join(
      await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vibeflow-4995-')),
      'child.json',
    );
    // The child echoes back what it received. `node -e <script> a b` puts
    // the trailing args at process.argv[1..].
    const script =
      'require("fs").writeFileSync(process.env.VIBEFLOW_TEST_OUT, ' +
      'JSON.stringify({ argv: process.argv.slice(1), ' +
      'probe: process.env.VIBEFLOW_TEST_PROBE, term: process.env.TERM }))';

    const terminal = createProcessTerminal({
      name: 'VibeFlow: #4995 round-trip',
      binary: 'node',
      // No dash-prefixed extras: node parses post-`-e` dash args as its own
      // options (exit 9). Agent binaries own their argv; what we prove here is
      // byte-exact delivery, which the hostile prompt covers.
      args: ['-e', script, 'positional-arg', HOSTILE_PROMPT],
      hideFromUser: true,
      env: {
        VIBEFLOW_TEST_OUT: outFile,
        VIBEFLOW_TEST_PROBE: 'reached-the-child',
      },
    });

    try {
      await waitForFile(outFile, terminal, 20_000);
      const received = JSON.parse(await fs.promises.readFile(outFile, 'utf8')) as {
        argv: string[];
        probe?: string;
        term?: string;
      };

      // Argv arrived exactly as passed: flag intact, hostile prompt
      // byte-identical — quotes unstripped, newline preserved, $HOME and
      // backticks NOT expanded, `;` NOT treated as a separator. Under the
      // old sendText path a shell parsed all of these.
      assert.deepStrictEqual(received.argv, ['positional-arg', HOSTILE_PROMPT]);
      // opts.env reached the child (strict-env merge works end to end).
      assert.strictEqual(received.probe, 'reached-the-child');
      // TERM present despite no shell — the helper backfills it.
      assert.ok(received.term, 'TERM missing in child env');
    } finally {
      terminal.dispose();
      await fs.promises.rm(path.dirname(outFile), { recursive: true, force: true });
    }
  });
});
