import { describe, expect, it } from 'vitest';
import type { DetectedProject } from '../project/ProjectDetector.js';
import {
  isProjectScopedWebviewTabInput,
  isProjectSwitch,
  isVibeflowWebviewViewType,
} from './projectCommands.js';

describe('project switch tab-close helpers', () => {
  const current: DetectedProject = {
    projectId: 28,
    projectName: 'vscode-vibeflow',
    gitRemoteUrl: 'git@example.com:vscode-vibeflow.git',
    gitBranch: 'main',
  };

  it('only closes tabs for a real project switch', () => {
    expect(isProjectSwitch(undefined, 28)).toBe(false);
    expect(isProjectSwitch(current, 28)).toBe(false);
    expect(isProjectSwitch(current, 66)).toBe(true);
  });

  it('recognizes VibeFlow webview view types even when VS Code prefixes them', () => {
    expect(isVibeflowWebviewViewType('vibeflow.dashboard')).toBe(true);
    expect(isVibeflowWebviewViewType('vibeflow.sessionPanel')).toBe(true);
    expect(isVibeflowWebviewViewType('mainThreadWebview-vibeflow.tickets')).toBe(true);

    expect(isVibeflowWebviewViewType('workbench.editor.notVibeflow')).toBe(false);
    expect(isVibeflowWebviewViewType('vibeflowish.dashboard')).toBe(false);
  });

  it('classifies webview tab inputs structurally instead of relying on instanceof', () => {
    expect(isProjectScopedWebviewTabInput({ viewType: 'vibeflow.kanban' })).toBe(true);
    expect(isProjectScopedWebviewTabInput({ viewType: 'mainThreadWebview-vibeflow.compliance' })).toBe(true);

    expect(isProjectScopedWebviewTabInput({ viewType: 'markdown.preview' })).toBe(false);
    expect(isProjectScopedWebviewTabInput({ viewType: 123 })).toBe(false);
    expect(isProjectScopedWebviewTabInput(undefined)).toBe(false);
  });

  // #4031: the switch closes without a prompt, so what it may close is pinned.
  it('never closes code editors or terminals, so the VibeFlow CLI survives a switch', () => {
    // TabInputText / TabInputTextDiff carry uris, not a viewType.
    expect(isProjectScopedWebviewTabInput({ uri: { fsPath: '/repo/src/a.ts' } })).toBe(false);
    expect(isProjectScopedWebviewTabInput({ original: {}, modified: {} })).toBe(false);
    // TabInputTerminal has no properties at all.
    expect(isProjectScopedWebviewTabInput({})).toBe(false);
  });

  it('keeps the Settings panel open, since a switch can start from inside it', () => {
    expect(isProjectScopedWebviewTabInput({ viewType: 'vibeflow.settings' })).toBe(false);
    expect(isProjectScopedWebviewTabInput({ viewType: 'mainThreadWebview-vibeflow.settings' })).toBe(false);
    expect(isProjectScopedWebviewTabInput({ viewType: 'mainThreadWebview-vibeflow.sessionPanel' })).toBe(true);
  });
});
