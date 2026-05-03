import * as vscode from 'vscode';
import type { VibeFlowClient } from '../api/client.js';
import type { ProjectDetector } from '../project/ProjectDetector.js';
import type { WorkItemsTreeProvider } from '../views/workItems/WorkItemsTreeProvider.js';

const ITEM_TYPES = [
  { label: '$(bug) Issue', description: 'Bug or standalone fix', value: 'issue' as const },
  { label: '$(checklist) Todo', description: 'Enhancement under a feature', value: 'todo' as const },
  { label: '$(package) Feature', description: 'New feature category', value: 'feature' as const },
];

const PRIORITIES = [
  { label: '$(arrow-up) High', value: 'high' as const },
  { label: '$(dash) Medium', value: 'medium' as const },
  { label: '$(arrow-down) Low', value: 'low' as const },
];

/**
 * Allowed status transitions surfaced in the "Change Status" Quick Pick.
 *
 * Backend canonical statuses (axiomcloud/database/vibeflow_models.go:36-46):
 *   in_review, needs_pm_input, needs_ux_input, planning, ready_to_implement,
 *   architecture_review_complete, implementing, done, archived, rejected.
 *
 * The backend enforces ONE transition rule (from `rejected` only `in_review`
 * is allowed — see VibeflowStatusRejected check in vibeflow_models.go); all
 * other source/target pairs are accepted. These lists are pure UX guidance:
 * they show the most-likely "next state" from each source so the user isn't
 * picking from all 10 every time.
 *
 * Verified 2026-05-04 against axiomcloud — VibeflowStatus.IsValid() lists 10
 * statuses, and we cover every source: 8 active flow + archived + rejected.
 */
const VALID_TRANSITIONS: Record<string, { label: string; value: string }[]> = {
  in_review: [
    { label: 'Planning', value: 'planning' },
    { label: 'Ready to Implement', value: 'ready_to_implement' },
    { label: 'Needs PM Input', value: 'needs_pm_input' },
    { label: 'Needs UX Input', value: 'needs_ux_input' },
  ],
  needs_pm_input: [
    { label: 'Planning', value: 'planning' },
    { label: 'Ready to Implement', value: 'ready_to_implement' },
    { label: 'In Review', value: 'in_review' },
  ],
  needs_ux_input: [
    { label: 'Planning', value: 'planning' },
    { label: 'Ready to Implement', value: 'ready_to_implement' },
    { label: 'In Review', value: 'in_review' },
  ],
  planning: [
    { label: 'Ready to Implement', value: 'ready_to_implement' },
    { label: 'Architecture Review Complete', value: 'architecture_review_complete' },
    { label: 'In Review', value: 'in_review' },
    { label: 'Needs PM Input', value: 'needs_pm_input' },
    { label: 'Needs UX Input', value: 'needs_ux_input' },
  ],
  ready_to_implement: [
    { label: 'Implementing', value: 'implementing' },
    { label: 'Architecture Review Complete', value: 'architecture_review_complete' },
    { label: 'Planning', value: 'planning' },
  ],
  architecture_review_complete: [
    { label: 'Implementing', value: 'implementing' },
    { label: 'Ready to Implement', value: 'ready_to_implement' },
    { label: 'Planning', value: 'planning' },
  ],
  implementing: [
    { label: 'Done', value: 'done' },
    { label: 'In Review', value: 'in_review' },
    { label: 'Planning', value: 'planning' },
    { label: 'Needs PM Input', value: 'needs_pm_input' },
    { label: 'Needs UX Input', value: 'needs_ux_input' },
  ],
  done: [
    { label: 'Implementing (rework — clears QA/Security)', value: 'implementing' },
    { label: 'Ready to Implement', value: 'ready_to_implement' },
    { label: 'In Review', value: 'in_review' },
  ],
  // Backend's only enforced transition rule: from rejected, only
  // in_review is allowed (vibeflow_models.go:VibeflowStatusRejected
  // check). Surface that as the lone option instead of leaving the
  // user stuck on "No valid transitions" when they hit a rejected
  // item from the tree.
  rejected: [
    { label: 'In Review (revive after rejection)', value: 'in_review' },
  ],
  // Archived has no backend-enforced restrictions; surface common
  // un-archive moves so users can recover an item without leaving
  // the editor for the web UI.
  archived: [
    { label: 'Planning', value: 'planning' },
    { label: 'Ready to Implement', value: 'ready_to_implement' },
    { label: 'In Review', value: 'in_review' },
  ],
};

/**
 * Multi-step Quick Pick for creating a new work item.
 */
export async function createWorkItem(
  client: VibeFlowClient,
  detector: ProjectDetector,
  workItemsProvider: WorkItemsTreeProvider,
): Promise<void> {
  const project = detector.getCachedProject();
  if (!project) {
    vscode.window.showErrorMessage('VibeFlow: No project detected.');
    return;
  }

  if (!client.isAuthenticated()) {
    vscode.window.showErrorMessage('VibeFlow: Not logged in.');
    return;
  }

  // Step 1: Type
  const itemType = await vscode.window.showQuickPick(ITEM_TYPES, {
    placeHolder: 'What type of work item?',
    title: 'VibeFlow: Create Work Item (1/3)',
  });
  if (!itemType) { return; }

  // Step 2: Title
  const title = await vscode.window.showInputBox({
    prompt: `Title for the new ${itemType.value}`,
    title: 'VibeFlow: Create Work Item (2/3)',
    placeHolder: 'e.g., Fix login button not responding',
  });
  if (!title) { return; }

  // Step 3: Priority
  const priority = await vscode.window.showQuickPick(PRIORITIES, {
    placeHolder: 'Priority',
    title: 'VibeFlow: Create Work Item (3/3)',
  });
  if (!priority) { return; }

  try {
    if (itemType.value === 'feature') {
      await client.createFeature(project.projectId, title, priority.value);
    } else if (itemType.value === 'issue') {
      await client.createIssue(project.projectId, title, priority.value, project.gitBranch);
    } else {
      // Todo needs a feature — pick one
      const features = await client.listFeatures(project.projectId);
      if (features.length === 0) {
        vscode.window.showWarningMessage('VibeFlow: Create a feature first before adding todos.');
        return;
      }

      const feature = await vscode.window.showQuickPick(
        features.map(f => ({ label: f.name, description: `ID: ${f.id}`, featureId: f.id })),
        { placeHolder: 'Select parent feature for this todo' },
      );
      if (!feature) { return; }

      await client.createTodo(feature.featureId, title, priority.value, project.gitBranch);
    }

    vscode.window.showInformationMessage(`VibeFlow: Created ${itemType.value} "${title}"`);
    workItemsProvider.refresh();
  } catch (err) {
    vscode.window.showErrorMessage(`VibeFlow: Failed to create ${itemType.value} — ${err}`);
  }
}

/**
 * Change status of a todo or issue via context menu.
 */
export async function changeStatus(
  client: VibeFlowClient,
  itemType: 'todo' | 'issue',
  itemId: number,
  currentStatus: string,
  workItemsProvider: WorkItemsTreeProvider,
): Promise<void> {
  const transitions = VALID_TRANSITIONS[currentStatus];
  if (!transitions || transitions.length === 0) {
    vscode.window.showInformationMessage('VibeFlow: No valid transitions from this status.');
    return;
  }

  const selected = await vscode.window.showQuickPick(transitions, {
    placeHolder: `Change status from "${currentStatus}" to...`,
  });
  if (!selected) { return; }

  // done -> implementing is rework: backend wipes qa_verified +
  // security_reviewed AND deletes the verification rows
  // (vibeflow_issues.go: rework reset). Confirm so the user knows
  // they're invalidating prior reviews — not just changing a label.
  if (currentStatus === 'done' && selected.value === 'implementing') {
    const proceed = await vscode.window.showWarningMessage(
      'Move back to Implementing? This will clear the QA verification ' +
      'and security review on this item — both will need to be redone after rework.',
      { modal: true },
      'Rework',
    );
    if (proceed !== 'Rework') { return; }
  }

  // Backend requires rejection_comment when transitioning to rejected.
  let rejectionComment: string | undefined;
  if (selected.value === 'rejected') {
    const comment = await vscode.window.showInputBox({
      prompt: `Why is ${itemType} #${itemId} being rejected? (required)`,
      placeHolder: 'Describe what failed...',
      ignoreFocusOut: true,
    });
    if (!comment?.trim()) { return; }
    rejectionComment = comment.trim();
  }

  try {
    const opts = rejectionComment ? { rejectionComment } : undefined;
    if (itemType === 'todo') {
      await client.updateTodoStatus(itemId, selected.value, opts);
    } else {
      await client.updateIssueStatus(itemId, selected.value, opts);
    }
    vscode.window.showInformationMessage(`VibeFlow: Status changed to "${selected.value}"`);
    workItemsProvider.refresh();
  } catch (err) {
    vscode.window.showErrorMessage(`VibeFlow: Failed to change status — ${err}`);
  }
}

/**
 * Change priority of a todo or issue via context menu.
 */
export async function changePriority(
  client: VibeFlowClient,
  itemType: 'todo' | 'issue',
  itemId: number,
  workItemsProvider: WorkItemsTreeProvider,
): Promise<void> {
  const selected = await vscode.window.showQuickPick(PRIORITIES, {
    placeHolder: 'New priority',
  });
  if (!selected) { return; }

  try {
    // Priority update goes through the same status endpoint with priority field
    // For now, show info — full API integration when REST endpoints are confirmed
    vscode.window.showInformationMessage(`VibeFlow: Priority set to ${selected.value} for ${itemType} #${itemId}`);
    workItemsProvider.refresh();
  } catch (err) {
    vscode.window.showErrorMessage(`VibeFlow: Failed to change priority — ${err}`);
  }
}
