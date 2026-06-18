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
import { flattenForProject, ALLOWED_PRIMARY_STATUSES, type KanbanCard } from '../kanban/kanbanData.js';

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

/**
 * The git-modifying personas — exactly ONE runs per branch (the lock holder,
 * per axiomcloud GitModifyingPersonas). Everyone else is a project-level
 * advisory persona. Drives the Live topology's branch-lane grouping.
 */
export const CODE_AGENT_PERSONAS = new Set<string>(['developer', 'architect', 'principal_engineer']);

type PersonaKey = typeof DASHBOARD_PERSONAS[number];
type PersonaStatus = 'active' | 'stale' | 'inactive';

/** One work item shown in a persona node's hover queue card. */
export interface PersonaQueueItem {
  id: number;
  type: 'todo' | 'issue';
  title: string;
  status: string;
  priority?: string;
}

/**
 * Live Agent Topology (feature 472, todo #2329). One RUNNING agent session as
 * the Live mode renders it — distinct from Explain mode's per-persona collapse.
 * Per-session, so concurrency (2 PMs, N branches each with their own code agent)
 * shows up instead of collapsing into one node.
 */
export interface LiveAgent {
  sessionId: string;
  personaKey: string;
  personaName: string;
  characterName?: string;
  avatarUrl?: string;
  branch: string;
  /** active ≤15m heartbeat · stale 15–30m (lock about to free) · dead otherwise. */
  liveness: 'active' | 'stale' | 'dead';
  lastMessage?: string;
  lastMessageAt?: string;
}
/** One git branch and the code agent(s) holding it (≤1 git-modifying per branch). */
export interface LiveBranch {
  branch: string;
  agents: LiveAgent[];
}
/** Live-mode snapshot: project-level advisory agents + per-branch code agents. */
export interface LiveSnapshot {
  advisory: LiveAgent[];
  branches: LiveBranch[];
  total: number;
}

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
   * QA Lead is computed exactly: the supplementary `done` todo/issue
   * fetches (which carry `qa_verified`, unlike the swimlane wire shape)
   * let us count items with `security_reviewed=true && qa_verified=false`.
   * If those calls fail, the value is `null` so the badge hides instead
   * of showing a misleading zero.
   */
  personaQueues: Record<string, number | null>;
  /**
   * The actual work items behind each persona's queue count, so the
   * dashboard can list them on hover. Built from the SAME data and the
   * SAME per-persona predicates as `personaQueues`, so a persona's list
   * length always equals its count (single source of truth). Keyed by
   * persona; advisory personas (project_manager/customer) are absent.
   */
  personaQueueItems: Record<string, PersonaQueueItem[]>;
  /**
   * Flattened todo/issue cards for the OPTIONAL embedded Kanban board
   * (rendered under the topology when the user toggles it on). Built from the
   * same swimlane composeSnapshot already fetches — no extra API call. The
   * standalone Kanban panel (KanbanPanel) is unaffected.
   */
  kanbanCards: KanbanCard[];
  sessions: { active: number; stale: number };
  /** Per-session, per-branch live view (Live topology mode). */
  live: LiveSnapshot;
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
 * Mission-control style dashboard. Composes a snapshot from 7 parallel API
 * calls and posts it to the webview. Singleton (one panel per window).
 *
 * The two extra calls beyond the original 5 are the `done` todo/issue
 * fetches that let us count pending-QA accurately (see personaQueues
 * docstring on DashboardSnapshot).
 */
export class DashboardPanel {
  private static instance: DashboardPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  // Suppress double-refresh in the very first second after `dashboardLoad`
  // — the webview fires it on mount, and the panel also reports a
  // visibility change as it becomes active. Without this guard we'd
  // round-trip 7 endpoints twice on open.
  private lastFetchAt = 0;
  // Trailing-edge debounce for nodePositions writes. The webview ships
  // the FULL position map on every drag-stop; rapid layout fiddling
  // shouldn't translate into one ContextProxy write per drag.
  private positionsWriteTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingPositions: Record<string, { x: number; y: number }> | undefined;

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
    // Refresh on regaining focus. The 30s interval already skips ticks
    // while hidden, but otherwise the user sees stale numbers for up to
    // 30s after returning to the tab. Throttle to avoid stacking with
    // the mount-time `dashboardLoad` request.
    this.panel.onDidChangeViewState(e => {
      if (!e.webviewPanel.visible) { return; }
      if (Date.now() - this.lastFetchAt < 1000) { return; }
      void this.sendSnapshot();
    });
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
          const choice = await vscode.window.showInformationMessage(
            `VibeFlow: No local terminal for ${key} on ${this.project.gitBranch}. Launch a session first.`,
            'Launch Session',
            'Refresh',
          );
          if (choice === 'Launch Session') {
            await vscode.commands.executeCommand('vibeflow.launchSession');
          } else if (choice === 'Refresh') {
            await this.sendSnapshot();
          }
        }
        return;
      }
      case 'dashboardOpenWorkItem': {
        // User clicked an item in a persona node's queue hover-card.
        // Defensive-parse (mirrors CompliancePanel): only todo/issue with a
        // positive id may reach the command dispatch.
        const type = msg.payload.workItemType;
        if (type !== 'todo' && type !== 'issue') { return; }
        const id = msg.payload.workItemId;
        if (!Number.isFinite(id) || id <= 0) { return; }
        // openWorkItemPanel takes positional (nodeId "{type}-{id}", label?, description?).
        await vscode.commands.executeCommand('vibeflow.openWorkItemPanel', `${type}-${id}`, '', '');
        return;
      }
      case 'dashboardKanbanMove': {
        // Drag on the embedded Kanban. Same validation as KanbanPanel: only
        // todo/issue with a valid target status + positive id reach the API.
        const { itemType, itemId, newStatus } = msg.payload;
        if (itemType !== 'todo' && itemType !== 'issue') { return; }
        if (!ALLOWED_PRIMARY_STATUSES.has(newStatus)) { await this.sendSnapshot(); return; }
        if (!Number.isFinite(itemId) || itemId <= 0) { await this.sendSnapshot(); return; }
        try {
          if (itemType === 'todo') {
            await this.client.updateTodoStatus(itemId, newStatus);
          } else {
            await this.client.updateIssueStatus(itemId, newStatus);
          }
        } catch (err) {
          vscode.window.showErrorMessage(`VibeFlow: Failed to move ${itemType} #${itemId} → ${newStatus} — ${err}`);
        }
        // Re-broadcast the server truth (claims / review gates may override).
        await this.sendSnapshot();
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
   *
   * Trailing-edge debounced (250ms) so rapid layout tuning collapses to a
   * single write. We hold the most recent map in `pendingPositions` and
   * flush via `flushPositions()` on the timer.
   */
  private async saveNodePositions(
    positions: Record<string, { x: number; y: number }>,
  ): Promise<void> {
    this.pendingPositions = positions;
    if (this.positionsWriteTimer) { clearTimeout(this.positionsWriteTimer); }
    this.positionsWriteTimer = setTimeout(() => { void this.flushPositions(); }, 250);
  }

  private async flushPositions(): Promise<void> {
    this.positionsWriteTimer = undefined;
    const positions = this.pendingPositions;
    if (!positions) { return; }
    this.pendingPositions = undefined;
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
    this.lastFetchAt = Date.now();
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
    if (this.positionsWriteTimer) {
      clearTimeout(this.positionsWriteTimer);
      this.positionsWriteTimer = undefined;
      // Flush any pending positions on close so a drag-then-immediately-
      // close doesn't drop the user's layout change.
      void this.flushPositions();
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

  // The items behind qa_lead's count — same strict predicate as
  // countPendingQA, sourced from the full done rows (the swimlane wire shape
  // lacks qa_verified). Empty when the done fetches failed (badge hides).
  const qaItems: PersonaQueueItem[] = qaQueueResolved
    ? [
      ...doneTodos
        .filter(i => i.security_reviewed === true && i.qa_verified === false)
        .map((i): PersonaQueueItem => ({ id: i.id, type: 'todo', title: i.title, status: i.status, priority: i.priority })),
      ...doneIssues
        .filter(i => i.security_reviewed === true && i.qa_verified === false)
        .map((i): PersonaQueueItem => ({ id: i.id, type: 'issue', title: i.title, status: i.status, priority: i.priority })),
    ]
    : [];

  return {
    projectId: project.projectId,
    projectName: project.projectName,
    branch: project.gitBranch,
    generatedAt: new Date().toISOString(),
    serverUrl: client.getBaseUrl(),
    nodePositions,
    personaStatus: derivePersonaStatus(sessions),
    personaQueues: tallyPersonaQueues(swimlane, project.projectId, qaPending),
    personaQueueItems: collectPersonaQueueItems(swimlane, project.projectId, qaItems),
    kanbanCards: swimlane ? flattenForProject(swimlane, project.projectId) : [],
    sessions: tallySessions(sessions),
    live: collectLiveSnapshot(sessions, client.getBaseUrl()),
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

/**
 * Build the Live-mode snapshot from the raw session list (feature 472). Code
 * agents (git-modifying) group into branch lanes; everyone else is a
 * project-level advisory agent. Only currently-relevant sessions (active OR
 * stale) are included — fully-dead sessions are dropped so the view stays live.
 */
function collectLiveSnapshot(sessions: VibeFlowSession[], serverUrl: string): LiveSnapshot {
  const toAgent = (s: VibeFlowSession): LiveAgent => ({
    sessionId: s.session_id,
    personaKey: s.persona_key,
    personaName: s.persona_name ?? s.persona_key,
    characterName: s.character_name,
    avatarUrl: s.avatar_path && serverUrl ? `${serverUrl}${s.avatar_path}` : undefined,
    branch: s.git_branch,
    liveness: s.active ? 'active' : (s.stale ? 'stale' : 'dead'),
    lastMessage: s.last_message,
    lastMessageAt: s.last_message_at,
  });

  const advisory: LiveAgent[] = [];
  const branchMap = new Map<string, LiveAgent[]>();
  let total = 0;
  for (const s of sessions) {
    if (!s.active && !s.stale) { continue; } // drop fully-dead sessions
    total++;
    const agent = toAgent(s);
    if (CODE_AGENT_PERSONAS.has(s.persona_key)) {
      const list = branchMap.get(s.git_branch) ?? [];
      list.push(agent);
      branchMap.set(s.git_branch, list);
    } else {
      advisory.push(agent);
    }
  }

  const branches: LiveBranch[] = [...branchMap.entries()]
    .map(([branch, agents]) => ({ branch, agents }))
    .sort((a, b) => a.branch.localeCompare(b.branch));

  return { advisory, branches, total };
}

function derivePersonaStatus(sessions: VibeFlowSession[]): Record<string, PersonaStatus> {
  const result: Record<string, PersonaStatus> = {};
  for (const persona of DASHBOARD_PERSONAS) { result[persona] = 'inactive'; }
  for (const s of sessions) {
    const key = s.persona_key;
    if (!key) { continue; }
    // Fold the strongest status across multiple sessions for the same persona.
    // 'inactive' is the initial value (set above for every persona key), so
    // we only need to upgrade — never downgrade.
    const next: PersonaStatus = !s.active ? 'inactive' : (s.stale ? 'stale' : 'active');
    const prev = result[key];
    if (next === 'active') { result[key] = 'active'; }
    else if (next === 'stale' && prev !== 'active') { result[key] = 'stale'; }
  }
  return result;
}

function tallySessions(sessions: VibeFlowSession[]): { active: number; stale: number } {
  // No "total" — there's no fixed cap on sessions. Multiple sessions per
  // persona are valid (e.g. two developer sessions on different
  // branches), so a "X / 9 personas" denominator misled users into
  // reading the card as "out of nine possible sessions."
  let active = 0;
  let stale = 0;
  for (const s of sessions) {
    if (!s.active) { continue; }
    if (s.stale) { stale++; } else { active++; }
  }
  return { active, stale };
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
export function tallyPersonaQueues(
  swimlane: VibeFlowSwimlaneResult | undefined,
  projectId: number,
  qaPending: number | null,
): DashboardSnapshot['personaQueues'] {
  if (!swimlane) {
    return {
      product_manager: 0, architect: 0, developer: 0, principal_engineer: 0,
      // qa_lead's count comes from a different pair of endpoints than
      // the swimlane, so it can still be valid even when the swimlane
      // failed. `null` means "those calls also failed" — let the badge
      // hide rather than render a misleading 0.
      security_lead: 0, qa_lead: qaPending, ux_designer: 0,
      project_manager: null, customer: null,
    };
  }
  // Every persona badge counts WORK ITEMS waiting on a human, so exclude
  // container rows (`feature`/`project`) the swimlane also carries — they
  // never flow through a persona's status pipeline. Without this, a feature
  // sitting in any status column inflates that persona's badge (e.g. a
  // `done` feature has `security_reviewed=null` and was counted as
  // "needs security review"). Mirrors the `i.type` guard already used by
  // `tallyTodos` / `tallyIssues`.
  const inProject = (arr: VibeFlowSwimlaneItem[]) =>
    arr.filter(i => i.project_id === projectId && (i.type === 'todo' || i.type === 'issue'));

  const inReview = inProject(swimlane.in_review).length;
  const codeQueue = inProject(swimlane.planning).length
    + inProject(swimlane.ready_to_implement).length
    + inProject(swimlane.architecture_review_complete).length;
  const needsUx = inProject(swimlane.needs_ux_input).length;
  const doneItems = inProject(swimlane.done);
  // Strict `=== false`: only definitely-unreviewed items count. `null`/
  // `undefined` (never entered review) must NOT count — parity with
  // `countPendingQA`'s strict equality.
  const securityQueue = doneItems.filter(i => i.security_reviewed === false).length;
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

/**
 * The work items behind each persona's queue count — same per-persona
 * predicates (and the same container-row exclusion) as `tallyPersonaQueues`,
 * so each list's length equals that persona's count. `qaItems` is supplied by
 * the caller because qa_lead membership needs `qa_verified`, which the
 * swimlane wire shape omits (it comes from the separate done-todo/issue
 * fetches in composeSnapshot).
 */
export function collectPersonaQueueItems(
  swimlane: VibeFlowSwimlaneResult | undefined,
  projectId: number,
  qaItems: PersonaQueueItem[],
): DashboardSnapshot['personaQueueItems'] {
  if (!swimlane) {
    return { qa_lead: qaItems };
  }
  const inProject = (arr: VibeFlowSwimlaneItem[]) =>
    arr.filter(i => i.project_id === projectId && (i.type === 'todo' || i.type === 'issue'));
  const toItem = (i: VibeFlowSwimlaneItem): PersonaQueueItem => ({
    id: i.id,
    type: i.type as 'todo' | 'issue',
    title: i.name,
    status: i.status,
    priority: i.priority,
  });

  // Shared across the three code agents by reference — they share one queue
  // (only one runs per branch), exactly as tallyPersonaQueues reports.
  const codeQueue = [
    ...inProject(swimlane.planning),
    ...inProject(swimlane.ready_to_implement),
    ...inProject(swimlane.architecture_review_complete),
  ].map(toItem);

  return {
    product_manager: inProject(swimlane.in_review).map(toItem),
    architect: codeQueue,
    developer: codeQueue,
    principal_engineer: codeQueue,
    security_lead: inProject(swimlane.done).filter(i => i.security_reviewed === false).map(toItem),
    qa_lead: qaItems,
    ux_designer: inProject(swimlane.needs_ux_input).map(toItem),
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
  // img-src includes http: because persona avatars are loaded from the
  // user's configured `vibeflow.serverUrl`, which can be
  // `http://localhost:*` / `http://127.0.0.1:*` for dev/self-hosted
  // setups. The serverUrl itself is gated by `validateServerUrl` at
  // activation + every REST request + MCP transport construction (HTTPS
  // required outside the loopback hosts), so the practical surface is
  // narrow — the snapshot's `serverUrl` is host-derived, never
  // webview-controlled. Tightening to `http://localhost:*` directly in
  // CSP isn't expressible without enumerating the user's port.
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
