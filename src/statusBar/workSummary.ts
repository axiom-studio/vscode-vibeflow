import * as vscode from 'vscode';

export function createWorkSummaryStatusBar(): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.text = '0 agents · 0 ready';
  item.tooltip = 'VibeFlow Work Summary';
  item.command = 'vibeflow.openDashboard';
  item.show();
  return item;
}
