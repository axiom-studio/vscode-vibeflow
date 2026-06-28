import * as vscode from 'vscode';
import type { VibeFlowClient } from '../api/client.js';
import type { ProjectDetector } from '../project/ProjectDetector.js';
import type { BranchReviewStatus } from '../api/types.js';
import type { PollingCoordinator, Disposer } from '../core/PollingCoordinator.js';

/**
 * Right-aligned status bar item that surfaces branch review readiness so
 * the user knows at a glance whether the current branch is ready for PR.
 *
 * States rendered:
 *   - empty branch: "$(git-branch) <branch> — no work"
 *   - ready: "$(check) <branch> — ready"
 *   - pending: "$(warning) <branch> — N to review" (security + qa pending)
 *   - findings: "$(error) <branch> — N finding(s)" (open compliance findings)
 *   - disconnected: hidden
 *
 * Click → fires the existing `vibeflow.checkBranchStatus` command which
 * shows a fuller popup with `total_lines`, qa/security split, etc.
 *
 * Polls on the same interval as other trees (vibeflow.polling.interval).
 * Backend wire shape: axiomcloud/mcp/vibeflow_tools.go check_branch_review_status,
 * collapsed types in src/api/types.ts BranchReviewStatus.
 */
export interface BranchReviewBarItem extends vscode.StatusBarItem {
  start(client: VibeFlowClient, detector: ProjectDetector): void;
  stop(): void;
  refresh(): Promise<void>;
}

export function createBranchReviewStatusBar(coordinator: PollingCoordinator): BranchReviewBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99) as BranchReviewBarItem;
  item.command = 'vibeflow.checkBranchStatus';
  // Hidden until we have a project. Don't flash "checking..." into the
  // status bar on activation when the user hasn't connected yet.
  item.hide();

  let pollSub: Disposer | undefined;
  let activeClient: VibeFlowClient | undefined;
  let activeDetector: ProjectDetector | undefined;

  function render(branch: string, status: BranchReviewStatus | undefined, error: string | undefined): void {
    if (error) {
      item.text = `$(question) ${branch}`;
      item.tooltip = `VibeFlow: branch review check failed — ${error}. Click to retry.`;
      item.backgroundColor = undefined;
      item.show();
      return;
    }
    if (!status || !status.total_items) {
      item.text = `$(git-branch) ${branch}`;
      item.tooltip = `VibeFlow: branch "${branch}" has no tracked work items.`;
      item.backgroundColor = undefined;
      item.show();
      return;
    }

    const ready = status.overall_security === 'PASS' && status.overall_qa === 'PASS';
    if (ready) {
      const tail = status.total_lines ? ` · ${status.total_lines}` : '';
      item.text = `$(check) ${branch}`;
      item.tooltip = `VibeFlow: branch "${branch}" ready for PR — ${status.total_items} item(s) reviewed${tail}.`;
      item.backgroundColor = undefined;
      item.show();
      return;
    }

    const findings = status.open_findings ?? 0;
    const total = status.total_items;
    const needsSecurity = total - (status.security_passed ?? 0);
    const needsQA = total - (status.qa_passed ?? 0);
    const pending = Math.max(needsSecurity, needsQA);

    if (findings > 0) {
      item.text = `$(error) ${branch} · ${findings} finding${findings === 1 ? '' : 's'}`;
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else {
      item.text = `$(warning) ${branch} · ${pending} to review`;
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    const parts: string[] = [];
    if (needsSecurity > 0) { parts.push(`${needsSecurity} need security review`); }
    if (needsQA > 0) { parts.push(`${needsQA} need QA verification`); }
    if (findings > 0) { parts.push(`${findings} open finding(s)`); }
    item.tooltip = `VibeFlow: branch "${branch}" not ready for PR — ${parts.join(', ')}.`;
    item.show();
  }

  async function refreshOnce(): Promise<void> {
    if (!activeClient || !activeDetector) { return; }
    const project = activeDetector.getCachedProject();
    if (!project || !project.gitBranch) {
      item.hide();
      return;
    }
    try {
      const status = await activeClient.checkBranchReviewStatus(project.projectId, project.gitBranch);
      render(project.gitBranch, status, undefined);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      render(project.gitBranch, undefined, msg);
    }
  }

  item.start = (client, detector) => {
    activeClient = client;
    activeDetector = detector;
    item.stop();
    const config = vscode.workspace.getConfiguration('vibeflow');
    const interval = config.get<number>('polling.interval', 30) * 1000;
    pollSub = coordinator.subscribe(interval, () => void refreshOnce(), 'branch-review');
    void refreshOnce();
  };

  item.stop = () => {
    pollSub?.dispose();
    pollSub = undefined;
    activeClient = undefined;
    activeDetector = undefined;
    item.hide();
  };

  item.refresh = refreshOnce;

  return item;
}
