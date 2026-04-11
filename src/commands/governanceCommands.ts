import * as vscode from 'vscode';
import type { VibeFlowClient } from '../api/client.js';
import type { ProjectDetector } from '../project/ProjectDetector.js';
import type { WorkItemsTreeProvider } from '../views/workItems/WorkItemsTreeProvider.js';

// --- QA Workflows ---

export async function qaVerify(
  client: VibeFlowClient,
  itemType: 'todo' | 'issue',
  itemId: number,
  workItemsProvider: WorkItemsTreeProvider,
): Promise<void> {
  try {
    await client.qaVerify(itemType, itemId);
    vscode.window.showInformationMessage(`VibeFlow: QA verified ${itemType} #${itemId}`);
    workItemsProvider.refresh();
  } catch (err) {
    vscode.window.showErrorMessage(`VibeFlow: QA verify failed — ${err}`);
  }
}

export async function qaReject(
  client: VibeFlowClient,
  itemType: 'todo' | 'issue',
  itemId: number,
  workItemsProvider: WorkItemsTreeProvider,
): Promise<void> {
  const comment = await vscode.window.showInputBox({
    prompt: `QA rejection reason for ${itemType} #${itemId} (required)`,
    placeHolder: 'Describe what failed...',
    ignoreFocusOut: true,
  });
  if (!comment) { return; }

  try {
    await client.qaReject(itemType, itemId, comment);
    vscode.window.showInformationMessage(`VibeFlow: QA rejected ${itemType} #${itemId}`);
    workItemsProvider.refresh();
  } catch (err) {
    vscode.window.showErrorMessage(`VibeFlow: QA reject failed — ${err}`);
  }
}

// --- Security Review Workflows ---

export async function securityApprove(
  client: VibeFlowClient,
  itemType: 'todo' | 'issue',
  itemId: number,
  workItemsProvider: WorkItemsTreeProvider,
): Promise<void> {
  try {
    await client.securityVerify(itemType, itemId);
    vscode.window.showInformationMessage(`VibeFlow: Security approved ${itemType} #${itemId}`);
    workItemsProvider.refresh();
  } catch (err) {
    vscode.window.showErrorMessage(`VibeFlow: Security approve failed — ${err}`);
  }
}

export async function securityReject(
  client: VibeFlowClient,
  itemType: 'todo' | 'issue',
  itemId: number,
  workItemsProvider: WorkItemsTreeProvider,
): Promise<void> {
  const comment = await vscode.window.showInputBox({
    prompt: `Security rejection reason for ${itemType} #${itemId} (required)`,
    placeHolder: 'Describe the security concern...',
    ignoreFocusOut: true,
  });
  if (!comment) { return; }

  try {
    await client.securityReject(itemType, itemId, comment);
    vscode.window.showInformationMessage(`VibeFlow: Security rejected ${itemType} #${itemId}`);
    workItemsProvider.refresh();
  } catch (err) {
    vscode.window.showErrorMessage(`VibeFlow: Security reject failed — ${err}`);
  }
}

// --- Branch Review Status ---

export async function checkBranchReviewStatus(
  client: VibeFlowClient,
  detector: ProjectDetector,
): Promise<boolean> {
  const project = detector.getCachedProject();
  if (!project) {
    vscode.window.showErrorMessage('VibeFlow: No project detected.');
    return false;
  }

  try {
    const result = await client.checkBranchReviewStatus(project.projectId, project.gitBranch);

    if (result.ready) {
      vscode.window.showInformationMessage(
        `VibeFlow: Branch "${project.gitBranch}" is ready for PR — all items QA verified and security reviewed.`,
      );
      return true;
    } else {
      const parts: string[] = [];
      if (result.needsQA > 0) { parts.push(`${result.needsQA} need QA review`); }
      if (result.needsSecurity > 0) { parts.push(`${result.needsSecurity} need security review`); }
      vscode.window.showWarningMessage(
        `VibeFlow: Branch "${project.gitBranch}" not ready for PR — ${parts.join(', ')}.`,
      );
      return false;
    }
  } catch (err) {
    vscode.window.showErrorMessage(`VibeFlow: Failed to check branch status — ${err}`);
    return false;
  }
}
