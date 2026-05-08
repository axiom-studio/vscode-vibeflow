import * as vscode from 'vscode';
import { getNonce } from '../../utils/nonce.js';
import type { VibeFlowClient } from '../../api/client.js';
import type {
  BranchReviewStatus,
  VibeFlowSession,
  VibeFlowSwimlaneItem,
  VibeFlowSwimlaneResult,
  VibeFlowComplianceFinding,
  VibeFlowWorkSummary,
} from '../../api/types.js';
import type { DetectedProject } from '../../project/ProjectDetector.js';
import type { TerminalRegistry } from '../../sessions/TerminalRegistry.js';
import type { ContextProxy } from '../../core/ContextProxy.js';
import { assertNever, type DashboardClientMessage, type DashboardHostMessage } from '../../core/webviewMessages.js';

/** Persona keys that drive the topology nodes. */
export const DASHBOARD_PERSONAS = [
  'product_manager',
  'architect',
  'developer',
  'principal_engineer',
  'qa_lead',
  'security_lead',
  'ux_designer',
  'project_manager',
  'customer',
] as const;

type PersonaKey = typeof DASHBOARD_PERSONAS[number];
type PersonaStatus = 'active' | 'stale' | 'inactive';

interface DashboardSnapshot {
  projectId: number;
  projectName: string;
  branch: string;
  generatedAt: string;
  /**
   * Server origin (no trailing slash) so the webview can build absolute
   * URLs for assets it loads itself — currently the persona avatar JPGs
   * served from `{serverUrl}/persona/professional/{Char}_{Role}.jpg`.
   */
  serverUrl: string;
  /**
   * User-customized topology node positions for this project, if any.
   * `undefined` (or a missing key) means "use PERSONA_POSITIONS default."
   * Persisted via ContextProxy under `vibeflow.dashboard.nodePositions`
   * keyed by projectId; written on drag-stop, cleared on "Reset layout."
   */
  nodePositions: Record<string, { x: number; y: number }> | undefined;
  personaStatus: Record<string, PersonaStatus>;
  /**
   * How many work items are currently waiting for each persona to act.
   * Routing follows the status-to-persona table in
   * axiomcloud/docs/VibeFlow/docs/personas.md §"Work Item Routing".
   *
   * Code agents (architect, developer, principal_engineer) share a single
   * queue and report the same number — only one of them can run on a
   * branch at a time, so the queue is logically shared.
   *
   * QA Lead is an upper bound: swimlane wire shape carries `security_reviewed`
   * but not `qa_verified`, so we count `done && security_reviewed=true`,
   * which overcounts items already QA-verified. Backend follow-up to extend
   * VibeflowSwimlaneItem at axiomcloud/database/vibeflow_models.go:830-845.
   */
  personaQueues: Record<string, number | null>;
  sessions: { active: number; stale: number; total: number };
  todos: { done: number; in_progress: number; ready: number; planning: number; in_review: number };
  issues: { done: number; open: number };
  workSummary: { total_commits: number; lines_added: number; lines_deleted: number; total_seconds: number } | undefined;
  branchReview: BranchReviewStatus | undefined;
  findings: { critical: number; high: number; medium: number; low: number; informational: number; total_open: number };
  errors: string[];
}

// Canonical message types live in src/core/webviewMessages.ts.

const POLL_INTERVAL_MS = 30_000;

/**
 * Mission-control style dashboard. Composes a snapshot from 5 parallel API
 * calls and posts it to the webview. Singleton (one panel per window).
 */
export class DashboardPanel {
  private static instance: DashboardPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly client: VibeFlowClient,
    private readonly project: DetectedProject,
    private readonly terminalRegistry: TerminalRegistry,
    private readonly contextProxy: ContextProxy,
  ) {
    this.panel = panel;
  }

  static open(
    extensionUri: vscode.Uri,
    client: VibeFlowClient,
    project: DetectedProject,
    terminalRegistry: TerminalRegistry,
    contextProxy: ContextProxy,
  ): void {
    if (DashboardPanel.instance) {
      DashboardPanel.instance.panel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'vibeflow.dashboard',
      `VibeFlow Dashboard — ${project.projectName}`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'webview-ui', 'dist')],
      },
    );

    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'vibeflow-icon.svg');
    panel.webview.html = renderHtml(panel.webview, extensionUri);

    const instance = new DashboardPanel(panel, client, project, terminalRegistry, contextProxy);
    DashboardPanel.instance = instance;
    instance.attach();
  }

  private attach(): void {
    this.panel.webview.onDidReceiveMessage((msg: DashboardClientMessage) => this.handleMessage(msg));
    this.panel.onDidDispose(() => this.dispose());
  }

  private async handleMessage(msg: DashboardClientMessage): Promise<void> {
    switch (msg.type) {
      case 'dashboardLoad':
        await this.sendSnapshot();
        this.startPolling();
        return;
      case 'dashboardRefresh':
        await this.sendSnapshot();
        return;
      case 'dashboardFocusPersona': {
        const key = msg.payload.personaKey;
        if (!isPersonaKey(key)) {
          vscode.window.showWarningMessage(`VibeFlow: unknown persona "${key}".`);
          return;
        }
        const found = this.terminalRegistry.focus(key, this.project.gitBranch);
        if (!found) {
          vscode.window.showInformationMessage(
            `VibeFlow: No local terminal for ${key} on ${this.project.gitBranch}. Launch a session first.`,
          );
        }
        return;
      }
      case 'dashboardOpenSidebar':
        vscode.commands.executeCommand('vibeflow.agentFleet.focus');
        return;
      case 'dashboardSaveNodePositions':
        await this.saveNodePositions(msg.payload.positions);
        return;
      case 'dashboardResetNodePositions':
        await this.resetNodePositions();
        // Re-push so the webview re-mounts with default coordinates.
        await this.sendSnapshot();
        return;
      default:
        assertNever(msg);
    }
  }

  /**
   * Merge the just-dragged positions into the per-project map and write back.
   * Webview sends the FULL position map on each drag-stop so we can simply
   * overwrite this project's slot — no need to diff.
   */
  private async saveNodePositions(
    positions: Record<string, { x: number; y: number }>,
  ): Promise<void> {
    const all = this.contextProxy.get('vibeflow.dashboard.nodePositions') ?? {};
    all[String(this.project.projectId)] = positions;
    await this.contextProxy.set('vibeflow.dashboard.nodePositions', all);
  }

  private async resetNodePositions(): Promise<void> {
    const all = this.contextProxy.get('vibeflow.dashboard.nodePositions');
    if (!all) { return; }
    delete all[String(this.project.projectId)];
    await this.contextProxy.set('vibeflow.dashboard.nodePositions', all);
  }

  private async sendSnapshot(): Promise<void> {
    try {
      const stored = this.contextProxy.get('vibeflow.dashboard.nodePositions');
      const nodePositions = stored?.[String(this.project.projectId)];
      const snapshot = await composeSnapshot(
        this.client,
        this.project,
        nodePositions,
      );
      this.postToWebview({ type: 'dashboardData', payload: snapshot });
    } catch (err) {
      this.postToWebview({
        type: 'dashboardError',
        payload: { message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  /** Typed wrapper so a future drift between host and webview unions fails the compile. */
  private postToWebview(msg: DashboardHostMessage): void {
    this.panel.webview.postMessage(msg);
  }

  private startPolling(): void {
    if (this.pollTimer) { return; }
    this.pollTimer = setInterval(() => {
      if (this.panel.visible) { void this.sendSnapshot(); }
    }, POLL_INTERVAL_MS);
  }

  private dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (DashboardPanel.instance === this) {
      DashboardPanel.instance = undefined;
    }
  }
}

function isPersonaKey(s: string): s is PersonaKey {
  return (DASHBOARD_PERSONAS as readonly string[]).includes(s);
}

/**
 * Fetch the data sources in parallel and fold them into a flat snapshot.
 * Each source is wrapped in `Promise.allSettled` so a single failing endpoint
 * doesn't blank the whole dashboard.
 *
 * The `done*ForQA` calls fetch full work-item rows so we can compute
 * "pending QA" client-side — the swimlane wire shape carries
 * `security_reviewed` but NOT `qa_verified`, so it can't tell us which
 * already-reviewed items are still waiting for QA. Backend follow-up to
 * extend `VibeflowSwimlaneItem` would let us drop these two extra calls.
 */
async function composeSnapshot(
  client: VibeFlowClient,
  project: DetectedProject,
  nodePositions: Record<string, { x: number; y: number }> | undefined,
): Promise<DashboardSnapshot> {
  const errors: string[] = [];

  const [sessionsR, swimR, summaryR, branchR, findingsR, doneTodosR, doneIssuesR] = await Promise.allSettled([
    client.listSessions(project.projectId),
    client.getSwimlane(),
    client.getWorkSummary(project.projectId),
    client.checkBranchReviewStatus(project.projectId, project.gitBranch),
    client.listComplianceFindings(project.projectId, { status: 'open' }),
    client.listTodosByProject(project.projectId, { status: 'done' }),
    client.listIssues(project.projectId, { status: 'done' }),
  ]);

  const sessions: VibeFlowSession[] = sessionsR.status === 'fulfilled'
    ? sessionsR.value
    : (errors.push(`sessions: ${describeRejection(sessionsR.reason)}`), []);

  const swimlane: VibeFlowSwimlaneResult | undefined = swimR.status === 'fulfilled'
    ? swimR.value
    : (errors.push(`swimlane: ${describeRejection(swimR.reason)}`), undefined);

  const summary: VibeFlowWorkSummary | undefined = summaryR.status === 'fulfilled'
    ? summaryR.value
    : (errors.push(`work_summary: ${describeRejection(summaryR.reason)}`), undefined);

  const branchReview: BranchReviewStatus | undefined = branchR.status === 'fulfilled'
    ? branchR.value
    : (errors.push(`branch_review: ${describeRejection(branchR.reason)}`), undefined);

  const findings: VibeFlowComplianceFinding[] = findingsR.status === 'fulfilled'
    ? findingsR.value
    : (errors.push(`compliance: ${describeRejection(findingsR.reason)}`), []);

  // Pending-QA computation source — full rows carry `qa_verified`,
  // unlike the swimlane items. Failure here only collapses the QA
  // queue badge, not the rest of the dashboard.
  const doneTodos = doneTodosR.status === 'fulfilled' ? doneTodosR.value : [];
  const doneIssues = doneIssuesR.status === 'fulfilled' ? doneIssuesR.value : [];
  if (doneTodosR.status === 'rejected') { errors.push(`done_todos: ${describeRejection(doneTodosR.reason)}`); }
  if (doneIssuesR.status === 'rejected') { errors.push(`done_issues: ${describeRejection(doneIssuesR.reason)}`); }
  const qaQueueResolved = (doneTodosR.status === 'fulfilled' && doneIssuesR.status === 'fulfilled');
  const qaPending = qaQueueResolved
    ? countPendingQA(doneTodos) + countPendingQA(doneIssues)
    : null;

  return {
    projectId: project.projectId,
    projectName: project.projectName,
    branch: project.gitBranch,
    generatedAt: new Date().toISOString(),
    serverUrl: client.getBaseUrl(),
    nodePositions,
    personaStatus: derivePersonaStatus(sessions),
    personaQueues: tallyPersonaQueues(swimlane, project.projectId, qaPending),
    sessions: tallySessions(sessions),
    todos: tallyTodos(swimlane, project.projectId),
    issues: tallyIssues(swimlane, project.projectId),
    workSummary: summary
      ? {
        total_commits: summary.total_commits ?? 0,
        lines_added: summary.lines_added ?? 0,
        lines_deleted: summary.lines_deleted ?? 0,
        total_seconds: summary.total_seconds ?? 0,
      }
      : undefined,
    branchReview,
    findings: tallyFindings(findings),
    errors,
  };
}

/**
 * "Pending QA" = items already through Security but not yet QA-verified.
 * Both flags must be present and definite — undefined defaults to
 * "not the pending bucket" rather than guessing.
 */
function countPendingQA(items: Array<{ qa_verified?: boolean; security_reviewed?: boolean }>): number {
  let n = 0;
  for (const item of items) {
    if (item.security_reviewed === true && item.qa_verified === false) { n++; }
  }
  return n;
}

function describeRejection(reason: unknown): string {
  if (reason instanceof Error) { return reason.message; }
  return String(reason);
}

function derivePersonaStatus(sessions: VibeFlowSession[]): Record<string, PersonaStatus> {
  const result: Record<string, PersonaStatus> = {};
  for (const persona of DASHBOARD_PERSONAS) { result[persona] = 'inactive'; }
  for (const s of sessions) {
    const key = s.persona_key;
    if (!key) { continue; }
    // Fold the strongest status across multiple sessions for the same persona.
    const next: PersonaStatus = !s.active ? 'inactive' : (s.stale ? 'stale' : 'active');
    const prev = result[key];
    if (next === 'active') { result[key] = 'active'; }
    else if (next === 'stale' && prev !== 'active') { result[key] = 'stale'; }
    else if (!(key in result)) { result[key] = next; }
  }
  return result;
}

function tallySessions(sessions: VibeFlowSession[]): { active: number; stale: number; total: number } {
  let active = 0;
  let stale = 0;
  for (const s of sessions) {
    if (!s.active) { continue; }
    if (s.stale) { stale++; } else { active++; }
  }
  return { active, stale, total: DASHBOARD_PERSONAS.length };
}

/**
 * How many work items are waiting for each persona, derived from the
 * org-scoped swimlane filtered to this project. Counts include both
 * todos and issues (both flow through the same status pipeline).
 *
 * `null` for personas with no status-driven intake (project_manager is a
 * tracker; customer is an input source) — the webview renders "—" so
 * the user doesn't read a literal 0 as "queue is empty."
 */
function tallyPersonaQueues(
  swimlane: VibeFlowSwimlaneResult | undefined,
  projectId: number,
  qaPending: number | null,
): DashboardSnapshot['personaQueues'] {
  if (!swimlane) {
    return {
      product_manager: 0, architect: 0, developer: 0, principal_engineer: 0,
      security_lead: 0, qa_lead: qaPending ?? 0, ux_designer: 0,
      project_manager: null, customer: null,
    };
  }
  const inProject = (arr: VibeFlowSwimlaneItem[]) => arr.filter(i => i.project_id === projectId);

  const inReview = inProject(swimlane.in_review).length;
  const codeQueue = inProject(swimlane.planning).length
    + inProject(swimlane.ready_to_implement).length
    + inProject(swimlane.architecture_review_complete).length;
  const needsUx = inProject(swimlane.needs_ux_input).length;
  const doneItems = inProject(swimlane.done);
  const securityQueue = doneItems.filter(i => !i.security_reviewed).length;
  // qa_lead is computed in composeSnapshot from the project's full
  // done todos+issues (see countPendingQA) because the swimlane wire
  // shape doesn't expose qa_verified. `null` falls through when those
  // calls failed so the badge hides instead of showing 0.

  return {
    product_manager: inReview,
    architect: codeQueue,
    developer: codeQueue,
    principal_engineer: codeQueue,
    security_lead: securityQueue,
    qa_lead: qaPending,
    ux_designer: needsUx,
    project_manager: null,
    customer: null,
  };
}

function tallyTodos(
  swimlane: VibeFlowSwimlaneResult | undefined,
  projectId: number,
): DashboardSnapshot['todos'] {
  const tally = { done: 0, in_progress: 0, ready: 0, planning: 0, in_review: 0 };
  if (!swimlane) { return tally; }
  const filter = (arr: typeof swimlane.done) => arr.filter(i => i.project_id === projectId && i.type === 'todo').length;
  tally.done = filter(swimlane.done);
  tally.in_progress = filter(swimlane.implementing);
  tally.ready = filter(swimlane.ready_to_implement) + filter(swimlane.architecture_review_complete);
  tally.planning = filter(swimlane.planning) + filter(swimlane.needs_pm_input) + filter(swimlane.needs_ux_input);
  tally.in_review = filter(swimlane.in_review);
  return tally;
}

function tallyIssues(
  swimlane: VibeFlowSwimlaneResult | undefined,
  projectId: number,
): { done: number; open: number } {
  if (!swimlane) { return { done: 0, open: 0 }; }
  const all = [
    ...swimlane.in_review, ...swimlane.needs_pm_input, ...swimlane.needs_ux_input,
    ...swimlane.planning, ...swimlane.ready_to_implement, ...swimlane.architecture_review_complete,
    ...swimlane.implementing, ...swimlane.done,
  ];
  let done = 0;
  let open = 0;
  for (const i of all) {
    if (i.project_id !== projectId || i.type !== 'issue') { continue; }
    if (i.status === 'done') { done++; } else { open++; }
  }
  return { done, open };
}

function tallyFindings(findings: VibeFlowComplianceFinding[]): DashboardSnapshot['findings'] {
  const tally = { critical: 0, high: 0, medium: 0, low: 0, informational: 0, total_open: 0 };
  for (const f of findings) {
    // `effective_status` honours SLA grace windows; fall back to raw status.
    const status = (f.effective_status ?? f.status ?? '').toLowerCase();
    if (status !== 'open' && status !== 'in_progress') { continue; }
    tally.total_open++;
    switch (f.severity) {
      case 'critical': tally.critical++; break;
      case 'high': tally.high++; break;
      case 'medium': tally.medium++; break;
      case 'low': tally.low++; break;
      case 'informational': tally.informational++; break;
    }
  }
  return tally;
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
      img-src ${webview.cspSource} https: http: data:;">
  <link rel="stylesheet" href="${styleUri}">
  <title>Dashboard</title>
</head>
<body data-vf-mode="dashboard">
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
