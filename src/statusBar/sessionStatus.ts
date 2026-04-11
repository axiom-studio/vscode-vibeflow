import * as vscode from 'vscode';

export function createSessionStatusBar(): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.text = '$(pulse) VibeFlow';
  item.tooltip = 'VibeFlow — No active sessions';
  item.command = 'vibeflow.viewSessions';
  item.show();
  return item;
}
