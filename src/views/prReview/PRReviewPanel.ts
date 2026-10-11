import * as vscode from 'vscode';
import { getNonce } from '../../utils/nonce.js';
import type { VibeFlowClient } from '../../api/client.js';
import type { PRReviewFinding } from '../../api/prReviewTypes.js';
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
      default:
        assertNever(msg);
    }
  }

  private async load(): Promise<void> {
    this.lastFetchAt = Date.now();
    try {
      const summary = await this.client.getPRReviewSummary(this.projectId, this.jobId);
      const findings: PRReviewFinding[] = [];
      let after = '';
      do {
        const page = await this.client.listPRReviewFindings(this.projectId, this.jobId, after, 100);
        findings.push(...page.items);
        after = page.nextAfterId;
      } while (after && findings.length < MAX_FINDINGS);
      this.post({
        type: 'prReviewData',
        payload: {
          summary,
          findings,
          findingsTruncated: !!after,
          display: prReviewDisplayState(summary),
          generatedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
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
