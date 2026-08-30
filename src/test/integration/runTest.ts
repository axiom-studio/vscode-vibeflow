// Integration test runner. Launches a headless VS Code Electron instance,
// loads this extension from `extensionDevelopmentPath`, and runs the Mocha
// suite at `extensionTestsPath`.
//
// Why @vscode/test-electron instead of vitest:
//   vitest is great for pure-function modules but cannot host the `vscode`
//   namespace at runtime — it requires a real Electron process. The
//   `vscode` module is provided by the host, not npm. The unit cohort
//   (P5-A) stubs `vscode` via `vitest.config.ts` `resolve.alias`, but
//   tests that need to call real VSCode APIs (createWebviewPanel,
//   registerCommand, etc.) must run inside the host process.
//
// Headless mode: passes `--headless --disable-gpu --disable-extensions
// --disable-workspace-trust` so this can run in CI / SSH sessions without
// a display server. The downloaded VS Code build is cached in
// `~/.vscode-test/`.

import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  try {
    // __dirname when compiled: out/test/test/integration/
    // → 4 levels up = repo root (where package.json lives).
    const extensionDevelopmentPath = path.resolve(__dirname, '..', '..', '..', '..');
    const extensionTestsPath = path.resolve(__dirname, 'suite', 'index');

    await runTests({
      // Default: latest stable. VSCODE_TEST_VERSION pins a specific build
      // (useful in CI, or to bisect a VS Code regression) — e.g.
      // `VSCODE_TEST_VERSION=1.121.0 yarn test:integration`. Historical
      // note (#4996): this knob started as the workaround for
      // @vscode/test-electron 2.5.x spawning the `Electron` binary that
      // VS Code 1.135 removed on macOS; the 3.x bump fixed that.
      version: process.env.VSCODE_TEST_VERSION,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        '--disable-extensions',
        '--disable-workspace-trust',
        '--disable-gpu',
      ],
    });
  } catch (err) {
    console.error('Integration tests failed:', err);
    process.exit(1);
  }
}

void main();
