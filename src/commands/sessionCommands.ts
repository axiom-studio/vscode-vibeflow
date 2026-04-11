import * as vscode from 'vscode';
import type { VibeFlowClient } from '../api/client.js';
import type { ProjectDetector } from '../project/ProjectDetector.js';
import type { SessionsTreeProvider } from '../views/sessions/SessionsTreeProvider.js';
import type { VibeFlowSession } from '../api/types.js';

const PERSONAS = [
  { label: '$(person) Developer', value: 'developer' },
  { label: '$(symbol-structure) Architect', value: 'architect' },
  { label: '$(star-full) Principal Engineer', value: 'principal_engineer' },
  { label: '$(shield) Security Lead', value: 'security_lead' },
  { label: '$(beaker) QA Lead', value: 'qa_lead' },
  { label: '$(megaphone) Product Manager', value: 'product_manager' },
  { label: '$(project) Project Manager', value: 'project_manager' },
  { label: '$(paintcan) UX Designer', value: 'ux_designer' },
  { label: '$(account) Customer', value: 'customer' },
];

const PROVIDERS = [
  { label: '$(hubot) Claude', value: 'claude' },
  { label: '$(code) Codex', value: 'codex' },
  { label: '$(sparkle) Gemini', value: 'gemini' },
];

/**
 * Multi-step Quick Pick wizard for launching a new agent session.
 * Steps: persona → provider → branch → worktree
 */
export async function launchSession(
  client: VibeFlowClient,
  detector: ProjectDetector,
  sessionsProvider: SessionsTreeProvider,
): Promise<void> {
  const project = detector.getCachedProject();
  if (!project) {
    vscode.window.showErrorMessage('VibeFlow: No project detected. Open a workspace with a linked git remote.');
    return;
  }

  if (!client.isAuthenticated()) {
    vscode.window.showErrorMessage('VibeFlow: Not logged in. Run "VibeFlow: Login" first.');
    return;
  }

  // Step 1: Select persona
  const persona = await vscode.window.showQuickPick(PERSONAS, {
    placeHolder: 'Select persona for the new session',
    title: 'VibeFlow: Launch Session (1/3)',
  });
  if (!persona) { return; }

  // Step 2: Select provider
  const provider = await vscode.window.showQuickPick(PROVIDERS, {
    placeHolder: 'Select AI provider',
    title: 'VibeFlow: Launch Session (2/3)',
  });
  if (!provider) { return; }

  // Step 3: Select branch
  const branch = await vscode.window.showInputBox({
    prompt: 'Git branch for this session',
    value: project.gitBranch,
    title: 'VibeFlow: Launch Session (3/3)',
  });
  if (branch === undefined) { return; }

  // Launch
  try {
    await client.sessionInit({
      projectName: project.projectName,
      workingDirectory: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
      gitBranch: branch,
      gitRemoteUrl: project.gitRemoteUrl,
      persona: persona.value,
      agentType: provider.value,
    });

    vscode.window.showInformationMessage(
      `VibeFlow: Launched ${persona.label.replace(/\$\([^)]+\)\s*/, '')} session on ${branch}`,
    );
    sessionsProvider.refresh();
  } catch (err) {
    vscode.window.showErrorMessage(`VibeFlow: Failed to launch session — ${err}`);
  }
}

/**
 * Kill a session with confirmation.
 */
export async function killSession(
  client: VibeFlowClient,
  session: VibeFlowSession,
  sessionsProvider: SessionsTreeProvider,
): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    `Kill ${session.personaName} session on ${session.gitBranch}?`,
    { modal: true },
    'Kill Session',
  );

  if (confirm !== 'Kill Session') { return; }

  try {
    await client.killSession(session.sid);
    vscode.window.showInformationMessage(`VibeFlow: Session killed`);
    sessionsProvider.refresh();
  } catch (err) {
    vscode.window.showErrorMessage(`VibeFlow: Failed to kill session — ${err}`);
  }
}

/**
 * Restart a session — kill then re-launch with same params.
 */
export async function restartSession(
  client: VibeFlowClient,
  session: VibeFlowSession,
  detector: ProjectDetector,
  sessionsProvider: SessionsTreeProvider,
): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    `Restart ${session.personaName} session on ${session.gitBranch}?`,
    { modal: true },
    'Restart',
  );

  if (confirm !== 'Restart') { return; }

  try {
    // Kill first
    await client.killSession(session.sid);

    // Re-launch with same params
    const project = detector.getCachedProject();
    if (!project) { return; }

    await client.sessionInit({
      projectName: project.projectName,
      workingDirectory: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
      gitBranch: session.gitBranch,
      gitRemoteUrl: project.gitRemoteUrl,
      persona: session.personaKey,
      agentType: session.agentType,
    });

    vscode.window.showInformationMessage(`VibeFlow: Session restarted`);
    sessionsProvider.refresh();
  } catch (err) {
    vscode.window.showErrorMessage(`VibeFlow: Failed to restart session — ${err}`);
  }
}
