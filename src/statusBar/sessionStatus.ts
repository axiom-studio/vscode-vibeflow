import * as vscode from 'vscode';
import type { AuthService, AuthState } from '../auth/AuthService.js';

export function createSessionStatusBar(auth: AuthService): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

  function update(state: AuthState) {
    if (state === 'authenticated') {
      item.text = '$(pulse) VibeFlow';
      item.tooltip = 'VibeFlow — Connected (no active sessions)';
      item.command = 'vibeflow.viewSessions';
    } else {
      item.text = '$(pulse) VibeFlow $(warning)';
      item.tooltip = 'VibeFlow — Not logged in. Click to login.';
      item.command = 'vibeflow.login';
    }
  }

  update(auth.getState());
  auth.onDidChangeState(update);
  item.show();
  return item;
}
