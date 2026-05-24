// Mocha bootstrap. @vscode/test-electron looks for an exported `run()`
// function and awaits it inside the Electron process.

import * as path from 'path';
import { glob } from 'glob';
import Mocha from 'mocha';

export async function run(): Promise<void> {
  const mocha = new Mocha({
    // TDD globals (suite/test/setup/teardown) — the canonical UI for
    // @vscode/test-electron suites. Don't switch to BDD without renaming
    // every test file's describe/it accordingly.
    ui: 'tdd',
    color: true,
    timeout: 30_000,
  });

  const testsRoot = __dirname;
  const files = await glob('**/*.test.js', { cwd: testsRoot });

  for (const f of files) {
    mocha.addFile(path.resolve(testsRoot, f));
  }

  await new Promise<void>((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) {
          reject(new Error(`${failures} test(s) failed`));
        } else {
          resolve();
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}
