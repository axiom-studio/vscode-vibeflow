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

/**
 * Check whether the current branch is ready for a PR. Returns true when both
 * security review and QA verification have passed for every work item on the
 * branch.
 *
 * Wire-shape reference: axiomcloud/mcp/vibeflow_tools.go:7415-7424. The tool
 * returns `overall_security`/`overall_qa` PASS|PENDING strings (NOT a
 * `ready` boolean), counts as `security_passed`/`qa_passed`/`total_items`,
 * and a special `total_items === 0` short-form when the branch has no work.
 */
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

    // No work items on this branch — server short-circuits to `{ total_items: 0, message }`.
    if (!result.total_items || result.total_items === 0) {
      vscode.window.showInformationMessage(
        `VibeFlow: Branch "${project.gitBranch}" has no tracked work items.`,
      );
      return true;
    }

    const ready = result.overall_security === 'PASS' && result.overall_qa === 'PASS';

    if (ready) {
      const tail = result.total_lines ? ` · ${result.total_lines}` : '';
      vscode.window.showInformationMessage(
        `VibeFlow: Branch "${project.gitBranch}" is ready for PR — ` +
        `${result.total_items} item(s), all reviewed${tail}.`,
      );
      return true;
    }

    const total = result.total_items;
    const needsSecurity = total - (result.security_passed ?? 0);
    const needsQA = total - (result.qa_passed ?? 0);
    const parts: string[] = [];
    if (needsSecurity > 0) { parts.push(`${needsSecurity} need security review`); }
    if (needsQA > 0) { parts.push(`${needsQA} need QA verification`); }
    if ((result.open_findings ?? 0) > 0) { parts.push(`${result.open_findings} open finding(s)`); }
    const detail = parts.length > 0 ? ` — ${parts.join(', ')}` : '';
    vscode.window.showWarningMessage(
      `VibeFlow: Branch "${project.gitBranch}" not ready for PR${detail}.`,
    );
    return false;
  } catch (err) {
    vscode.window.showErrorMessage(`VibeFlow: Failed to check branch status — ${err}`);
    return false;
  }
}
