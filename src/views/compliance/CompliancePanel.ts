import * as vscode from 'vscode';
import { getNonce } from '../../utils/nonce.js';
import type { VibeFlowClient } from '../../api/client.js';
import type { PollingCoordinator, Disposer } from '../../core/PollingCoordinator.js';
import type { VibeFlowComplianceFinding } from '../../api/types.js';
import {
  assertNever,
  type ComplianceClientMessage,
  type ComplianceHostMessage,
} from '../../core/webviewMessages.js';

// Framework constants moved to `./complianceFrameworks` so the webview
// can share the same source of truth without dragging `vscode` into the
// browser bundle. Re-export here to keep host call sites unchanged.
import {
  COMPLIANCE_FRAMEWORKS,
  FRAMEWORK_LABEL,
  type ComplianceFramework,
} from './complianceFrameworks.js';
export { COMPLIANCE_FRAMEWORKS, FRAMEWORK_LABEL, type ComplianceFramework };

/**
 * Snapshot pushed every poll cycle. Single source of truth for the
 * Compliance view. Built from `listComplianceFindings` for the findings
 * + parallel `listTodosByProject` / `listIssues` calls (both filtered to
 * `status=done`) for the Items Reviewed / Awaiting Review rollup —
 * matches axiomcloud studio's top-stats row.
 *
 * Soft-fails: any individual fetch can degrade to defaults; the UI
 * surfaces the partial-data banner instead of blanking.
 */
export interface ComplianceSnapshot {
  projectId: number;
  projectName: string;
  generatedAt: string;
  /** All findings for the project — webview filters client-side. */
  findings: VibeFlowComplianceFinding[];
  /** Per-framework rollups (all 7 supported frameworks, even when 0). */
  summary: Record<ComplianceFramework, FrameworkSummary>;
  /** Project-wide rollup mirroring axiomcloud studio's top-stats row. */
  topStats: TopStats;
  /** Soft-failures from a degraded fetch. */
  errors: string[];
}

export interface TopStats {
  /** Total findings across the project. */
  total: number;
  /** Findings with effective_status === 'open'. */
  open: number;
  /** Findings with effective_status ∈ {resolved, accepted_risk}. */
  resolved: number;
  /** Findings whose severity is critical or high AND status is open. */
  high: number;
  /** Done work-items with security_reviewed === true. */
  items_reviewed: number;
  /** Done work-items with security_reviewed === false — the QA queue. */
  awaiting_review: number;
}

export interface FrameworkSummary {
  framework: ComplianceFramework;
  label: string;
  total: number;
  open: number;
  in_progress: number;
  resolved: number;
  accepted_risk: number;
}

const POLL_INTERVAL_MS = 30_000;

/**
 * Compliance findings dashboard. Mirrors `DashboardPanel.ts` shape
 * (singleton per window; reveal-on-reopen; 30s background poll).
 *
 * V1 is read-only: browse + filter + click-a-row to open the parent
 * work-item panel. Resolve / accept / tag-edit are deferred — see
 * non-goals in todo #1671.
 */
export class CompliancePanel {
  private static instance: CompliancePanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private pollSub: Disposer | undefined;
  // Same throttle pattern as DashboardPanel — dedupe the mount-time
  // `complianceLoad` against the panel's "became visible" event.
  private lastFetchAt = 0;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly client: VibeFlowClient,
    private readonly projectId: number,
    private readonly projectName: string,
    private readonly coordinator: PollingCoordinator,
  ) {
    this.panel = panel;
  }

  static open(
    extensionUri: vscode.Uri,
    client: VibeFlowClient,
    projectId: number,
    projectName: string,
    coordinator: PollingCoordinator,
  ): void {
    if (CompliancePanel.instance) {
      CompliancePanel.instance.panel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'vibeflow.compliance',
      `VibeFlow Compliance — ${projectName}`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'webview-ui', 'dist')],
      },
    );

    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'vibeflow-icon.svg');
    panel.webview.html = renderHtml(panel.webview, extensionUri);

    const instance = new CompliancePanel(panel, client, projectId, projectName, coordinator);
    CompliancePanel.instance = instance;
    instance.attach();
  }

  private attach(): void {
    this.panel.webview.onDidReceiveMessage((msg: ComplianceClientMessage) => this.handleMessage(msg));
    this.panel.onDidChangeViewState(e => {
      if (!e.webviewPanel.visible) { return; }
      if (Date.now() - this.lastFetchAt < 1000) { return; }
      void this.sendSnapshot();
    });
    this.panel.onDidDispose(() => this.dispose());
  }

  private async handleMessage(msg: ComplianceClientMessage): Promise<void> {
    switch (msg.type) {
      case 'complianceLoad':
        await this.sendSnapshot();
        this.startPolling();
        return;
      case 'complianceRefresh':
        await this.sendSnapshot();
        return;
      case 'complianceOpenWorkItem': {
        // The webview emits this when the user clicks a finding row.
        // Defensive-parse: only `todo`/`issue` are valid; reject
        // anything else so a malformed snapshot can't escape into a
        // command dispatch with an arbitrary string.
        const type = msg.payload.workItemType;
        if (type !== 'todo' && type !== 'issue') { return; }
        const id = msg.payload.workItemId;
        if (!Number.isFinite(id) || id <= 0) { return; }
        // openWorkItemPanel takes positional (nodeId, label?, description?)
        // where nodeId follows the tree-item shape "{type}-{id}". We
        // don't have a finding-side title to pass, so the panel will
        // resolve its own.
        await vscode.commands.executeCommand(
          'vibeflow.openWorkItemPanel',
          `${type}-${id}`,
          '',
          '',
        );
        return;
      }
      case 'complianceExportCsv': {
        await this.exportCsv(msg.payload.rows, msg.payload.defaultName);
        return;
      }
      default:
        assertNever(msg);
    }
  }

  /**
   * Save the webview-built CSV via `vscode.window.showSaveDialog` +
   * `workspace.fs.writeFile`. Builds the CSV server-side from the
   * pre-tokenized `rows` payload so we control the line-ending +
   * encoding policy in one place. Excel-compatible: UTF-8 BOM + CRLF.
   *
   * The webview's payload is fully untrusted; we sanitize cell content
   * for CSV-injection safety (leading `=`, `+`, `-`, `@` get a single-
   * quote prefix per OWASP guidance) before writing.
   */
  private async exportCsv(rows: string[][], defaultName: string): Promise<void> {
    if (!Array.isArray(rows) || rows.length === 0) {
      vscode.window.showInformationMessage('VibeFlow: nothing to export.');
      return;
    }
    const safeName = defaultName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'compliance.csv';
    const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri
      ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, safeName)
      : vscode.Uri.file(safeName);
    const target = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { 'CSV': ['csv'] },
      saveLabel: 'Export findings',
    });
    if (!target) { return; }

    const csv = '﻿' + rows.map(r => r.map(escapeCsvCell).join(',')).join('\r\n');
    try {
      await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(csv));
      vscode.window.showInformationMessage(`VibeFlow: exported ${rows.length - 1} findings to ${target.fsPath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`VibeFlow: CSV export failed — ${msg}`);
    }
  }

  private async sendSnapshot(): Promise<void> {
    this.lastFetchAt = Date.now();
    try {
      const snapshot = await composeSnapshot(this.client, this.projectId, this.projectName);
      this.postToWebview({ type: 'complianceData', payload: snapshot });
    } catch (err) {
      this.postToWebview({
        type: 'complianceError',
        payload: { message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  private postToWebview(msg: ComplianceHostMessage): void {
    this.panel.webview.postMessage(msg);
  }

  private startPolling(): void {
    if (this.pollSub) { return; }
    this.pollSub = this.coordinator.subscribe(POLL_INTERVAL_MS, () => {
      if (this.panel.visible) { void this.sendSnapshot(); }
    }, 'compliance');
  }

  private dispose(): void {
    this.pollSub?.dispose();
    this.pollSub = undefined;
    if (CompliancePanel.instance === this) {
      CompliancePanel.instance = undefined;
    }
  }
}

/**
 * Compose the snapshot in three parallel REST round-trips. The findings
 * list comes with `compliance_tags` embedded per row, so no separate
 * tag fetch. We also pull done todos + done issues to compute the
 * "Items Reviewed / Awaiting Review" top-stat row that axiomcloud's
 * studio shows — mirrors `DashboardPanel.composeSnapshot`'s pattern
 * for the QA queue.
 *
 * We fetch ALL statuses (no filter) so the webview can render the
 * resolved/accepted breakdowns. Soft-fails to empty lists with the
 * error captured in `errors[]` so the UI shows the banner instead of
 * blanking — same shape as the dashboard.
 */
async function composeSnapshot(
  client: VibeFlowClient,
  projectId: number,
  projectName: string,
): Promise<ComplianceSnapshot> {
  const errors: string[] = [];

  const [findingsR, doneTodosR, doneIssuesR] = await Promise.allSettled([
    client.listComplianceFindings(projectId),
    client.listTodosByProject(projectId, { status: 'done' }),
    client.listIssues(projectId, { status: 'done' }),
  ]);

  const findings: VibeFlowComplianceFinding[] = findingsR.status === 'fulfilled'
    ? findingsR.value
    : (errors.push(`findings: ${describeRejection(findingsR.reason)}`), []);
  const doneTodos = doneTodosR.status === 'fulfilled' ? doneTodosR.value : [];
  const doneIssues = doneIssuesR.status === 'fulfilled' ? doneIssuesR.value : [];
  if (doneTodosR.status === 'rejected') {
    errors.push(`done_todos: ${describeRejection(doneTodosR.reason)}`);
  }
  if (doneIssuesR.status === 'rejected') {
    errors.push(`done_issues: ${describeRejection(doneIssuesR.reason)}`);
  }

  return {
    projectId,
    projectName,
    generatedAt: new Date().toISOString(),
    findings,
    summary: buildSummary(findings),
    topStats: buildTopStats(findings, doneTodos, doneIssues),
    errors,
  };
}

function describeRejection(reason: unknown): string {
  if (reason instanceof Error) { return reason.message; }
  return String(reason);
}

/**
 * Per-framework rollup. A single finding can carry multiple framework
 * tags (e.g. a SOC2 + ISO27001 control mapping), so we count it in
 * every framework it touches — that matches axiomcloud's tally.
 *
 * Findings without any `compliance_tags` are NOT counted in any
 * framework (they show up in totals + the un-filtered findings list
 * but don't inflate a specific framework's number).
 */
function buildSummary(findings: VibeFlowComplianceFinding[]): ComplianceSnapshot['summary'] {
  const init: ComplianceSnapshot['summary'] = {} as ComplianceSnapshot['summary'];
  for (const fw of COMPLIANCE_FRAMEWORKS) {
    init[fw] = {
      framework: fw,
      label: FRAMEWORK_LABEL[fw],
      total: 0, open: 0, in_progress: 0, resolved: 0, accepted_risk: 0,
    };
  }
  for (const f of findings) {
    const status = (f.effective_status ?? f.status ?? 'open').toLowerCase();
    const tags = f.compliance_tags ?? [];
    for (const tag of tags) {
      const fw = tag.framework as ComplianceFramework;
      if (!(fw in init)) { continue; }
      const bucket = init[fw];
      bucket.total++;
      if (status === 'open') { bucket.open++; }
      else if (status === 'in_progress') { bucket.in_progress++; }
      else if (status === 'resolved') { bucket.resolved++; }
      else if (status === 'accepted_risk') { bucket.accepted_risk++; }
    }
  }
  return init;
}

/**
 * Build the top-stats row mirroring axiomcloud studio's compliance
 * page (Total / Open / Resolved / High / Items Reviewed / Awaiting Review).
 *
 * - `total` / `open` / `resolved` come from the findings list directly.
 *   `resolved` includes `accepted_risk` so it matches axiomcloud's
 *   "closed enough" semantics.
 * - `high` counts severity-{critical,high} findings that are still open
 *   — this is the "live high-severity work" number, not a historical count.
 * - `items_reviewed` / `awaiting_review` use the `security_reviewed`
 *   flag on done todos+issues. `awaiting_review` is the per-project
 *   security-review queue; `items_reviewed` is everything cleared.
 */
function buildTopStats(
  findings: VibeFlowComplianceFinding[],
  doneTodos: Array<{ security_reviewed?: boolean }>,
  doneIssues: Array<{ security_reviewed?: boolean }>,
): TopStats {
  let total = 0; let open = 0; let resolved = 0; let high = 0;
  for (const f of findings) {
    total++;
    const status = (f.effective_status ?? f.status ?? 'open').toLowerCase();
    if (status === 'open') { open++; }
    else if (status === 'resolved' || status === 'accepted_risk') { resolved++; }
    if (status === 'open' && (f.severity === 'critical' || f.severity === 'high')) {
      high++;
    }
  }
  let items_reviewed = 0; let awaiting_review = 0;
  for (const t of [...doneTodos, ...doneIssues]) {
    if (t.security_reviewed === true) { items_reviewed++; }
    else if (t.security_reviewed === false) { awaiting_review++; }
  }
  return { total, open, resolved, high, items_reviewed, awaiting_review };
}

/**
 * RFC 4180 CSV cell escape + OWASP CSV-injection guard. The injection
 * guard prefixes a single quote to cells that start with `=`, `+`, `-`,
 * `@`, or tab/CR — Excel/Sheets would otherwise interpret these as
 * formulas, which a malicious finding payload could weaponise.
 */
function escapeCsvCell(raw: string): string {
  const s = (raw ?? '').replace(/\r?\n/g, ' ');
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  if (/[",\n\r]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const distUri = vscode.Uri.joinPath(extensionUri, 'webview-ui', 'dist');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'assets', 'index.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'assets', 'index.css'));
  const nonce = getNonce();
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
      img-src ${webview.cspSource} https: data:;">
  <link rel="stylesheet" href="${styleUri}">
  <title>Compliance</title>
</head>
<body data-vf-mode="compliance">
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
