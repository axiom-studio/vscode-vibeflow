// Activation suite — the minimum invariants that B2 (#1975 extension.ts
// activate decomposition) must preserve. If any of these break after the
// per-module `register(ctx, services)` refactor, the activate() order
// regressed.

import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'AxiomStudio.vscode-vibeflow';

const EXPECTED_COMMANDS = [
  'vibeflow.setup',
  'vibeflow.login',
  'vibeflow.logout',
  'vibeflow.launchSession',
  'vibeflow.createWorkItem',
  'vibeflow.createDocument',
  'vibeflow.viewSessions',
  'vibeflow.respondToPrompt',
  'vibeflow.openDashboard',
  'vibeflow.openKanban',
  'vibeflow.openCompliance',
  'vibeflow.installCli',
  'vibeflow.pickProject',
  'vibeflow.reportIssue',
  'vibeflow.refresh',
  'vibeflow.openSettings',
];

const EXPECTED_VIEWS = [
  'vibeflow.agentFleet',
  'vibeflow.workItems',
  'vibeflow.browse',
  'vibeflow.pullRequests',
  'vibeflow.documents',
  'vibeflow.activityFeed',
];

suite('Activation', function () {
  // ~60s for cold extension activation in headless Electron — the
  // extension itself activates in <1s once the host is up, but the
  // first-run host download + boot can easily eat 20-30s on a clean
  // machine. Generous to keep CI noise down.
  this.timeout(60_000);

  suite('extension lifecycle', () => {
    test('extension is present and activates', async () => {
      const ext = vscode.extensions.getExtension(EXTENSION_ID);
      assert.ok(ext, `Extension ${EXTENSION_ID} is not present`);
      await ext!.activate();
      assert.strictEqual(ext!.isActive, true, 'Extension did not activate');
    });
  });

  suite('contributed commands', () => {
    test('every advertised vibeflow.* command is registered', async () => {
      // Ensure activation has fired so command registrations have landed.
      const ext = vscode.extensions.getExtension(EXTENSION_ID);
      await ext?.activate();

      const all = await vscode.commands.getCommands(true);
      const vibeflow = new Set(all.filter((c) => c.startsWith('vibeflow.')));
      const missing = EXPECTED_COMMANDS.filter((c) => !vibeflow.has(c));
      assert.deepStrictEqual(
        missing,
        [],
        `Missing commands: ${JSON.stringify(missing)}`,
      );
    });
  });

  suite('contributed views', () => {
    test('every advertised view is reachable via setActiveTab or focus command', async () => {
      // VSCode doesn't expose a public "list registered views" API in the
      // extension host; instead we assert by trying to focus each view's
      // VSCode-generated focus command (`<viewId>.focus`). Throws if the
      // view wasn't registered.
      const ext = vscode.extensions.getExtension(EXTENSION_ID);
      await ext?.activate();

      const failures: string[] = [];
      for (const viewId of EXPECTED_VIEWS) {
        try {
          await vscode.commands.executeCommand(`${viewId}.focus`);
        } catch (err) {
          failures.push(`${viewId}: ${(err as Error).message}`);
        }
      }
      assert.deepStrictEqual(
        failures,
        [],
        `View focus failures: ${JSON.stringify(failures)}`,
      );
    });
  });
});

