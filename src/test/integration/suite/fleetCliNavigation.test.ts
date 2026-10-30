import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { navigateCli, openCli } from '../../../commands/cliCommands.js';
import { cliControlSocket, requestCliNavigation } from '../../../commands/cliNavigation.js';
import { PollingCoordinator } from '../../../core/PollingCoordinator.js';
import { SessionsTreeProvider } from '../../../views/sessions/SessionsTreeProvider.js';
import { getLiveTmuxSessions, killTmuxSession } from '../../../sessions/tmuxState.js';

async function until(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() > deadline) { assert.fail(`Timed out: ${description}`); }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

suite('Agent Fleet navigation through the real VS Code terminal and CLI', function () {
  this.timeout(90_000);

  test('project and persona selection reuses one terminal and preserves the agent processes', async function () {
    // CI can point this at its companion CLI build. No real user's agents,
    // credentials or tmux socket are used by this integration test.
    const binary = process.env.VIBEFLOW_CLI_TEST_BINARY;
    if (!binary || !fs.existsSync(binary)) { this.skip(); return; }
    const root = fs.mkdtempSync('/tmp/vf-fleet-e2e-');
    const tmuxSocket = `vf-fleet-${process.pid}-${Date.now()}`;
    const tmux = (...args: string[]): string => execFileSync('tmux', ['-L', tmuxSocket, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }).trim();
    const settings = vscode.workspace.getConfiguration('vibeflow');
    const previousRoot = settings.inspect<string>('cli.rootPath')?.globalValue;
    const previousBinary = settings.inspect<string>('cli.binaryPath')?.globalValue;
    const identities = new Map<string, string>();
    let terminal: vscode.Terminal | undefined;
    try {
      const sessions = Array.from({ length: 4 }, (_, i) => {
        const name = `vibeflow_codex-navigation_${i}`;
        tmux('new-session', '-d', '-s', name, 'sleep 180');
        identities.set(name, tmux('display-message', '-p', '-t', name, '#{pane_id}|#{pane_pid}'));
        if (i === 3) { tmux('split-window', '-d', '-t', name, 'sleep 180'); } // Vera/history-style retained source session.
        return { name: `codex-navigation_${i}`, tmux_session: name, project: `Project ${Math.floor(i / 2)}`, project_id: Math.floor(i / 2) + 1, persona: 'principal_engineer', provider: 'codex', branch: 'main', working_dir: root };
      });
      fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify(sessions));
      fs.writeFileSync(path.join(root, 'config.yaml'), `server_url: http://127.0.0.1:9\napi_token: integration-test-only\npoll_interval: 2\ntmux_socket: ${tmuxSocket}\n`, { mode: 0o600 });
      await settings.update('cli.rootPath', root, vscode.ConfigurationTarget.Global);
      await settings.update('cli.binaryPath', binary, vscode.ConfigurationTarget.Global);
      await Promise.all([openCli(undefined), openCli(undefined)]);
      assert.strictEqual(vscode.window.terminals.filter(t => t.name === 'VibeFlow CLI').length, 1, 'concurrent launch created duplicate terminals');
      terminal = vscode.window.terminals.find(t => t.name === 'VibeFlow CLI');
      assert.ok(terminal);
      const socket = cliControlSocket((terminal.creationOptions as vscode.TerminalOptions).shellArgs);
      assert.ok(socket, 'launcher did not opt into VS Code integration');
      for (const [view, index] of [['project', 0], ['session', 3], ['session', 3], ['project', 0], ['project', 0]] as const) {
        const session = sessions[index].tmux_session;
        await navigateCli(undefined, { view, session });
        await until(() => tmux('list-clients', '-F', '#{session_name}').includes('vibeflow_workbench'), 'CLI attaches to the workbench');
        const selected = tmux('display-message', '-p', '-t', 'vibeflow_workbench', '#{pane_id}|#{pane_pid}|#{window_zoomed_flag}');
        assert.strictEqual(selected, `${identities.get(session)}|${view === 'session' ? '1' : '0'}`);
        assert.strictEqual(vscode.window.terminals.find(t => t.name === 'VibeFlow CLI'), terminal);
        const live = getLiveTmuxSessions(tmuxSocket);
        for (const name of identities.keys()) { assert.ok(live.has(name), `${name} disappeared from Agent Fleet in split view`); }
      }
      // The recovered creation options address this terminal even after a
      // module reload; there is no root-wide socket that can retarget another CLI.
      assert.strictEqual((await requestCliNavigation(socket!, { view: 'ping' })).root, root);
      assert.ok(killTmuxSession('codex', 'navigation_3', tmuxSocket), 'stop did not find the composed agent');
      identities.delete('vibeflow_codex-navigation_3');
      assert.ok(!getLiveTmuxSessions(tmuxSocket).has('vibeflow_codex-navigation_3'), 'stopped agent remained in the fleet');
      terminal.dispose();
      await until(() => !fs.existsSync(path.join(root, 'vibeflow.pid')), 'CLI releases its lock after the terminal closes');
      for (const [session, identity] of identities) {
        assert.strictEqual(tmux('display-message', '-p', '-t', session, '#{pane_id}|#{pane_pid}'), identity, `${session} was restarted or lost`);
      }
      assert.strictEqual(tmux('list-sessions', '-F', '#{session_name}').includes('vibeflow_codex-navigation_3'), false, 'restore recreated a stopped agent as a shell');
      terminal = undefined;
    } finally {
      terminal?.dispose();
      await settings.update('cli.rootPath', previousRoot, vscode.ConfigurationTarget.Global);
      await settings.update('cli.binaryPath', previousBinary, vscode.ConfigurationTarget.Global);
      try { tmux('kill-server'); } catch { /* Disposable test server already exited. */ }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

suite('Agent Fleet click targets in the native TreeView', () => {
  test('project, cloud-matched and local-only rows use local navigation without switching the cloud project', () => {
    const coordinator = new PollingCoordinator();
    const provider = new SessionsTreeProvider(coordinator);
    const local = [
      { name: 'codex-a', tmux_session: 'vibeflow_codex-a', provider: 'codex', project: 'A', project_id: 1, persona: 'principal_engineer', branch: 'main', working_dir: '/a', vibeflow_session_id: 'server-a' },
      { name: 'codex-b', tmux_session: 'vibeflow_codex-b', provider: 'codex', project: 'B', project_id: 2, persona: 'principal_engineer', branch: 'main', working_dir: '/b', vibeflow_session_id: 'server-b' },
      { name: 'codex-local', tmux_session: 'vibeflow_codex-local', provider: 'codex', project: 'B', project_id: 2, persona: 'principal_engineer', branch: 'main', working_dir: '/b' },
    ];
    // A loaded fleet snapshot, not a replacement of any provider/VS Code method.
    Object.assign(provider, {
      projectId: 1, projectNames: new Map([[1, 'A'], [2, 'B']]), cliSessions: local,
      liveTmuxSessions: new Set(local.map(m => m.tmux_session)),
      sessions: local.filter(m => m.vibeflow_session_id).map((m, i) => ({
        id: i + 1, session_id: m.vibeflow_session_id, project_id: m.project_id,
        working_directory: m.working_dir, git_branch: m.branch, agent_type: 'codex',
        agent_model: 'test', persona_key: m.persona, created_at: '', active: true,
      })),
    });
    try {
      const projects = provider.getChildren().filter(node => node.type === 'project');
      assert.strictEqual(projects.length, 2);
      for (const project of projects) {
        const projectItem = provider.getTreeItem(project);
        assert.strictEqual(projectItem.command?.command, 'vibeflow.openFleetInCli');
        assert.strictEqual(projectItem.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
        assert.strictEqual(provider.getCliNavigation(project.id)?.view, 'project');
        for (const child of provider.getChildren(project)) {
          const item = provider.getTreeItem(child);
          assert.strictEqual(item.command?.command, 'vibeflow.openFleetInCli');
          assert.deepStrictEqual(item.command?.arguments, [child.id]);
          const identity = provider.getCliNavigation(child.id);
          assert.strictEqual(identity?.view, 'session');
          assert.ok(local.some(m => m.tmux_session === identity?.session));
        }
      }
      assert.strictEqual(provider.getCliNavigation('session-server-b')?.session, 'vibeflow_codex-b');
      assert.strictEqual(provider.getCliNavigation('local-vibeflow_codex-local')?.session, 'vibeflow_codex-local');
    } finally { provider.dispose(); coordinator.dispose(); }
  });
});
