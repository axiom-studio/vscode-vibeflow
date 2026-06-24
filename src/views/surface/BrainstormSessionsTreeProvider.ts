import * as vscode from 'vscode';
import type { VibeFlowClient } from '../../api/client.js';
import type { VibeFlowBrainstormSession } from '../../api/types.js';
import { personaDisplayName } from '../../sessions/personas.js';
import type { SimpleNode } from './surfaceNodes.js';
import { toTreeItem } from './surfaceNodes.js';

/**
 * Brainstorm Sessions tree — lists the project's brainstorms (most recent
 * first). Clicking a row opens the Brainstorm panel. Reuses the existing
 * client.listBrainstorms; refreshes on the shared poll cycle.
 */
export class BrainstormSessionsTreeProvider implements vscode.TreeDataProvider<SimpleNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SimpleNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private client: VibeFlowClient | undefined;
  private projectId: number | undefined;
  private sessions: VibeFlowBrainstormSession[] = [];

  connect(client: VibeFlowClient, projectId: number): void {
    this.client = client;
    this.projectId = projectId;
    void this.fetch();
  }

  refresh(): void {
    void this.fetch();
  }

  private async fetch(): Promise<void> {
    if (!this.client || this.projectId === undefined) {
      this._onDidChangeTreeData.fire();
      return;
    }
    try {
      this.sessions = await this.client.listBrainstorms(this.projectId);
    } catch {
      this.sessions = [];
    }
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: SimpleNode): vscode.TreeItem {
    return toTreeItem(node);
  }

  getChildren(element?: SimpleNode): SimpleNode[] {
    if (element) {
      return element.children ?? [];
    }
    if (this.sessions.length === 0) {
      return [{
        id: 'empty',
        label: 'No brainstorm sessions',
        iconId: 'comment-discussion',
        collapsibleState: vscode.TreeItemCollapsibleState.None,
      }];
    }
    return [...this.sessions]
      .sort((a, b) => b.id - a.id)
      .map(s => this.sessionNode(s));
  }

  private sessionNode(s: VibeFlowBrainstormSession): SimpleNode {
    const lead = personaDisplayName(s.lead_persona_key);
    const maxRounds = s.config?.max_rounds ?? 0;
    const icon = s.status === 'active'
      ? 'comment-discussion'
      : s.status === 'done'
        ? 'check'
        : 'circle-slash';
    return {
      id: `brainstorm-${s.id}`,
      label: `#${s.id} · ${lead}`,
      description: `${s.status} · round ${s.round_number}/${maxRounds}`,
      iconId: icon,
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      contextValue: 'brainstormSession',
      command: { command: 'vibeflow.openBrainstorm', title: 'Open Brainstorm' },
    };
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
