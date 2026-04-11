import * as vscode from 'vscode';
import type { AuthService, AuthState } from '../auth/AuthService.js';
import type { PromptNotifier } from '../notifications/PromptNotifier.js';
import type { DetectedProject } from '../project/ProjectDetector.js';

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
