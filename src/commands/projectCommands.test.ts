import { describe, expect, it } from 'vitest';
import type { DetectedProject } from '../project/ProjectDetector.js';
import {
  isVibeflowWebviewTabInput,
  isVibeflowWebviewViewType,
  shouldOfferCloseForProjectSwitch,
} from './projectCommands.js';

describe('project switch tab-close helpers', () => {
  const current: DetectedProject = {
    projectId: 28,
    projectName: 'vscode-vibeflow',
    gitRemoteUrl: 'git@example.com:vscode-vibeflow.git',
    gitBranch: 'main',
  };

  it('only offers the tab-close prompt for a real project switch', () => {
    expect(shouldOfferCloseForProjectSwitch(undefined, 28)).toBe(false);
    expect(shouldOfferCloseForProjectSwitch(current, 28)).toBe(false);
    expect(shouldOfferCloseForProjectSwitch(current, 66)).toBe(true);
  });

  it('recognizes VibeFlow webview view types even when VS Code prefixes them', () => {
    expect(isVibeflowWebviewViewType('vibeflow.dashboard')).toBe(true);
    expect(isVibeflowWebviewViewType('vibeflow.sessionPanel')).toBe(true);
    expect(isVibeflowWebviewViewType('mainThreadWebview-vibeflow.tickets')).toBe(true);

    expect(isVibeflowWebviewViewType('workbench.editor.notVibeflow')).toBe(false);
    expect(isVibeflowWebviewViewType('vibeflowish.dashboard')).toBe(false);
  });

  it('classifies webview tab inputs structurally instead of relying on instanceof', () => {
    expect(isVibeflowWebviewTabInput({ viewType: 'vibeflow.kanban' })).toBe(true);
    expect(isVibeflowWebviewTabInput({ viewType: 'mainThreadWebview-vibeflow.compliance' })).toBe(true);

    expect(isVibeflowWebviewTabInput({ viewType: 'markdown.preview' })).toBe(false);
    expect(isVibeflowWebviewTabInput({ viewType: 123 })).toBe(false);
    expect(isVibeflowWebviewTabInput(undefined)).toBe(false);
  });
});
