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

  await confirmAndCloseTabsForProjectSwitch(current, picked.projectId);

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
 * On a project switch, offer to close the previous project's open tabs (#2717).
 * The extension is single-active-project, so every open VibeFlow webview panel
 * belongs to the project being left. Call this BEFORE applying the switch so
 * the `onSwitched` refresh doesn't repurpose the panels to the new project
 * first. No prompt when there are no open VibeFlow tabs.
 */
export async function confirmAndCloseOldProjectTabs(oldProjectName: string): Promise<void> {
  const oldTabs = collectVibeflowWebviewTabs();
  if (oldTabs.length === 0) { return; }
  const choice = await vscode.window.showWarningMessage(
    `Close ${oldTabs.length} open tab${oldTabs.length === 1 ? '' : 's'} from "${oldProjectName}"?`,
    { modal: true, detail: 'These VibeFlow panels are scoped to the project you are leaving.' },
    'Close Tabs',
  );
  if (choice === 'Close Tabs') {
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
}

export async function confirmAndCloseTabsForProjectSwitch(
  current: DetectedProject | undefined,
  nextProjectId: number,
): Promise<void> {
  if (!shouldOfferCloseForProjectSwitch(current, nextProjectId)) { return; }
  await confirmAndCloseOldProjectTabs(current.projectName);
}

export function shouldOfferCloseForProjectSwitch(
  current: DetectedProject | undefined,
  nextProjectId: number,
): current is DetectedProject {
  return !!current && current.projectId !== nextProjectId;
}

/**
 * All open editor tabs backed by a VibeFlow webview panel (dashboard, kanban,
 * tickets, compliance, brainstorm, work-item, session chat, settings). VS Code
 * prefixes extension webview view types (e.g. `mainThreadWebview-vibeflow.…`),
 * so match on the `vibeflow.` segment. Excludes sidebar tree views and the
 * Activity Feed webview-view — those aren't editor tabs and never appear here.
 */
function collectVibeflowWebviewTabs(): vscode.Tab[] {
  const tabs: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups?.all ?? []) {
    for (const tab of group.tabs) {
      if (isVibeflowWebviewTabInput(tab.input)) {
        tabs.push(tab);
      }
    }
  }
  return tabs;
}

export function isVibeflowWebviewTabInput(input: unknown): boolean {
  if (!input || typeof input !== 'object') { return false; }
  const viewType = (input as { viewType?: unknown }).viewType;
  return typeof viewType === 'string' && isVibeflowWebviewViewType(viewType);
}

export function isVibeflowWebviewViewType(viewType: string): boolean {
  return viewType.includes('vibeflow.');
}
