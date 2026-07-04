import * as vscode from 'vscode';
import type { VibeFlowClient } from '../api/client.js';
import type { ProjectDetector } from '../project/ProjectDetector.js';
import type { WorkItemsTreeProvider } from '../views/workItems/WorkItemsTreeProvider.js';
import { createCloudRunner } from './cloudRunnerCommands.js';

const ITEM_TYPES = [
  { label: '$(bug) Issue', description: 'Bug or standalone fix', value: 'issue' as const },
  { label: '$(checklist) Todo', description: 'Enhancement under a feature', value: 'todo' as const },
  { label: '$(package) Feature', description: 'New feature category', value: 'feature' as const },
];

// Offered in the "+" picker only when the org has the Cloud Runners
// capability (feature #603). A cloud runner isn't a tracked work item — it
// branches to its own provisioning flow (cloudRunnerCommands.ts).
const CLOUD_RUNNER_OPTION = {
  label: '$(cloud) Cloud Runner',
  description: 'Provision a cloud-hosted agent runner',
  value: 'cloudRunner' as const,
};

/**
 * Build the "+" (Create) picker options (#3388). "Cloud Runner" is appended
 * only when the org has the Cloud Runners capability, so the option is a pure
 * function of the flag — extracted so the capability-exposure gate has a
 * regression test without mocking the interactive QuickPick.
 */
export function buildCreateWorkItemOptions(cloudRunnersEnabled: boolean) {
  return cloudRunnersEnabled ? [...ITEM_TYPES, CLOUD_RUNNER_OPTION] : [...ITEM_TYPES];
}

const PRIORITIES = [
  { label: '$(arrow-up) High', value: 'high' as const },
  { label: '$(dash) Medium', value: 'medium' as const },
  { label: '$(arrow-down) Low', value: 'low' as const },
];

/**
 * Statuses offered in the "Change Status" Quick Pick.
 *
 * Backend canonical statuses (axiomcloud/database/vibeflow_models.go:36-46):
 *   in_review, needs_pm_input, needs_ux_input, planning, ready_to_implement,
 *   architecture_review_complete, implementing, done, archived, rejected.
 *
 * The backend enforces exactly ONE transition rule: from `rejected` only
 * `in_review` is accepted (VibeflowStatusRejected check in vibeflow_models.go).
 * Every other source→target pair is allowed, so we surface the FULL set
 * (minus the current status) to match the web UI's status dropdown. The
 * earlier curated per-source lists silently HID valid targets — most visibly
 * Done and Rejected, which were unreachable from `planning` and several other
 * sources.
 *
 * `archived` is intentionally NOT a target here: archiving is a separate
 * action and the web's status dropdown omits it too (9 statuses, no archived).
 * Verified 2026-05-04 against axiomcloud — VibeflowStatus.IsValid() lists 10.
 */
const SELECTABLE_STATUSES: { label: string; value: string }[] = [
  { label: 'In Review', value: 'in_review' },
  { label: 'Needs PM Input', value: 'needs_pm_input' },
  { label: 'Needs UX Input', value: 'needs_ux_input' },
  { label: 'Planning', value: 'planning' },
  { label: 'Ready to Implement', value: 'ready_to_implement' },
  { label: 'Architecture Review Complete', value: 'architecture_review_complete' },
  { label: 'Implementing', value: 'implementing' },
  { label: 'Done', value: 'done' },
  { label: 'Rejected', value: 'rejected' },
];

/**
 * Build the transition options for `currentStatus`: the full selectable set
 * minus the current status, with two refinements —
 *  - from `rejected` the backend only accepts `in_review`, so offer just that;
 *  - from `done`, flag the `implementing` move as rework (the confirm dialog
 *    below enforces that it clears QA/Security).
 */
function transitionsFor(currentStatus: string): { label: string; value: string }[] {
  if (currentStatus === 'rejected') {
    return [{ label: 'In Review (revive after rejection)', value: 'in_review' }];
  }
  return SELECTABLE_STATUSES
    .filter(s => s.value !== currentStatus)
    .map(s =>
      currentStatus === 'done' && s.value === 'implementing'
        ? { label: 'Implementing (rework — clears QA/Security)', value: 'implementing' }
        : s,
    );
}

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

  // Step 1: Type. Offer "Cloud Runner" only when the org has the capability.
  const cloudRunnersEnabled = await client.isCloudRunnersEnabled().catch(() => false);
  const typeOptions = buildCreateWorkItemOptions(cloudRunnersEnabled);
  const itemType = await vscode.window.showQuickPick(typeOptions, {
    placeHolder: 'What would you like to create?',
    title: 'VibeFlow: Create',
  });
  if (!itemType) { return; }

  // Cloud Runner is not a tracked work item — hand off to its own flow.
  if (itemType.value === 'cloudRunner') {
    await createCloudRunner(client, project.projectId);
    return;
  }

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
  const transitions = transitionsFor(currentStatus);
  if (transitions.length === 0) {
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
    // PUT /rest/v1/vibeflow/{todos|issues}/{id} with priority in the body
    // (axiomcloud accepts priority alongside the other editable fields).
    if (itemType === 'todo') {
      await client.updateTodo(itemId, { priority: selected.value });
    } else {
      await client.updateIssue(itemId, { priority: selected.value });
    }
    vscode.window.showInformationMessage(`VibeFlow: Priority set to ${selected.value} for ${itemType} #${itemId}`);
    workItemsProvider.refresh();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`VibeFlow: Failed to change priority — ${msg}`);
  }
}
