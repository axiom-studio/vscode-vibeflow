import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { getNonce } from '../../utils/nonce.js';
import type { VibeFlowClient } from '../../api/client.js';
import type { PRReviewFinding, PRReviewSummary } from '../../api/prReviewTypes.js';
import {
  assertNever,
  type PRReviewPageClientMessage,
  type PRReviewPageHostMessage,
} from '../../core/webviewMessages.js';
import { openWorkspaceRelativePath } from '../sessions/chatActions.js';
import { prReviewDisplayState } from './prReviewDisplayState.js';

/** Findings are paged by the server (max 100 per page); stop after this many. */
const MAX_FINDINGS = 500;

/**
 * Vera review panel for one pull request (#4040, design doc #627 §4.1):
 * state, rounds, the review cycle, Vera's summary and every finding, whose
 * location opens in the editor. One panel per review job; the viewType is
 * project-scoped (`vibeflow.prReview`), so a project switch closes it.
 * Data: GET pr-review-summaries/{job} + its findings (axiomcloud
 * handlers/vibeflow_pr_review_summaries.go).
 */
export class PRReviewPanel {
  private static readonly instances = new Map<string, PRReviewPanel>();
  private lastFetchAt = 0;
  /** The snapshot last posted to the webview; controls name it via `snapshot` and use its version/generation for CAS. */
  private shown: { summary: PRReviewSummary; token: string } | undefined;
  /** Bumped per load; only the latest load may post, so an earlier refresh never overwrites a newer one. */
  private loadSeq = 0;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly client: VibeFlowClient,
    private readonly projectId: number,
    private readonly jobId: string,
    private readonly prUrl: string | undefined,
  ) {}

  static open(extensionUri: vscode.Uri, client: VibeFlowClient, projectId: number, jobId: string, title: string, prUrl?: string): void {
    const existing = PRReviewPanel.instances.get(jobId);
    if (existing) {
      existing.panel.reveal();
      void existing.load();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'vibeflow.prReview',
      title,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'webview-ui', 'dist')],
      },
    );
    panel.iconPath = new vscode.ThemeIcon('git-pull-request');
    panel.webview.html = renderHtml(panel.webview, extensionUri, title);
    const instance = new PRReviewPanel(panel, client, projectId, jobId, prUrl);
    PRReviewPanel.instances.set(jobId, instance);
    instance.attach();
  }

  private attach(): void {
    this.panel.webview.onDidReceiveMessage((msg: PRReviewPageClientMessage) => this.handleMessage(msg));
    this.panel.onDidChangeViewState(e => {
      if (!e.webviewPanel.visible) { return; }
      if (Date.now() - this.lastFetchAt < 1000) { return; }
      void this.load();
    });
    this.panel.onDidDispose(() => {
      if (PRReviewPanel.instances.get(this.jobId) === this) {
        PRReviewPanel.instances.delete(this.jobId);
      }
    });
  }

  private async handleMessage(msg: PRReviewPageClientMessage): Promise<void> {
    switch (msg.type) {
      case 'prReviewLoad':
      case 'prReviewRefresh':
        await this.load();
        return;
      case 'prReviewOpenLocation':
        // Same guard as chat links: workspace-relative only, no escapes.
        await openWorkspaceRelativePath(msg.payload.path, msg.payload.line);
        return;
      case 'prReviewOpenPullRequest':
        if (this.prUrl) { await vscode.env.openExternal(vscode.Uri.parse(this.prUrl)); }
        return;
      case 'prReviewRequest':
      case 'prReviewControl':
      case 'prReviewRetryPublication':
      case 'prReviewFindingControl':
        await this.control(msg);
        return;
      default:
        assertNever(msg);
    }
  }

  /**
   * Run one control against the summary on screen. The server re-checks
   * permission and state (and refuses a stale version with 409 "Review
   * changed; refresh"), so the panel always reloads afterwards.
   */
  private async control(msg: Extract<PRReviewPageClientMessage, { type: 'prReviewRequest' | 'prReviewControl' | 'prReviewRetryPublication' | 'prReviewFindingControl' }>): Promise<void> {
    if (!this.shown || msg.snapshot !== this.shown.token) {
      // The user acted on a snapshot that a newer one has already replaced.
      vscode.window.showWarningMessage('VibeFlow: this review changed while you were looking at it. Check the refreshed review and try again.');
      await this.load();
      return;
    }
    const summary = this.shown.summary;
    const job = summary.review;
    const request_id = randomUUID();
    try {
      switch (msg.type) {
        case 'prReviewRequest':
          await this.client.requestPRReview(this.projectId, { provider: job.provider, repository_link_id: job.repository_link_id, number: job.number, request_id });
          vscode.window.showInformationMessage(`VibeFlow: review requested for #${job.number}.`);
          break;
        case 'prReviewControl':
          await this.client.controlPRReview(this.projectId, job.id, {
            request_id, expected_version: job.version, action: msg.payload.action,
            additional_rounds: msg.payload.action === 'pause' ? 0 : msg.payload.additionalRounds, reason: msg.payload.reason,
          });
          vscode.window.showInformationMessage(`VibeFlow: review ${msg.payload.action === 'pause' ? 'paused' : 'continued'} for #${job.number}.`);
          break;
        case 'prReviewRetryPublication':
          if (!summary.publication) { return; }
          await this.client.retryPRReviewPublication(this.projectId, job.id, { request_id, expected_generation: summary.publication.generation });
          vscode.window.showInformationMessage(`VibeFlow: PR update retried for #${job.number}.`);
          break;
        case 'prReviewFindingControl':
          await this.client.controlPRReviewFinding(this.projectId, job.id, msg.payload.findingId, {
            request_id, expected_version: job.version, action: msg.payload.action, reason: msg.payload.reason,
            ...(msg.payload.action === 'reopen' ? { evidence: msg.payload.evidence ?? '' } : {}),
          });
          break;
        default:
          assertNever(msg);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`VibeFlow: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.load();
  }

  private async load(): Promise<void> {
    this.lastFetchAt = Date.now();
    const seq = ++this.loadSeq;
    try {
      const summary = await this.client.getPRReviewSummary(this.projectId, this.jobId);
      const findings: PRReviewFinding[] = [];
      let after = '';
      do {
        const page = await this.client.listPRReviewFindings(this.projectId, this.jobId, after, 100);
        findings.push(...page.items);
        after = page.nextAfterId;
      } while (after && findings.length < MAX_FINDINGS);
      if (seq !== this.loadSeq) { return; }
      // The token must be unique per post: two loads in the same millisecond must not share one.
      const generatedAt = `${new Date().toISOString()}#${seq}`;
      this.shown = { summary, token: generatedAt };
      this.post({
        type: 'prReviewData',
        payload: { summary, findings, findingsTruncated: !!after, display: prReviewDisplayState(summary), generatedAt },
      });
    } catch (err) {
      if (seq !== this.loadSeq) { return; }
      this.post({ type: 'prReviewError', payload: { message: err instanceof Error ? err.message : String(err) } });
    }
  }

  private post(msg: PRReviewPageHostMessage): void {
    void this.panel.webview.postMessage(msg);
  }
}

function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri, title: string): string {
  const distUri = vscode.Uri.joinPath(extensionUri, 'webview-ui', 'dist');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'assets', 'index.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'assets', 'index.css'));
  const nonce = getNonce();
  const safeTitle = title.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
      style-src ${webview.cspSource} 'unsafe-inline';
      script-src 'nonce-${nonce}';
      font-src ${webview.cspSource};">
  <link rel="stylesheet" href="${styleUri}">
  <title>${safeTitle}</title>
</head>
<body data-vf-mode="prReview">
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
