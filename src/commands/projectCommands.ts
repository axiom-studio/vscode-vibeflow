import * as vscode from 'vscode';
import type { VibeFlowClient } from '../api/client.js';
import type { DetectedProject, ProjectDetector } from '../project/ProjectDetector.js';

interface ProjectQuickPickItem extends vscode.QuickPickItem {
  projectId: number;
  projectName: string;
  gitRemoteUrl: string;
}

/**
 * Open a Quick Pick listing all projects accessible to the current
 * user; on selection, switch the active project — same path as
 * Settings → Connection → "Set as active".
 *
 * Surfaces this as `vibeflow.pickProject` so the status-bar item, the
 * command palette, and any future right-click menu can all trigger
 * the same flow.
 *
 * Auth + connection state are validated up front so we fail loudly
 * (toast) rather than handing the user an empty Quick Pick.
 */
export async function pickProject(deps: {
  client: VibeFlowClient;
  detector: ProjectDetector;
  onSwitched: (project: DetectedProject) => void;
}): Promise<void> {
  const { client, detector, onSwitched } = deps;

  if (!client.isAuthenticated()) {
    const choice = await vscode.window.showWarningMessage(
      'VibeFlow: Sign in before switching projects.',
      'Open Setup',
    );
    if (choice === 'Open Setup') {
      await vscode.commands.executeCommand('vibeflow.setup');
    }
    return;
  }

  let projects;
  try {
    projects = await client.listProjects();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`VibeFlow: Couldn't load projects — ${message}`);
    return;
  }

  if (projects.length === 0) {
    vscode.window.showInformationMessage('VibeFlow: No projects available for your account yet.');
    return;
  }

  const current = detector.getCachedProject();
  const items: ProjectQuickPickItem[] = projects
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(p => {
      const isActive = current?.projectId === p.id;
      return {
        label: `$(folder) ${p.name}`,
        description: isActive ? '$(check) Active' : undefined,
        detail: p.git_remote_url ? p.git_remote_url : undefined,
        projectId: p.id,
        projectName: p.name,
        gitRemoteUrl: p.git_remote_url ?? '',
      };
    });

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Switch VibeFlow project',
    placeHolder: current
      ? `Active: ${current.projectName} — pick a project to switch to`
      : 'Pick a project to activate',
    matchOnDescription: false,
    matchOnDetail: true,
  });
  if (!picked) { return; }

  if (current?.projectId === picked.projectId) {
    vscode.window.showInformationMessage(`VibeFlow: "${picked.projectName}" is already active.`);
    return;
  }

  // Match the Settings → Connection tab's switch path exactly: keep
  // the workspace's live git branch (the cache schema doesn't persist
  // it, so we must read it fresh) and preserve the previous
  // gitRemoteUrl if the server didn't return one.
  const liveBranch = await detector.getGitBranch();
  const detected: DetectedProject = {
    projectId: picked.projectId,
    projectName: picked.projectName,
    gitRemoteUrl: picked.gitRemoteUrl || current?.gitRemoteUrl || '',
    gitBranch: liveBranch,
  };

  try {
    await detector.cacheProject(detected);
    onSwitched(detected);
    vscode.window.showInformationMessage(`VibeFlow: Switched to "${picked.projectName}"`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`VibeFlow: project switch failed — ${message}`);
  }
}
