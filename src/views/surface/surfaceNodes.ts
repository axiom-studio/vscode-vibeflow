import * as vscode from 'vscode';

/**
 * Lightweight tree node shared by the "surface parity" tree views (Todos,
 * Pull requests, Brainstorm Sessions, Security review, Pending QA). Keeps each
 * provider tiny — they only build SimpleNode[] and hand it to {@link toTreeItem}.
 */
export interface SimpleNode {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  /** A codicon id (e.g. 'git-pull-request'). */
  iconId?: string;
  /** A ThemeColor id applied to the icon. */
  iconColor?: string;
  collapsibleState: vscode.TreeItemCollapsibleState;
  children?: SimpleNode[];
  contextValue?: string;
  command?: vscode.Command;
}

/** Convert a {@link SimpleNode} into a vscode.TreeItem. */
export function toTreeItem(node: SimpleNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.label, node.collapsibleState);
  item.id = node.id;
  if (node.description !== undefined) {
    item.description = node.description;
  }
  if (node.tooltip) {
    item.tooltip = node.tooltip;
  }
  if (node.contextValue) {
    item.contextValue = node.contextValue;
  }
  if (node.iconId) {
    item.iconPath = new vscode.ThemeIcon(
      node.iconId,
      node.iconColor ? new vscode.ThemeColor(node.iconColor) : undefined,
    );
  }
  if (node.command) {
    item.command = node.command;
  }
  return item;
}
