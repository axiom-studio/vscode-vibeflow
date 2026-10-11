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
  const { client, detector } = deps;

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
  const items: ProjectQuickPickItem[] = sortProjects(projects)
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

  await switchToProject(deps, picked);
}

/** Projects in the order every picker shows them: by name. */
export function sortProjects<T extends { name: string }>(projects: readonly T[]): T[] {
  return projects.slice().sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Make `picked` the active project: the one switch path shared by the
 * QuickPick and the sidebar project dropdown. Closes the old project's
 * panels first, then caches the project and reconnects every view.
 */
export async function switchToProject(
  deps: { detector: ProjectDetector; onSwitched: (project: DetectedProject) => void },
  picked: { projectId: number; projectName: string; gitRemoteUrl: string },
): Promise<void> {
  const { detector, onSwitched } = deps;
  const current = detector.getCachedProject();
  if (current?.projectId === picked.projectId) { return; }

  await closeTabsForProjectSwitch(current, picked.projectId);

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

/**
 * On a project switch, close the previous project's VibeFlow panels (#2717,
 * #4031). The extension is single-active-project, so every open project-scoped
 * VibeFlow webview belongs to the project being left. No prompt: a switch means
 * the whole context changes (design doc #627 D3). Code editors and terminals,
 * the VibeFlow CLI included, are never webviews, so they are never closed.
 * Call this BEFORE applying the switch so the `onSwitched` refresh doesn't
 * repurpose the panels to the new project first.
 */
export async function closeOldProjectTabs(): Promise<void> {
  const oldTabs = collectProjectScopedWebviewTabs();
  if (oldTabs.length === 0) { return; }
  try {
    const closed = await vscode.window.tabGroups.close(oldTabs, true);
    if (!closed) {
      vscode.window.showWarningMessage('VibeFlow: VS Code did not close all old project tabs.');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showWarningMessage(`VibeFlow: could not close old project tabs — ${message}`);
  }
}

export async function closeTabsForProjectSwitch(
  current: DetectedProject | undefined,
  nextProjectId: number,
): Promise<void> {
  if (!isProjectSwitch(current, nextProjectId)) { return; }
  await closeOldProjectTabs();
}

export function isProjectSwitch(
  current: DetectedProject | undefined,
  nextProjectId: number,
): boolean {
  return !!current && current.projectId !== nextProjectId;
}

/**
 * All open editor tabs backed by a project-scoped VibeFlow webview panel
 * (dashboard, kanban, tickets, compliance, brainstorm, work-item, session
 * chat). Excludes sidebar tree views and the Activity Feed webview-view —
 * those aren't editor tabs and never appear here.
 */
function collectProjectScopedWebviewTabs(): vscode.Tab[] {
  const tabs: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups?.all ?? []) {
    for (const tab of group.tabs) {
      if (isProjectScopedWebviewTabInput(tab.input)) {
        tabs.push(tab);
      }
    }
  }
  return tabs;
}

const SETTINGS_VIEW_TYPE = 'vibeflow.settings';

/**
 * Structural check (no `instanceof`): webview tab inputs carry a `viewType`;
 * text editors and terminals do not. Settings is a VibeFlow webview but is
 * not project-scoped, and a project can be switched from inside it.
 */
export function isProjectScopedWebviewTabInput(input: unknown): boolean {
  if (!input || typeof input !== 'object') { return false; }
  const viewType = (input as { viewType?: unknown }).viewType;
  return typeof viewType === 'string'
    && isVibeflowWebviewViewType(viewType)
    && !viewType.endsWith(SETTINGS_VIEW_TYPE);
}

export function isVibeflowWebviewViewType(viewType: string): boolean {
  return viewType.includes('vibeflow.');
}
