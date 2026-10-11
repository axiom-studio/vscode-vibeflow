import * as vscode from 'vscode';
import type { DetectedProject } from '../../project/ProjectDetector.js';
import type { SimpleNode } from './surfaceNodes.js';
import { toTreeItem } from './surfaceNodes.js';

/**
 * Project view: the sidebar's scope line (#4030, design doc #627 §2.1).
 * Agent Fleet above it is global across projects; every view below it is
 * scoped to this project. One row; clicking it, or the title-bar action,
 * runs the existing project picker.
 */
export class ProjectTreeProvider implements vscode.TreeDataProvider<SimpleNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private project: DetectedProject | undefined;

  setProject(project: DetectedProject | undefined): void {
    this.project = project;
    this._onDidChangeTreeData.fire();
  }

  getProject(): DetectedProject | undefined {
    return this.project;
  }

  getTreeItem(node: SimpleNode): vscode.TreeItem {
    return toTreeItem(node);
  }

  getChildren(): SimpleNode[] {
    return [projectScopeNode(this.project)];
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

export function projectScopeNode(project: DetectedProject | undefined): SimpleNode {
  const command: vscode.Command = { command: 'vibeflow.pickProject', title: 'Switch Project' };
  if (!project) {
    return {
      id: 'project:none',
      label: 'Select a project…',
      iconId: 'folder',
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      command,
    };
  }
  return {
    id: `project:${project.projectId}`,
    label: project.projectName,
    // The cached project has an empty branch; show it only when known.
    description: project.gitBranch || undefined,
    tooltip: `Active VibeFlow project: ${project.projectName} (#${project.projectId})`
      + (project.gitRemoteUrl ? `\n${project.gitRemoteUrl}` : '')
      + '\nClick to switch projects.',
    iconId: 'folder-active',
    collapsibleState: vscode.TreeItemCollapsibleState.None,
    contextValue: 'vibeflowProject',
    command,
  };
}
