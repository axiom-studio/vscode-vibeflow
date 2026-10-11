import { describe, expect, it } from 'vitest';
import type { DetectedProject } from '../../project/ProjectDetector.js';
import { ProjectTreeProvider, projectScopeNode } from './ProjectTreeProvider.js';

const project: DetectedProject = {
  projectId: 28,
  projectName: 'vscode-vibeflow',
  gitRemoteUrl: 'git@github.com:axiom-studio/vscode-vibeflow.git',
  gitBranch: 'main',
};

describe('projectScopeNode', () => {
  it('offers the picker when no project is selected', () => {
    const node = projectScopeNode(undefined);
    expect(node.label).toBe('Select a project…');
    expect(node.command?.command).toBe('vibeflow.pickProject');
  });

  it('names the project and switches on click', () => {
    const node = projectScopeNode(project);
    expect(node.label).toBe('vscode-vibeflow');
    expect(node.description).toBe('main');
    expect(node.tooltip).toContain('#28');
    expect(node.command?.command).toBe('vibeflow.pickProject');
  });

  it('omits the branch when the cached project does not know it', () => {
    expect(projectScopeNode({ ...project, gitBranch: '' }).description).toBeUndefined();
  });
});

describe('ProjectTreeProvider', () => {
  it('always renders exactly one row and fires a change on setProject', () => {
    const provider = new ProjectTreeProvider();
    let fired = 0;
    provider.onDidChangeTreeData(() => { fired += 1; });

    expect(provider.getChildren()).toHaveLength(1);
    provider.setProject(project);
    expect(fired).toBe(1);
    expect(provider.getProject()?.projectId).toBe(28);
    expect(provider.getChildren()[0].label).toBe('vscode-vibeflow');
  });
});
