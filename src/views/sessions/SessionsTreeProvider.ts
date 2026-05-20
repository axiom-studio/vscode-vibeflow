import * as vscode from 'vscode';
import type { VibeFlowClient } from '../../api/client.js';
import type { VibeFlowSession } from '../../api/types.js';
import { listWorktrees, type Worktree } from '../../commands/worktreeCommands.js';
import { getLiveTmuxSessions, buildTmuxName } from '../../sessions/tmuxState.js';

type NodeType = 'branch' | 'session' | 'pendingSession' | 'placeholder' | 'worktreeSection' | 'worktreeItem';

interface SessionNode {
  id: string;
  type: NodeType;
  label: string;
  description?: string;
  tooltip?: string | vscode.MarkdownString;
  iconId?: string;
  iconColor?: vscode.ThemeColor;
  collapsibleState: vscode.TreeItemCollapsibleState;
  children?: SessionNode[];
  contextValue?: string;
  session?: VibeFlowSession;
  worktree?: Worktree;
  /** Set on pending-session nodes so commands can route to the right handle. */
  pendingHandleId?: string;
}

/**
 * In-flight stream-json launch awaiting its first `session_init` event.
 * Surfaces in Agent Fleet as a "Starting…" or "Failed" row before the
 * server-side session record exists — without this, chat-first launches
 * gave the user zero visual feedback for 5-30s after clicking play.
 */
export interface PendingSession {
  handleId: string;
  personaKey: string;
  branch: string;
  /** 'starting' while we're waiting for session_init; 'failed' if the
   *  child exited before registering (binary missing, auth, MCP config). */
  state: 'starting' | 'failed';
  /** Captured stderr / exit reason — surfaced in the row tooltip. */
  failureMessage?: string;
  /** Ms timestamp the launch was kicked off, for elapsed-time display. */
  startedAt: number;
}

type SessionStatus = 'active' | 'stale' | 'inactive' | 'stalled' | 'ghost';

/**
 * Cap on how long a pending row may remain in `starting` before the
 * sweep in `fetchAndRefresh` flips it to `failed`. 120s is generous
 * enough for slow first-launches (CLI binary first-run auth, model
 * metadata fetch) and tight enough that a doomed launch (missing
 * binary, fake key, hung MCP handshake) doesn't sit visible for
 * minutes — Kevin's reported `(1009s)` failure mode is the bug.
 *
 * Independent of `polling.interval`: sweep runs on every refresh tick
 * so the actual UI transition fires within one polling cycle of the
 * threshold being crossed.
 */
const PENDING_STALL_THRESHOLD_MS = 120_000;

/**
 * Derive a display status from server-side `active`/`stale` flags PLUS
 * the optional local tmux probe.
 *
 * Backend-only states (used always):
 *   - `active: true, stale: false` → 'active'   (green, full heartbeat)
 *   - `active: true, stale: true`  → 'stale'    (yellow, heartbeat expired)
 *   - `active: false`              → 'inactive' (gray, no record on server)
 *
 * Cross-check states (used when CLI mode is on and we have a tmux probe):
 *   - tmux pane alive + backend inactive → 'stalled' — pane is up but the
 *     agent has stopped polling wait_for_work; this is the polling-contract
 *     violation case where the user sees "running per CLI but not in fleet"
 *   - tmux pane dead + backend active   → 'ghost'  — backend snapshot is
 *     stale; rare race after a kill
 */
function deriveStatus(
  s: VibeFlowSession,
  liveTmuxSessions: Set<string> | undefined,
): SessionStatus {
  // Decide the backend's view first.
  const backendActive = !!s.active;
  const backendStale = !!s.stale;

  // Without a tmux probe (CLI mode off, or tmux not available), fall
  // back to the legacy 3-state derivation.
  if (!liveTmuxSessions) {
    if (!backendActive) { return 'inactive'; }
    if (backendStale) { return 'stale'; }
    return 'active';
  }

  // Cross-check tmux pane liveness against the backend view.
  const tmuxAlive = liveTmuxSessions.has(buildTmuxName(s.agent_type ?? '', s.session_id));

  if (tmuxAlive && backendActive && !backendStale) { return 'active'; }
  if (tmuxAlive && backendActive && backendStale)  { return 'stale'; }
  if (tmuxAlive && !backendActive)                  { return 'stalled'; }
  if (!tmuxAlive && backendActive)                  { return 'ghost'; }
  return 'inactive';
}

const STATUS_ICONS: Record<SessionStatus, { icon: string; color: string; label: string }> = {
  active:   { icon: 'circle-filled',  color: 'testing.iconPassed',         label: 'running' },
  stale:    { icon: 'circle-filled',  color: 'editorWarning.foreground',   label: 'stale heartbeat' },
  inactive: { icon: 'circle-outline', color: 'disabledForeground',         label: 'inactive' },
  stalled:  { icon: 'warning',        color: 'editorWarning.foreground',   label: 'stalled — pane alive, no heartbeat' },
  ghost:    { icon: 'error',          color: 'errorForeground',            label: 'ghost — backend record but pane is dead' },
};

const PERSONA_LABELS: Record<string, string> = {
  developer: 'Developer',
  architect: 'Architect',
  principal_engineer: 'Principal Engineer',
  security_lead: 'Security Lead',
  qa_lead: 'QA Lead',
  product_manager: 'Product Manager',
  project_manager: 'Project Manager',
  ux_designer: 'UX Designer',
  customer: 'Customer',
};

/**
 * Agent Fleet TreeView — sessions grouped by branch with live data from
 * `/rest/v1/vibeflow/sessions/active?project_id=...` (axiomcloud REST).
 */
export class SessionsTreeProvider implements vscode.TreeDataProvider<SessionNode>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<SessionNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private client: VibeFlowClient | undefined;
  private projectId: number | undefined;
  private sessions: VibeFlowSession[] = [];
  /**
   * Last tmux probe — `undefined` when CLI mode is off (tells deriveStatus
   * to fall back to backend-only logic). When CLI mode is on, this is
   * refreshed every poll cycle and may legitimately be empty (no live
   * tmux sessions, or tmux unavailable — both render as "all panes dead").
   */
  private liveTmuxSessions: Set<string> | undefined;

  /**
   * Detected git branch for the current workspace, used by the empty-state
   * placeholder so we don't lie that there are zero sessions on `main`
   * when the user is sitting on `feature/foo`.
   */
  private currentBranch = 'main';

  setBranch(branch: string): void {
    if (branch && branch !== this.currentBranch) {
      this.currentBranch = branch;
      this._onDidChangeTreeData.fire();
    }
  }

  /**
   * Count of sessions that have a live heartbeat (active and not stale).
   * Used by the right-aligned work-summary status bar to show
   * "N agents · M ready" without re-fetching the session list.
   */
  getActiveSessionCount(): number {
    // Match the branch-row count: anything with a live presence
    // (backend OR local tmux pane in CLI mode).
    return this.sessions.filter(s => {
      const status = deriveStatus(s, this.liveTmuxSessions);
      return status === 'active' || status === 'stale' || status === 'stalled';
    }).length;
  }
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * Pending chat-first launches awaiting `session_init`. Surfaced as
   * "Starting…" rows in the tree so the user has visual confirmation that
   * a launch is in flight — without this, chat-first mode gave zero
   * feedback between click and the first session record landing
   * server-side (up to 30s, or never if the agent crashed before
   * registering).
   *
   * Entries are added by `addPending` from the launch path, dropped by
   * `clearPending` once the server-side session_init lands, or upgraded
   * in-place to `state: 'failed'` by `markFailed` when the child exits
   * before registering.
   */
  private pendingSessions = new Map<string, PendingSession>();
  // Session lookup by TreeItem id — needed because VSCode strips custom fields
  // from TreeItem arguments when passing to commands
  private sessionById = new Map<string, VibeFlowSession>();
  // Worktree lookup by TreeItem id, populated alongside the worktree section.
  // Same rationale as sessionById — context-menu commands receive only the
  // serialized id.
  private worktreeById = new Map<string, Worktree>();

  /**
   * Look up a session by its TreeItem id (e.g., "session-abc123").
   * Used by command handlers that receive serialized TreeItem arguments.
   */
  getSessionById(treeItemId: string): VibeFlowSession | undefined {
    return this.sessionById.get(treeItemId);
  }

  /**
   * Look up a worktree by its TreeItem id (`worktree::<path>`). Used by
   * the Open / Delete / Create-Session-Here context-menu commands.
   */
  getWorktreeById(treeItemId: string): Worktree | undefined {
    return this.worktreeById.get(treeItemId);
  }

  refresh(): void {
    this.fetchAndRefresh();
  }

  /**
   * Inject an optimistic "Starting…" row for a chat-first launch the
   * moment we spawn the agent child process. The row is replaced by the
   * real server-side session record once `session_init` lands.
   */
  addPending(info: { handleId: string; personaKey: string; branch: string }): void {
    this.pendingSessions.set(info.handleId, {
      handleId: info.handleId,
      personaKey: info.personaKey,
      branch: info.branch,
      state: 'starting',
      startedAt: Date.now(),
    });
    this._onDidChangeTreeData.fire();
  }

  /**
   * Upgrade a pending row to a "Failed" state with the captured stderr /
   * exit reason. Used when the agent child exits before emitting
   * `session_init` — keeping the row visible (vs. silently dropping it)
   * lets the user actually find the failure and open the output channel.
   */
  markFailed(handleId: string, failureMessage: string): void {
    const existing = this.pendingSessions.get(handleId);
    if (!existing) { return; }
    this.pendingSessions.set(handleId, {
      ...existing,
      state: 'failed',
      failureMessage,
    });
    this._onDidChangeTreeData.fire();
  }

  /**
   * Drop a pending row — called when the server-side session record for
   * this handle appears in `listSessions`, so the real session takes over.
   */
  clearPending(handleId: string): void {
    if (this.pendingSessions.delete(handleId)) {
      this._onDidChangeTreeData.fire();
    }
  }

  /**
   * Dismiss a pending row from its tree-node id (the form produced by
   * `buildPendingNode`, `pending-<handleId>`). Exposed for the
   * `vibeflow.dismissFailedPending` command so right-click → Dismiss
   * doesn't need to know the encoding.
   */
  dismissPendingByNodeId(nodeId: string): void {
    if (!nodeId.startsWith('pending-')) { return; }
    this.clearPending(nodeId.slice('pending-'.length));
  }

  /**
   * Snapshot the current pending entries. Used by command handlers
   * (e.g. dismiss-failed-pending) that need to enumerate failures.
   */
  getPendingSessions(): PendingSession[] {
    return Array.from(this.pendingSessions.values());
  }

  connect(client: VibeFlowClient, projectId: number): void {
    this.client = client;
    this.projectId = projectId;
    this.startPolling();
    this.fetchAndRefresh();
  }

  private startPolling(): void {
    this.stopPolling();
    const config = vscode.workspace.getConfiguration('vibeflow');
    const interval = config.get<number>('polling.interval', 30) * 1000;
    this.pollTimer = setInterval(() => this.fetchAndRefresh(), interval);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private async fetchAndRefresh(): Promise<void> {
    if (!this.client || !this.projectId) { return; }
    try {
      this.sessions = await this.client.listSessions(this.projectId);
    } catch {
      // API error — keep stale data, don't clear the tree
    }

    // Drop pending entries whose real server-side session has now landed.
    // This is the canonical "pending → real" transition: we hold the
    // "Starting…" row visible until listSessions actually contains the
    // new session, avoiding a flicker gap where session_init has fired
    // locally but the server hasn't published yet.
    for (const pending of this.pendingSessions.values()) {
      if (pending.state !== 'starting') { continue; }
      const realLanded = this.sessions.some(s =>
        s.persona_key === pending.personaKey
        && (s.git_branch || 'unknown') === pending.branch
        && s.active,
      );
      if (realLanded) {
        this.pendingSessions.delete(pending.handleId);
      }
    }

    // Stall sweep: any entry still `starting` past PENDING_STALL_THRESHOLD_MS
    // gets transitioned to `failed` with a synthesized reason. The child
    // process may still be alive (no exit event to trigger `markFailed`),
    // but if session_init hasn't landed by now it isn't going to. Without
    // this sweep the row counts up forever (the bug — see issue #2175).
    const now = Date.now();
    for (const pending of this.pendingSessions.values()) {
      if (pending.state !== 'starting') { continue; }
      if (now - pending.startedAt <= PENDING_STALL_THRESHOLD_MS) { continue; }
      this.pendingSessions.set(pending.handleId, {
        ...pending,
        state: 'failed',
        // Don't clobber a reason captured by `markFailed` if a child-exit
        // landed in the same tick — caller-supplied messages are richer
        // than this fallback.
        failureMessage: pending.failureMessage
          ?? `No session_init within ${PENDING_STALL_THRESHOLD_MS / 1000}s. Likely cause: missing CLI binary, invalid API key, or MCP startup failure. Check the VibeFlow: Agent Activity Output channel.`,
      });
    }

    // Probe local tmux only when CLI mode is on. The probe is sync but
    // tmux list-sessions on a non-server returns within milliseconds;
    // capped at 2s in the helper so a hung tmux server can't block the
    // poll loop. Outside CLI mode, set undefined so deriveStatus uses
    // the legacy 3-state path.
    const cliEnabled = vscode.workspace.getConfiguration('vibeflow').get<boolean>('cli.enabled', false);
    this.liveTmuxSessions = cliEnabled ? getLiveTmuxSessions() : undefined;

    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SessionNode): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label, element.collapsibleState);
    item.id = element.id;
    item.description = element.description;
    item.contextValue = element.contextValue;

    if (element.tooltip) { item.tooltip = element.tooltip; }
    if (element.iconId) {
      item.iconPath = new vscode.ThemeIcon(element.iconId, element.iconColor);
    }

    // Click a session node → open Session Panel (inspection view)
    // Pass only the string ID — non-serializable fields (ThemeColor, MarkdownString) break args
    if (element.type === 'session') {
      item.command = {
        command: 'vibeflow.openSessionPanel',
        title: 'View Session',
        arguments: [element.id],
      };
    }

    return item;
  }

  getChildren(element?: SessionNode): SessionNode[] {
    if (!element) { return this.buildTree(); }
    return element.children ?? [];
  }

  private buildTree(): SessionNode[] {
    this.sessionById.clear();
    this.worktreeById.clear();

    const hasAnyRow = this.sessions.length > 0 || this.pendingSessions.size > 0;
    const top: SessionNode[] = hasAnyRow
      ? this.buildSessionTree()
      : this.buildPlaceholderTree();

    const wtSection = this.buildWorktreeSection();
    if (wtSection) { top.push(wtSection); }

    return top;
  }

  private buildSessionTree(): SessionNode[] {
    // Group server sessions by branch.
    const byBranch = new Map<string, VibeFlowSession[]>();
    for (const s of this.sessions) {
      const branch = s.git_branch || 'unknown';
      const list = byBranch.get(branch) ?? [];
      list.push(s);
      byBranch.set(branch, list);
    }
    // Merge pending entries — they live under the same branch grouping
    // as real sessions, so a chat-first "Starting…" row appears right
    // where the real row will land once the agent registers.
    const pendingByBranch = new Map<string, PendingSession[]>();
    for (const p of this.pendingSessions.values()) {
      const branch = p.branch || 'unknown';
      const list = pendingByBranch.get(branch) ?? [];
      list.push(p);
      pendingByBranch.set(branch, list);
      // Ensure the branch exists in the outer map even if it has no
      // server sessions yet — so the pending row has a parent.
      if (!byBranch.has(branch)) { byBranch.set(branch, []); }
    }

    const nodes: SessionNode[] = [];
    for (const [branch, branchSessions] of byBranch) {
      const activeCount = branchSessions.filter(s => {
        const status = deriveStatus(s, this.liveTmuxSessions);
        return status === 'active' || status === 'stale' || status === 'stalled';
      }).length;
      const pendingHere = pendingByBranch.get(branch) ?? [];
      const startingCount = pendingHere.filter(p => p.state === 'starting').length;
      const failedCount = pendingHere.filter(p => p.state === 'failed').length;

      // Branch description: "N active · 1 starting" / "· 2 failed"
      const descParts = [`${activeCount} active`];
      if (startingCount) { descParts.push(`${startingCount} starting`); }
      if (failedCount) { descParts.push(`${failedCount} failed`); }

      const children: SessionNode[] = [
        ...branchSessions.map(s => this.buildSessionNode(s)),
        ...pendingHere.map(p => this.buildPendingNode(p)),
      ];
      nodes.push({
        id: `branch-${branch}`,
        type: 'branch',
        label: branch,
        description: descParts.join(' · '),
        collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
        contextValue: 'branch',
        children,
      });
    }

    return nodes;
  }

  /**
   * Render a pending chat-first launch as a tree row. Two display
   * states:
   *   - `starting` → spinning sync icon, "Starting…" status, persona
   *     label as the title (no session_id yet).
   *   - `failed`   → red error icon, captured stderr in the tooltip,
   *     contextValue routes right-click to "Open Agent Activity" /
   *     "Dismiss".
   */
  private buildPendingNode(p: PendingSession): SessionNode {
    const personaLabel = PERSONA_LABELS[p.personaKey] ?? p.personaKey;
    const elapsedSec = Math.floor((Date.now() - p.startedAt) / 1000);
    const isFailed = p.state === 'failed';
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${personaLabel}** — chat-first launch\n\n`);
    tooltip.appendMarkdown(`- Branch: \`${p.branch}\`\n`);
    if (isFailed) {
      tooltip.appendMarkdown(`- Status: **Failed** to register session_init\n`);
      if (p.failureMessage) {
        tooltip.appendMarkdown(`- Reason: \`${truncate(p.failureMessage, 200)}\`\n`);
      }
      tooltip.appendMarkdown('\n> Open **VibeFlow: Agent Activity** Output channel for full stderr / exit detail.\n');
    } else {
      tooltip.appendMarkdown(`- Status: Waiting for the agent to call \`session_init\` (${elapsedSec}s)\n`);
      tooltip.appendMarkdown(`\n> Will be marked **Failed** after ${PENDING_STALL_THRESHOLD_MS / 1000}s. Check the **VibeFlow: Agent Activity** Output channel for details.\n`);
    }
    return {
      id: `pending-${p.handleId}`,
      type: 'pendingSession',
      label: personaLabel,
      description: isFailed
        ? (p.failureMessage ? `failed — ${truncate(p.failureMessage, 60)}` : 'failed')
        : `starting… (${elapsedSec}s)`,
      tooltip,
      iconId: isFailed ? 'error' : 'sync~spin',
      iconColor: new vscode.ThemeColor(isFailed ? 'errorForeground' : 'editorInfo.foreground'),
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      contextValue: isFailed ? 'pendingSessionFailed' : 'pendingSessionStarting',
      pendingHandleId: p.handleId,
    };
  }

  /**
   * Returns the "Worktrees" group node when at least one git worktree
   * exists in the current workspace, otherwise undefined. Collapsed by
   * default — the section is informational and the user opts in to
   * inspect / manage. Children carry `contextValue: 'worktreeItem'` so
   * package.json `view/item/context` can target right-click commands.
   */
  private buildWorktreeSection(): SessionNode | undefined {
    const workDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workDir) { return undefined; }
    const worktrees = listWorktrees(workDir);
    if (worktrees.length === 0) { return undefined; }

    const children: SessionNode[] = worktrees.map(wt => {
      const id = `worktree::${wt.path}`;
      this.worktreeById.set(id, wt);
      const dirtyTag = wt.dirty ? ' $(diff-modified)' : '';
      return {
        id,
        type: 'worktreeItem',
        label: wt.branch,
        description: `${wt.path}${wt.isCurrent ? ' (current)' : ''}${dirtyTag}`,
        iconId: wt.isCurrent ? 'check' : 'git-branch',
        collapsibleState: vscode.TreeItemCollapsibleState.None,
        contextValue: 'worktreeItem',
        worktree: wt,
      };
    });

    return {
      id: 'worktree-section',
      type: 'worktreeSection',
      label: 'Worktrees',
      description: `${worktrees.length}`,
      iconId: 'source-control',
      collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
      contextValue: 'worktreeSection',
      children,
    };
  }

  private buildSessionNode(session: VibeFlowSession): SessionNode {
    const status = deriveStatus(session, this.liveTmuxSessions);
    const statusInfo = STATUS_ICONS[status];
    const personaLabel = PERSONA_LABELS[session.persona_key] ?? session.persona_name ?? session.persona_key;

    const description = session.last_message
      ? truncate(session.last_message, 60)
      : statusInfo.label;

    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${personaLabel}** (${session.agent_model})\n\n`);
    tooltip.appendMarkdown(`- Session: \`${session.session_id}\`\n`);
    tooltip.appendMarkdown(`- Branch: ${session.git_branch}\n`);
    tooltip.appendMarkdown(`- Status: ${statusInfo.label}\n`);
    if (status === 'stalled') {
      tooltip.appendMarkdown(`  - Pane alive in tmux but agent hasn't sent a heartbeat — usually means it left \`wait_for_work\` without re-entering it.\n`);
    } else if (status === 'ghost') {
      tooltip.appendMarkdown(`  - Backend still has this session marked active but the local tmux pane is gone. Try Refresh or Kill.\n`);
    }
    if (session.last_message_at) {
      tooltip.appendMarkdown(`- Last activity: ${new Date(session.last_message_at).toLocaleString()}\n`);
    }
    if (session.last_message) {
      tooltip.appendMarkdown(`\n> ${session.last_message}\n`);
    }

    const nodeId = `session-${session.session_id}`;
    this.sessionById.set(nodeId, session);

    return {
      id: nodeId,
      type: 'session',
      label: personaLabel,
      description,
      tooltip,
      iconId: statusInfo.icon,
      iconColor: new vscode.ThemeColor(statusInfo.color),
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      // Kill / Restart / Focus need to be available for any session that
      // could still have local resources (a backend record or a tmux
      // pane). Only the truly-dead `inactive` rows fall back to the
      // record-only delete menu.
      contextValue: status === 'inactive' ? 'inactiveSession' : 'activeSession',
      session,
    };
  }

  private buildPlaceholderTree(): SessionNode[] {
    const branch = this.currentBranch || 'main';
    return [
      {
        id: `branch-${branch}`,
        type: 'branch',
        label: branch,
        description: '0 active',
        collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
        contextValue: 'branch',
        children: [
          {
            id: 'placeholder-empty',
            type: 'placeholder',
            label: 'No active sessions',
            description: 'Launch a session to get started',
            iconId: 'circle-outline',
            collapsibleState: vscode.TreeItemCollapsibleState.None,
            contextValue: 'placeholder',
          },
        ],
      },
    ];
  }

  dispose(): void {
    this.stopPolling();
    this._onDidChangeTreeData.dispose();
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
