import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { VibeFlowClient } from '../../api/client.js';
import type { WorkItemsTreeProvider } from './WorkItemsTreeProvider.js';
import type { PollingCoordinator, Disposer } from '../../core/PollingCoordinator.js';
import { liveIntervalMs } from '../../core/pollingConfig.js';
import type {
  VibeFlowTodo,
  VibeFlowIssue,
  VibeFlowComplianceFinding,
} from '../../api/types.js';
import { qaVerify, qaReject, securityApprove, securityReject } from '../../commands/governanceCommands.js';
import { getNonce } from '../../utils/nonce.js';
import {
  assertNever,
  type WorkItemPanelClientMessage,
  type WorkItemPanelHostMessage,
  type WorkItemPanelInfo,
  type WorkItemPanelSnapshot,
} from '../../core/webviewMessages.js';

// Reuse the canonical types from webviewMessages so host and webview can't
// drift. Local aliases keep the rest of the file readable.
type WorkItemInfo = WorkItemPanelInfo;
type WorkItemSnapshot = WorkItemPanelSnapshot;

/**
 * Best-effort MIME type lookup for the attachment uploader. Backend
 * falls back to `application/octet-stream` if we send blank, so this
 * only matters for inline-rendered types (images mostly) — no need to
 * be exhaustive.
 */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.zip': 'application/zip',
};

/**
 * Manages Focus View Webview Panels for work item details.
 *
 * Tabs (Phase B): Details | Attachments | Logs.
 *  - Details: description (markdown), Timeline metadata, compliance tags.
 *  - Attachments: list with filename + size; upload/delete in Phase D.
 *  - Logs: sub-tabs QA & Security (QA + security verdicts + compliance
 *    findings) and Execution Logs (the existing log stream) with
 *    Auto-refresh + Refresh controls.
 *
 * Action toolbar lives above the tabs and gates buttons on the live
 * status / qa_verified / security_reviewed fields per the canonical
 * axiomcloud rules verified 2026-05-03.
 *
 * Phase C (Comment, Edit, Archive, Delete) and Phase D (attachment
 * upload/delete) plug into the same toolbar / Attachments tab.
 */
export class WorkItemPanelManager implements vscode.Disposable {
  private panels = new Map<string, vscode.WebviewPanel>();
  private pollSubs = new Map<string, Disposer>();
  private projectId: number | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly client: VibeFlowClient,
    private readonly workItemsProvider: WorkItemsTreeProvider,
    private readonly coordinator: PollingCoordinator,
  ) {}

  /** Wire (or rewire) the active project. Compliance findings need it. */
  setProjectId(projectId: number | undefined): void {
    this.projectId = projectId;
  }

  open(item: WorkItemInfo): void {
    const key = `${item.type}-${item.id}`;
    const existing = this.panels.get(key);
    if (existing) {
      existing.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'vibeflow.workItemPanel',
      `#${item.id}: ${item.title}`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      },
    );

    this.panels.set(key, panel);
    panel.webview.html = this.getHtml(panel.webview, item);

    panel.webview.onDidReceiveMessage(async (msg: WorkItemPanelClientMessage) => {
      switch (msg.type) {
        case 'changeStatus':
          vscode.commands.executeCommand('vibeflow.changeStatus', item.type, item.id, item.status);
          await this.refreshSnapshot(item, panel);
          break;
        case 'qaVerify':
          await qaVerify(this.client, item.type, item.id, this.workItemsProvider);
          await this.refreshSnapshot(item, panel);
          break;
        case 'qaReject':
          await qaReject(this.client, item.type, item.id, this.workItemsProvider);
          await this.refreshSnapshot(item, panel);
          break;
        case 'securityApprove':
          await securityApprove(this.client, item.type, item.id, this.workItemsProvider);
          await this.refreshSnapshot(item, panel);
          break;
        case 'securityReject':
          await securityReject(this.client, item.type, item.id, this.workItemsProvider);
          await this.refreshSnapshot(item, panel);
          break;
        case 'edit':
          await this.editFlow(item, panel);
          break;
        case 'archive':
          await this.archiveFlow(item, panel);
          break;
        case 'delete':
          await this.deleteFlow(item, panel);
          break;
        case 'uploadAttachment':
          await this.uploadAttachmentFlow(item, panel);
          break;
        case 'deleteAttachment':
          await this.deleteAttachmentFlow(item, panel, msg.payload.attachmentId);
          break;
        case 'refresh':
          await this.refreshSnapshot(item, panel);
          break;
        default:
          assertNever(msg);
      }
    });

    // Poll every 5s. Auto-refresh toggle in the webview only controls the
    // Execution Logs tail re-render — the snapshot itself always refreshes
    // so action visibility, attachment count, and finding list stay live.
    const sub = this.coordinator.subscribe(liveIntervalMs(), () => this.refreshSnapshot(item, panel), `work-item:${key}`);
    this.pollSubs.set(key, sub);

    panel.onDidDispose(() => {
      this.panels.delete(key);
      const s = this.pollSubs.get(key);
      if (s) { s.dispose(); this.pollSubs.delete(key); }
    });

    this.refreshSnapshot(item, panel);
  }

  /**
   * Build a fresh snapshot from the backend and post it to the webview.
   * Five parallel calls; each rejection is absorbed (we degrade the
   * specific section rather than the whole panel).
   */
  private async refreshSnapshot(item: WorkItemInfo, panel: vscode.WebviewPanel): Promise<void> {
    const [freshRes, attachmentsRes, logsRes, findingsRes, reviewRes, qaRes] = await Promise.allSettled([
      item.type === 'todo' ? this.client.getTodo(item.id) : this.client.getIssue(item.id),
      this.client.listAttachments(item.type, item.id),
      this.client.getWorkItemLogs(item.type, item.id),
      this.projectId !== undefined
        ? this.client.listComplianceFindings(this.projectId, {
            work_item_type: item.type,
            work_item_id: item.id,
          })
        : Promise.resolve([] as VibeFlowComplianceFinding[]),
      this.client.getSecurityReview(item.type, item.id),
      this.client.getQAReview(item.type, item.id),
    ]);

    const fresh: VibeFlowTodo | VibeFlowIssue | undefined =
      freshRes.status === 'fulfilled' ? freshRes.value : undefined;

    // Keep the panel's stored status in sync with the latest fetch so the
    // "Change…" button (which reads item.status) offers transitions from the
    // REAL current status — not the open-time argument, which the tree click
    // commands populate with the row's description (claimant/feature), not its
    // status. Without this, changeStatus computed transitionsFor(<desc>) and
    // showed "No valid transitions from this status."
    if (fresh?.status) {
      item.status = fresh.status;
    }

    const snapshot: WorkItemSnapshot = {
      status: fresh?.status ?? item.status,
      qa_verified: fresh?.qa_verified ?? false,
      security_reviewed: fresh?.security_reviewed ?? false,
      description: fresh?.description ?? '',
      user_email: fresh?.user_email ?? '',
      created_at: fresh?.created_at ?? '',
      updated_at: fresh?.updated_at ?? '',
      target_branch: fresh?.target_branch ?? '',
      feature_name: fresh?.feature_name ?? item.featureName ?? '',
      claimed_by: fresh?.claimed_by ?? item.claimedBy ?? '',
      priority: fresh?.priority ?? item.priority,
      compliance_tags: fresh?.compliance_tags ?? [],
      attachments: attachmentsRes.status === 'fulfilled' ? attachmentsRes.value : [],
      execution_logs: logsRes.status === 'fulfilled' ? logsRes.value : [],
      security_findings: findingsRes.status === 'fulfilled' ? findingsRes.value : [],
      security_review: reviewRes.status === 'fulfilled' ? reviewRes.value : undefined,
      qa_review: qaRes.status === 'fulfilled' ? qaRes.value : undefined,
    };

    this.postToWebview(panel, { type: 'snapshot', payload: snapshot });
  }

  /** Typed wrapper so a future drift in WorkItemPanelHostMessage fails the compile. */
  private postToWebview(panel: vscode.WebviewPanel, msg: WorkItemPanelHostMessage): void {
    panel.webview.postMessage(msg);
  }

  /**
   * Edit body fields via a sequence of input boxes. Native VS Code
   * prompts are simpler than a webview form and reuse the same
   * cancellation behavior the rest of the extension uses (Esc aborts).
   * Pre-fills each box with the current value so a small change is
   * one-keystroke; submitting an empty title aborts (treated as cancel).
   */
  private async editFlow(item: WorkItemInfo, panel: vscode.WebviewPanel): Promise<void> {
    const fresh = item.type === 'todo'
      ? await this.client.getTodo(item.id).catch(() => undefined)
      : await this.client.getIssue(item.id).catch(() => undefined);
    if (!fresh) {
      vscode.window.showErrorMessage('VibeFlow: failed to load current values');
      return;
    }

    const title = await vscode.window.showInputBox({
      prompt: `Title for ${item.type} #${item.id}`,
      value: fresh.title,
      ignoreFocusOut: true,
    });
    if (title === undefined) { return; }
    if (!title.trim()) {
      vscode.window.showWarningMessage('VibeFlow: title cannot be empty');
      return;
    }

    const description = await vscode.window.showInputBox({
      prompt: 'Description (markdown supported)',
      value: fresh.description ?? '',
      ignoreFocusOut: true,
    });
    if (description === undefined) { return; }

    const priorityChoice = await vscode.window.showQuickPick(
      ['low', 'medium', 'high'].map(p => ({ label: p, picked: p === fresh.priority })),
      { placeHolder: 'Priority' },
    );
    if (!priorityChoice) { return; }

    const targetBranch = await vscode.window.showInputBox({
      prompt: 'Target branch',
      value: fresh.target_branch ?? '',
      ignoreFocusOut: true,
    });
    if (targetBranch === undefined) { return; }

    try {
      const fields = {
        title: title.trim(),
        description,
        priority: priorityChoice.label,
        target_branch: targetBranch.trim(),
      };
      if (item.type === 'todo') {
        await this.client.updateTodo(item.id, fields);
      } else {
        await this.client.updateIssue(item.id, fields);
      }
      this.workItemsProvider.refresh();
      vscode.window.showInformationMessage(`VibeFlow: Updated ${item.type} #${item.id}`);
      await this.refreshSnapshot(item, panel);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to update: ${msg}`);
    }
  }

  /**
   * Archive flow — issues only (web parity per axiomcloud-ui-gaps.md).
   * Implemented as a status transition to 'archived' via the existing
   * MCP update_issue_status tool. Confirmation modal because archiving
   * removes the issue from default queries.
   */
  private async archiveFlow(item: WorkItemInfo, panel: vscode.WebviewPanel): Promise<void> {
    if (item.type !== 'issue') { return; }
    const confirm = await vscode.window.showWarningMessage(
      `Archive issue #${item.id}? It will be hidden from default queries until unarchived.`,
      { modal: true },
      'Archive',
    );
    if (confirm !== 'Archive') { return; }
    try {
      await this.client.updateIssueStatus(item.id, 'archived');
      this.workItemsProvider.refresh();
      vscode.window.showInformationMessage(`VibeFlow: Archived issue #${item.id}`);
      await this.refreshSnapshot(item, panel);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to archive: ${msg}`);
    }
  }

  /**
   * Delete flow — irreversible hard delete (axiomcloud has no
   * soft-delete). Two-step confirm: warning modal, then a typed
   * confirmation requiring the user to type "delete #N" so an errant
   * Enter doesn't nuke a record.
   */
  private async deleteFlow(item: WorkItemInfo, panel: vscode.WebviewPanel): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      `Delete ${item.type} #${item.id}? This is permanent and cannot be undone.`,
      { modal: true },
      'Delete',
    );
    if (confirm !== 'Delete') { return; }

    const phrase = `delete #${item.id}`;
    const typed = await vscode.window.showInputBox({
      prompt: `Type "${phrase}" to confirm`,
      placeHolder: phrase,
      ignoreFocusOut: true,
    });
    if (typed?.trim() !== phrase) {
      vscode.window.showInformationMessage('VibeFlow: Delete cancelled');
      return;
    }

    try {
      if (item.type === 'todo') {
        await this.client.deleteTodo(item.id);
      } else {
        await this.client.deleteIssue(item.id);
      }
      this.workItemsProvider.refresh();
      vscode.window.showInformationMessage(`VibeFlow: Deleted ${item.type} #${item.id}`);
      panel.dispose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to delete: ${msg}`);
    }
  }

  /**
   * Upload an attachment via VS Code's native file picker. Two-step:
   * POST /assets/upload (multipart) → POST /attachments (link to work
   * item). 32 MB limit enforced server-side; we pre-check locally so the
   * user gets a friendly error before transferring bytes.
   */
  private async uploadAttachmentFlow(item: WorkItemInfo, panel: vscode.WebviewPanel): Promise<void> {
    const picks = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Attach',
      title: `Attach a file to ${item.type} #${item.id}`,
    });
    if (!picks || picks.length === 0) { return; }
    const filePath = picks[0].fsPath;

    let buffer: Buffer;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
      if (stat.size > 32 * 1024 * 1024) {
        vscode.window.showErrorMessage(`VibeFlow: file is ${(stat.size / 1024 / 1024).toFixed(1)} MB — server limit is 32 MB`);
        return;
      }
      buffer = fs.readFileSync(filePath);
    } catch (err) {
      vscode.window.showErrorMessage(`VibeFlow: could not read file — ${err}`);
      return;
    }

    const fileName = path.basename(filePath);
    const ext = path.extname(fileName).toLowerCase();
    // Best-effort content type from the extension; backend falls back
    // to application/octet-stream if we send blank.
    const contentType = MIME_BY_EXT[ext] ?? 'application/octet-stream';

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `VibeFlow: uploading ${fileName}…` },
        async () => {
          await this.client.uploadAttachment(item.type, item.id, buffer, fileName, contentType);
        },
      );
      vscode.window.showInformationMessage(`VibeFlow: Attached ${fileName}`);
      await this.refreshSnapshot(item, panel);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to upload: ${msg}`);
    }
  }

  /**
   * Detach a file from the work item. Confirmation modal — the
   * underlying asset is preserved (may be linked elsewhere), only the
   * link is removed.
   */
  private async deleteAttachmentFlow(
    item: WorkItemInfo,
    panel: vscode.WebviewPanel,
    attachmentId: number | undefined,
  ): Promise<void> {
    if (!attachmentId) { return; }
    const confirm = await vscode.window.showWarningMessage(
      `Detach this file from ${item.type} #${item.id}?`,
      { modal: true },
      'Detach',
    );
    if (confirm !== 'Detach') { return; }
    try {
      await this.client.deleteAttachment(attachmentId);
      vscode.window.showInformationMessage('VibeFlow: Attachment removed');
      await this.refreshSnapshot(item, panel);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to remove attachment: ${msg}`);
    }
  }

  /**
   * Boot the React webview bundle. Body data attributes carry the
   * initial work-item context so the panel renders header chrome
   * immediately on mount, before the first `snapshot` postMessage.
   *
   * Pattern matches DashboardPanel.renderHtml — same bundle, different
   * `data-vf-mode`. The previous hand-rolled inline HTML/JS (~400 lines)
   * is gone in favor of webview-ui/src/components/WorkItemView.tsx,
   * which wraps the description in <MarkdownRenderer> so GFM tables,
   * code highlighting, and the rest of the markdown surface render
   * properly.
   */
  private getHtml(webview: vscode.Webview, item: WorkItemInfo): string {
    const nonce = getNonce();
    const distUri = vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'assets', 'index.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'assets', 'index.css'));

    // Stamp the initial item context as a body data attribute. JSON-encoded
    // and HTML-escaped so embedded quotes / brackets can't break the
    // attribute parser. WorkItemView reads this on mount.
    const itemInfoJson = JSON.stringify(item)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
      style-src ${webview.cspSource} 'unsafe-inline';
      script-src 'nonce-${nonce}';
      font-src ${webview.cspSource};
      img-src ${webview.cspSource} data: https:;">
  <link rel="stylesheet" href="${styleUri}">
  <title>Work Item</title>
</head>
<body data-vf-mode="workitem" data-vf-item-info="${itemInfoJson}">
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const sub of this.pollSubs.values()) { sub.dispose(); }
    for (const panel of this.panels.values()) { panel.dispose(); }
    this.panels.clear();
    this.pollSubs.clear();
  }
}
