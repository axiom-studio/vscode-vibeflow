import * as vscode from 'vscode';
import { getNonce } from '../../utils/nonce.js';
import type { VibeFlowClient } from '../../api/client.js';
import type {
  BranchReviewStatus,
  VibeFlowSession,
  VibeFlowSwimlaneResult,
  VibeFlowComplianceFinding,
  VibeFlowWorkSummary,
} from '../../api/types.js';
import type { DetectedProject } from '../../project/ProjectDetector.js';
import type { TerminalRegistry } from '../../sessions/TerminalRegistry.js';

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
  personaStatus: Record<string, PersonaStatus>;
  sessions: { active: number; stale: number; total: number };
  todos: { done: number; in_progress: number; ready: number; planning: number; in_review: number };
  issues: { done: number; open: number };
  workSummary: { total_commits: number; lines_added: number; lines_deleted: number; total_seconds: number } | undefined;
  branchReview: BranchReviewStatus | undefined;
  findings: { critical: number; high: number; medium: number; low: number; informational: number; total_open: number };
  errors: string[];
}

interface DashboardLoadMessage { type: 'dashboardLoad' }
interface DashboardRefreshMessage { type: 'dashboardRefresh' }
interface DashboardFocusPersonaMessage {
  type: 'dashboardFocusPersona';
  payload: { personaKey: string };
}
interface DashboardOpenSidebarMessage { type: 'dashboardOpenSidebar' }

type DashboardInbound =
  | DashboardLoadMessage
  | DashboardRefreshMessage
  | DashboardFocusPersonaMessage
  | DashboardOpenSidebarMessage;

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
  ) {
    this.panel = panel;
  }

  static open(
    extensionUri: vscode.Uri,
    client: VibeFlowClient,
    project: DetectedProject,
    terminalRegistry: TerminalRegistry,
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

    const instance = new DashboardPanel(panel, client, project, terminalRegistry);
    DashboardPanel.instance = instance;
    instance.attach();
  }

  private attach(): void {
    this.panel.webview.onDidReceiveMessage((msg: DashboardInbound) => this.handleMessage(msg));
    this.panel.onDidDispose(() => this.dispose());
  }

  private async handleMessage(msg: DashboardInbound): Promise<void> {
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
    }
  }

  private async sendSnapshot(): Promise<void> {
    try {
      const snapshot = await composeSnapshot(this.client, this.project);
      this.panel.webview.postMessage({ type: 'dashboardData', payload: snapshot });
    } catch (err) {
      this.panel.webview.postMessage({
        type: 'dashboardError',
        payload: { message: err instanceof Error ? err.message : String(err) },
      });
    }
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
 * Fetch the 5 data sources in parallel and fold them into a flat snapshot.
 * Each source is wrapped in `Promise.allSettled` so a single failing endpoint
 * doesn't blank the whole dashboard.
 */
async function composeSnapshot(
  client: VibeFlowClient,
  project: DetectedProject,
): Promise<DashboardSnapshot> {
  const errors: string[] = [];

  const [sessionsR, swimR, summaryR, branchR, findingsR] = await Promise.allSettled([
    client.listSessions(project.projectId),
    client.getSwimlane(),
    client.getWorkSummary(project.projectId),
    client.checkBranchReviewStatus(project.projectId, project.gitBranch),
    client.listComplianceFindings(project.projectId, { status: 'open' }),
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

  return {
    projectId: project.projectId,
    projectName: project.projectName,
    branch: project.gitBranch,
    generatedAt: new Date().toISOString(),
    personaStatus: derivePersonaStatus(sessions),
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
      font-src ${webview.cspSource};">
  <link rel="stylesheet" href="${styleUri}">
  <title>Dashboard</title>
</head>
<body data-vf-mode="dashboard">
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
