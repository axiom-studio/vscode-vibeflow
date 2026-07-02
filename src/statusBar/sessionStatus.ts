import * as vscode from 'vscode';
import type { AuthService, AuthState } from '../auth/AuthService.js';
import type { PromptNotifier } from '../notifications/PromptNotifier.js';
import type { DetectedProject } from '../project/ProjectDetector.js';
import type { WorkingIndicatorUpdate } from '../sessions/workingIndicator.js';

export interface ConnectionState {
  auth: AuthState;
  project: DetectedProject | undefined;
  promptCount: number;
  error: string | undefined;
}

/**
 * Left status bar item — shows connection state with 6 distinct modes.
 */
export function createSessionStatusBar(
  auth: AuthService,
  promptNotifier: PromptNotifier,
): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

  const state: ConnectionState = {
    auth: auth.getState(),
    project: undefined,
    promptCount: 0,
    error: undefined,
  };

  function render() {
    // State 6: Connection error
    if (state.error) {
      item.text = '$(error) VibeFlow';
      item.tooltip = `VibeFlow — Error: ${state.error}. Click to retry.`;
      item.command = 'vibeflow.setup';
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      item.show();
      return;
    }

    // State 1: Not authenticated
    if (state.auth !== 'authenticated') {
      item.text = '$(warning) VibeFlow';
      item.tooltip = 'VibeFlow — Not logged in. Click to set up.';
      item.command = 'vibeflow.setup';
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      item.show();
      return;
    }

    // State 2: Authenticated, no project
    if (!state.project) {
      item.text = '$(warning) VibeFlow';
      item.tooltip = 'VibeFlow — No project detected. Click to set up.';
      item.command = 'vibeflow.setup';
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      item.show();
      return;
    }

    // State 5: Prompts pending
    if (state.promptCount > 0) {
      const s = state.promptCount > 1 ? 's' : '';
      item.text = `$(pulse) VibeFlow · ${state.promptCount} prompt${s}`;
      item.tooltip = `VibeFlow — ${state.project.projectName} · ${state.promptCount} pending prompt${s}. Click to respond.`;
      item.command = 'vibeflow.respondToPrompt';
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      item.show();
      return;
    }

    // State 3/4: Connected (with or without active sessions)
    item.text = `$(pulse) VibeFlow · ${state.project.projectName}`;
    item.tooltip = `VibeFlow — Connected to "${state.project.projectName}" (${state.project.gitBranch})`;
    item.command = 'vibeflow.viewSessions';
    item.backgroundColor = undefined;
    item.show();
  }

  auth.onDidChangeState(authState => {
    state.auth = authState;
    if (authState === 'unauthenticated') {
      state.project = undefined;
    }
    render();
  });

  promptNotifier.onDidChangeCount(count => {
    state.promptCount = count;
    render();
  });

  render();
  item.show();

  // Expose a method to update project state
  (item as StatusBarItemWithUpdate).updateProject = (project: DetectedProject | undefined) => {
    state.project = project;
    render();
  };

  (item as StatusBarItemWithUpdate).setError = (error: string | undefined) => {
    state.error = error;
    render();
  };

  return item;
}

export interface StatusBarItemWithUpdate extends vscode.StatusBarItem {
  updateProject(project: DetectedProject | undefined): void;
  setError(error: string | undefined): void;
}

/**
 * Right status bar item — shows agent/work item counts.
 */
export function createWorkSummaryStatusBar(): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.text = 'Not connected';
  item.tooltip = 'VibeFlow — Not connected';
  item.command = 'vibeflow.setup';
  item.show();

  // Expose update method
  (item as WorkSummaryBarItem).updateCounts = (agents: number, ready: number) => {
    if (agents === 0 && ready === 0) {
      item.text = 'No sessions';
      item.tooltip = 'VibeFlow — Connected, no active sessions';
      item.command = 'vibeflow.launchSession';
    } else {
      item.text = `${agents} agent${agents !== 1 ? 's' : ''} · ${ready} ready`;
      item.tooltip = `VibeFlow — ${agents} active session(s), ${ready} ready work item(s)`;
      item.command = 'vibeflow.viewSessions';
    }
  };

  (item as WorkSummaryBarItem).setDisconnected = () => {
    item.text = 'Not connected';
    item.tooltip = 'VibeFlow — Not connected';
    item.command = 'vibeflow.setup';
  };

  return item;
}

export interface WorkSummaryBarItem extends vscode.StatusBarItem {
  updateCounts(agents: number, ready: number): void;
  setDisconnected(): void;
}

/**
 * Right status bar item - shows aggregate agent Working state from /ws/ui.
 */
export function createWorkingStatusBar(): WorkingStatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101) as WorkingStatusBarItem;
  const originalDispose = item.dispose.bind(item);
  let latest: WorkingIndicatorUpdate | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stopTimer = () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const render = () => {
    const snapshot = latest?.snapshot;
    if (!latest || !snapshot || snapshot.activeCount === 0 || snapshot.startedAtMs === undefined) {
      item.hide();
      stopTimer();
      return;
    }

    const elapsed = formatElapsed(Date.now() - snapshot.startedAtMs);
    item.text = snapshot.activeCount === 1
      ? `$(sync~spin) Working ${elapsed}`
      : `$(sync~spin) ${snapshot.activeCount} working · ${elapsed}`;
    item.tooltip = buildWorkingTooltip(latest);
    item.command = 'vibeflow.viewSessions';
    item.show();

    if (!timer) {
      timer = setInterval(render, 1_000);
    }
  };

  item.updateWorking = (update: WorkingIndicatorUpdate): void => {
    latest = update;
    render();
  };

  item.setDisconnected = (): void => {
    latest = undefined;
    item.hide();
    stopTimer();
  };

  item.dispose = (): void => {
    stopTimer();
    originalDispose();
  };

  item.hide();
  return item;
}

export interface WorkingStatusBarItem extends vscode.StatusBarItem {
  updateWorking(update: WorkingIndicatorUpdate): void;
  setDisconnected(): void;
}

/**
 * Left status bar item — shows the active project name. Click opens
 * the project picker Quick Pick (`vibeflow.pickProject`).
 *
 * Sits just to the right of the session indicator (priority 99 < 100).
 * Hidden when there is no active project (covers unauthenticated +
 * fresh-install states) so it doesn't shout an empty label.
 */
export function createProjectStatusBar(): ProjectStatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99) as ProjectStatusBarItem;
  item.command = 'vibeflow.pickProject';
  item.hide();

  // Truncate long project names so the status bar doesn't bloat. 24
  // chars is enough for most well-named projects and short enough to
  // keep the rest of the status bar usable on narrow editor widths.
  const MAX_LABEL = 24;

  item.updateProject = (project: DetectedProject | undefined): void => {
    if (!project) {
      item.hide();
      return;
    }
    const label = project.projectName.length > MAX_LABEL
      ? project.projectName.slice(0, MAX_LABEL - 1) + '…'
      : project.projectName;
    item.text = `$(folder) ${label}`;
    item.tooltip = `Active VibeFlow project: ${project.projectName} (#${project.projectId})\nClick to switch projects.`;
    item.show();
  };

  return item;
}

export interface ProjectStatusBarItem extends vscode.StatusBarItem {
  updateProject(project: DetectedProject | undefined): void;
}

function buildWorkingTooltip(update: WorkingIndicatorUpdate): string {
  const source = update.source === 'websocket'
    ? 'WebSocket /ws/ui'
    : 'REST fallback polling';
  const lines = [`VibeFlow - Working indicator (${source})`];
  if (update.detail) {
    lines.push(update.detail);
  }
  for (const session of update.snapshot.sessions.slice(0, 5)) {
    const id = session.sessionId.length > 12 ? session.sessionId.slice(-12) : session.sessionId;
    const label = session.workItemType && session.workItemId
      ? `${session.workItemType} #${session.workItemId}`
      : 'session';
    lines.push(`${id}: ${label}${session.summary ? ` - ${session.summary}` : ''}`);
  }
  return lines.join('\n');
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours > 0) {
    return `${hours}:${pad2(minutes)}:${pad2(seconds)}`;
  }
  return `${pad2(minutes)}:${pad2(seconds)}`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}
