import * as vscode from 'vscode';
import type { VibeFlowClient } from '../../api/client.js';
import type { VibeFlowSession } from '../../api/types.js';

type NodeType = 'branch' | 'session' | 'workItem' | 'inactive' | 'placeholder';

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

const STATUS_ICONS: Record<VibeFlowSession['status'], { icon: string; color: string }> = {
  active: { icon: 'circle-filled', color: 'testing.iconPassed' },
  idle: { icon: 'circle-filled', color: 'editorWarning.foreground' },
  error: { icon: 'circle-filled', color: 'testing.iconFailed' },
  stopped: { icon: 'circle-outline', color: 'disabledForeground' },
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
 * Agent Fleet TreeView — sessions grouped by branch with live data from the API.
 * Falls back to placeholder tree when no project is detected or not authenticated.
 */
export class SessionsTreeProvider implements vscode.TreeDataProvider<SessionNode>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<SessionNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private client: VibeFlowClient | undefined;
  private projectId: number | undefined;
  private sessions: VibeFlowSession[] = [];
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  /**
   * Connect to a project and start polling.
   */
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
    if (!this.client || !this.projectId) {
      return;
    }
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

    if (element.tooltip) {
      item.tooltip = element.tooltip;
    }

    if (element.iconId) {
      item.iconPath = new vscode.ThemeIcon(
        element.iconId,
        element.iconColor,
      );
    }

    return item;
  }

  getChildren(element?: SessionNode): SessionNode[] {
    if (!element) {
      return this.buildTree();
    }
    return element.children ?? [];
  }

  private buildTree(): SessionNode[] {
    if (this.sessions.length === 0) {
      return this.buildPlaceholderTree();
    }

    // Group sessions by branch
    const byBranch = new Map<string, VibeFlowSession[]>();
    for (const s of this.sessions) {
      const branch = s.gitBranch || 'unknown';
      const list = byBranch.get(branch) ?? [];
      list.push(s);
      byBranch.set(branch, list);
    }

    const nodes: SessionNode[] = [];
    for (const [branch, branchSessions] of byBranch) {
      const activeCount = branchSessions.filter(s => s.status === 'active' || s.status === 'idle').length;
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
    const statusInfo = STATUS_ICONS[session.status];
    const personaLabel = PERSONA_LABELS[session.personaKey] ?? session.personaKey;

    const taskDesc = session.currentWorkItem
      ? `${session.currentWorkItem.status} "${session.currentWorkItem.title}"`
      : session.status;

    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${personaLabel}** (${session.agentModel})\n\n`);
    tooltip.appendMarkdown(`- Status: ${session.status}\n`);
    if (session.currentWorkItem) {
      tooltip.appendMarkdown(`- Task: ${session.currentWorkItem.title}\n`);
    }
    if (session.heartbeatAt) {
      tooltip.appendMarkdown(`- Last heartbeat: ${new Date(session.heartbeatAt).toLocaleTimeString()}\n`);
    }

    const node: SessionNode = {
      id: `session-${session.sid}`,
      type: 'session',
      label: personaLabel,
      description: taskDesc,
      tooltip,
      iconId: statusInfo.icon,
      iconColor: new vscode.ThemeColor(statusInfo.color),
      collapsibleState: session.currentWorkItem
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
      contextValue: session.status === 'active' ? 'activeSession' : 'inactiveSession',
      session,
    };

    if (session.currentWorkItem) {
      node.children = [
        {
          id: `workitem-${session.currentWorkItem.type}-${session.currentWorkItem.id}`,
          type: 'workItem',
          label: `#${session.currentWorkItem.id}: ${session.currentWorkItem.title}`,
          description: session.currentWorkItem.status,
          iconId: session.currentWorkItem.type === 'todo' ? 'checklist' : 'bug',
          collapsibleState: vscode.TreeItemCollapsibleState.None,
          contextValue: 'workItem',
        },
      ];
    }

    return node;
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
