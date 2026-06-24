import * as vscode from 'vscode';
import type { SimpleNode } from '../surface/surfaceNodes.js';
import { toTreeItem } from '../surface/surfaceNodes.js';
import type { TicketsMode } from '../../core/webviewMessages.js';

const SECTIONS: { mode: TicketsMode; label: string; icon: string }[] = [
  { mode: 'todos', label: 'Todos', icon: 'checklist' },
  { mode: 'issues', label: 'Issues', icon: 'bug' },
  { mode: 'features', label: 'Features', icon: 'milestone' },
  { mode: 'backlog', label: 'Backlog', icon: 'list-unordered' },
  { mode: 'security', label: 'Security Review', icon: 'shield' },
  { mode: 'qa', label: 'Pending QA', icon: 'verified' },
];

/**
 * Sidebar "Browse" nav — each row opens a cloud-style ticket TABLE panel
 * (TicketsPanel) in its own editor tab. Static list; no data fetch.
 */
export class TicketsNavTreeProvider implements vscode.TreeDataProvider<SimpleNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SimpleNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  getTreeItem(node: SimpleNode): vscode.TreeItem {
    return toTreeItem(node);
  }

  getChildren(element?: SimpleNode): SimpleNode[] {
    if (element) { return []; }
    return SECTIONS.map(s => ({
      id: `tickets-nav-${s.mode}`,
      label: s.label,
      iconId: s.icon,
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      contextValue: 'ticketsNavItem',
      command: { command: 'vibeflow.openTickets', title: `Open ${s.label}`, arguments: [s.mode] },
    }));
  }
}
