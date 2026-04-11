import * as vscode from 'vscode';
import type { AuthService, AuthState } from '../auth/AuthService.js';
import type { PromptNotifier } from '../notifications/PromptNotifier.js';

export function createSessionStatusBar(
  auth: AuthService,
  promptNotifier: PromptNotifier,
): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

  let currentAuthState: AuthState = auth.getState();
  let promptCount = 0;

  function update() {
    if (currentAuthState !== 'authenticated') {
      item.text = '$(pulse) VibeFlow $(warning)';
      item.tooltip = 'VibeFlow — Not logged in. Click to login.';
      item.command = 'vibeflow.login';
      item.backgroundColor = undefined;
    } else if (promptCount > 0) {
      item.text = `$(pulse) VibeFlow · ${promptCount} prompt${promptCount > 1 ? 's' : ''}`;
      item.tooltip = `VibeFlow — ${promptCount} pending prompt(s). Click to respond.`;
      item.command = 'vibeflow.respondToPrompt';
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      item.text = '$(pulse) VibeFlow';
      item.tooltip = 'VibeFlow — Connected';
      item.command = 'vibeflow.viewSessions';
      item.backgroundColor = undefined;
    }
  }

  auth.onDidChangeState(state => {
    currentAuthState = state;
    update();
  });

  promptNotifier.onDidChangeCount(count => {
    promptCount = count;
    update();
  });

  update();
  item.show();
  return item;
}
