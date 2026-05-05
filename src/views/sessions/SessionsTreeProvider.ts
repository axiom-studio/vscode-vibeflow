import * as vscode from 'vscode';
import type { VibeFlowClient } from '../../api/client.js';
import type { VibeFlowSession } from '../../api/types.js';

type NodeType = 'branch' | 'session' | 'placeholder';

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
}

/**
 * Derive a display status from the server-side `active` and `stale` flags.
 * The server uses a Redis heartbeat: `active: true, stale: false` → green,
 * `active: true, stale: true` → yellow (heartbeat expired), `active: false` → gray.
 */
function deriveStatus(s: VibeFlowSession): 'active' | 'stale' | 'inactive' {
  if (!s.active) { return 'inactive'; }
  if (s.stale) { return 'stale'; }
  return 'active';
}

const STATUS_ICONS: Record<ReturnType<typeof deriveStatus>, { icon: string; color: string }> = {
  active: { icon: 'circle-filled', color: 'testing.iconPassed' },
  stale: { icon: 'circle-filled', color: 'editorWarning.foreground' },
  inactive: { icon: 'circle-outline', color: 'disabledForeground' },
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
   * Count of sessions that have a live heartbeat (active and not stale).
   * Used by the right-aligned work-summary status bar to show
   * "N agents · M ready" without re-fetching the session list.
   */
  getActiveSessionCount(): number {
    return this.sessions.filter(s => s.active && !s.stale).length;
  }
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  // Session lookup by TreeItem id — needed because VSCode strips custom fields
  // from TreeItem arguments when passing to commands
  private sessionById = new Map<string, VibeFlowSession>();

  /**
   * Look up a session by its TreeItem id (e.g., "session-abc123").
   * Used by command handlers that receive serialized TreeItem arguments.
   */
  getSessionById(treeItemId: string): VibeFlowSession | undefined {
    return this.sessionById.get(treeItemId);
  }

  refresh(): void {
    this.fetchAndRefresh();
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
    if (this.sessions.length === 0) { return this.buildPlaceholderTree(); }

    // Group sessions by branch
    const byBranch = new Map<string, VibeFlowSession[]>();
    for (const s of this.sessions) {
      const branch = s.git_branch || 'unknown';
      const list = byBranch.get(branch) ?? [];
      list.push(s);
      byBranch.set(branch, list);
    }

    const nodes: SessionNode[] = [];
    for (const [branch, branchSessions] of byBranch) {
      const activeCount = branchSessions.filter(s => s.active && !s.stale).length;
      nodes.push({
        id: `branch-${branch}`,
        type: 'branch',
        label: branch,
        description: `${activeCount} active`,
        collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
        contextValue: 'branch',
        children: branchSessions.map(s => this.buildSessionNode(s)),
      });
    }

    return nodes;
  }

  private buildSessionNode(session: VibeFlowSession): SessionNode {
    const status = deriveStatus(session);
    const statusInfo = STATUS_ICONS[status];
    const personaLabel = PERSONA_LABELS[session.persona_key] ?? session.persona_name ?? session.persona_key;

    const description = session.last_message
      ? truncate(session.last_message, 60)
      : status;

    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${personaLabel}** (${session.agent_model})\n\n`);
    tooltip.appendMarkdown(`- Session: \`${session.session_id}\`\n`);
    tooltip.appendMarkdown(`- Branch: ${session.git_branch}\n`);
    tooltip.appendMarkdown(`- Status: ${status}\n`);
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
      contextValue: status === 'active' ? 'activeSession' : 'inactiveSession',
      session,
    };
  }

  private buildPlaceholderTree(): SessionNode[] {
    return [
      {
        id: 'branch-main',
        type: 'branch',
        label: 'main',
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
