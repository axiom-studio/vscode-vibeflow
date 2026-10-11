// Project-switch tab close (#4031).
//
// The unit cohort pins `isProjectScopedWebviewTabInput` against hand-written
// tab-input shapes. This suite proves those shapes match what VS Code really
// produces: with a project-scoped webview, the Settings webview, a code
// editor and an editor-area process terminal (the VibeFlow CLI opens exactly
// like this) all open, `closeOldProjectTabs()` must close ONLY the
// project-scoped webview. The switch no longer asks first, so this is the
// guard that it can never take the CLI or unsaved code with it.

import * as assert from 'assert';
import * as vscode from 'vscode';
import { closeOldProjectTabs } from '../../../commands/projectCommands.js';
import { createProcessTerminal } from '../../../sessions/terminalLaunch.js';

function openTabLabels(): string[] {
  return vscode.window.tabGroups.all.flatMap(group => group.tabs.map(tab => tab.label));
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${what}; open tabs: ${JSON.stringify(openTabLabels())}`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

suite('Project switch closes only project-scoped VibeFlow panels (#4031)', function () {
  this.timeout(60_000);

  test('closes the Kanban webview; keeps Settings, the code editor and the CLI terminal', async () => {
    const kanban = vscode.window.createWebviewPanel('vibeflow.kanban', 'VF Kanban (test)', vscode.ViewColumn.One, {});
    const settings = vscode.window.createWebviewPanel('vibeflow.settings', 'VF Settings (test)', vscode.ViewColumn.One, {});
    const doc = await vscode.workspace.openTextDocument({ content: 'unsaved work', language: 'plaintext' });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
    const cli = createProcessTerminal({
      name: 'VF CLI (test)',
      binary: 'node',
      args: ['-e', 'setInterval(() => {}, 1000)'],
      location: vscode.TerminalLocation.Editor,
    });

    try {
      await waitFor(() => openTabLabels().includes('VF CLI (test)'), 'the CLI terminal tab');
      let kanbanDisposed = false;
      kanban.onDidDispose(() => { kanbanDisposed = true; });

      await closeOldProjectTabs();

      await waitFor(() => kanbanDisposed, 'the Kanban panel to close');
      const labels = openTabLabels();
      assert.ok(!labels.includes('VF Kanban (test)'), `Kanban still open: ${JSON.stringify(labels)}`);
      assert.ok(labels.includes('VF Settings (test)'), `Settings was closed: ${JSON.stringify(labels)}`);
      assert.ok(labels.includes('VF CLI (test)'), `CLI terminal was closed: ${JSON.stringify(labels)}`);
      assert.ok(
        vscode.window.tabGroups.all.some(g => g.tabs.some(t => t.input instanceof vscode.TabInputText)),
        `code editor was closed: ${JSON.stringify(labels)}`,
      );
      assert.strictEqual(cli.exitStatus, undefined, 'CLI terminal process was terminated');
    } finally {
      settings.dispose();
      cli.dispose();
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  });
});
