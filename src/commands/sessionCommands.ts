import * as vscode from 'vscode';
import { execSync } from 'child_process';
import type { VibeFlowClient } from '../api/client.js';
import type { ProjectDetector } from '../project/ProjectDetector.js';
import type { SessionsTreeProvider } from '../views/sessions/SessionsTreeProvider.js';
import type { VibeFlowSession } from '../api/types.js';

// Code agents: only 1 per branch (they modify git)
const CODE_AGENTS = [
  { label: '$(code) Developer', description: 'Write code, fix bugs, implement features', value: 'developer' },
  { label: '$(star-full) Principal Engineer', description: 'Hands-on coding mastery, elegant solutions', value: 'principal_engineer' },
  { label: '$(symbol-structure) Architect', description: 'Design systems, architecture docs, plan work', value: 'architect' },
  { label: '$(dash) Skip code agent', description: 'Launch advisory agents only', value: '_skip' },
];

// Advisory agents: unlimited per branch
const ADVISORY_AGENTS = [
  { label: 'QA Lead', description: 'Test, verify, ensure quality', value: 'qa_lead', picked: false },
  { label: 'Security Lead', description: 'Security review, vulnerability assessment', value: 'security_lead', picked: false },
  { label: 'Product Manager', description: 'Define requirements, write PRDs', value: 'product_manager', picked: false },
  { label: 'Project Manager', description: 'Track progress, manage workflow', value: 'project_manager', picked: false },
  { label: 'UX Designer', description: 'Design user experiences, wireframes', value: 'ux_designer', picked: false },
  { label: 'Customer', description: 'Request features, report issues', value: 'customer', picked: false },
];

const PROVIDERS = [
  { label: '$(hubot) Claude', description: 'claude', value: 'claude' },
  { label: '$(code) Codex', description: 'codex', value: 'codex' },
  { label: '$(sparkle) Gemini', description: 'gemini', value: 'gemini' },
  { label: '$(terminal) Cursor', description: 'cursor', value: 'cursor' },
];

/**
 * 7-step launch wizard matching CLI depth.
 * Steps: Code Agent → Advisory Agents → Provider → Env Token → LLM Gateway → Branch → Worktree
 */
export async function launchSession(
  client: VibeFlowClient,
  detector: ProjectDetector,
  sessionsProvider: SessionsTreeProvider,
): Promise<void> {
  const project = detector.getCachedProject();
  if (!project) {
    vscode.window.showErrorMessage('VibeFlow: No project. Run "VibeFlow: Setup" first.');
    return;
  }
  if (!client.isAuthenticated()) {
    vscode.window.showErrorMessage('VibeFlow: Not logged in. Run "VibeFlow: Setup" first.');
    return;
  }

  const personas: string[] = [];

  // Step 1: Code Agent (single select — max 1 per branch)
  const codeAgent = await vscode.window.showQuickPick(CODE_AGENTS, {
    placeHolder: 'Select code agent (max 1 per branch)',
    title: 'VibeFlow: Launch Session (1/7) — Code Agent',
  });
  if (!codeAgent) { return; }
  if (codeAgent.value !== '_skip') {
    personas.push(codeAgent.value);
  }

  // Step 2: Advisory Agents (multi-select)
  const advisoryPicks = await vscode.window.showQuickPick(ADVISORY_AGENTS, {
    placeHolder: 'Select advisory agents (optional, multi-select)',
    title: 'VibeFlow: Launch Session (2/7) — Advisory Agents',
    canPickMany: true,
  });
  if (advisoryPicks === undefined) { return; }
  for (const pick of advisoryPicks) {
    personas.push(pick.value);
  }

  if (personas.length === 0) {
    vscode.window.showWarningMessage('VibeFlow: No personas selected.');
    return;
  }

  // Step 3: Provider
  const provider = await vscode.window.showQuickPick(PROVIDERS, {
    placeHolder: 'Select AI provider',
    title: 'VibeFlow: Launch Session (3/7) — Provider',
  });
  if (!provider) { return; }

  // Step 4: Environment Token (conditional — codex/gemini need API keys)
  const envVars: Record<string, string> = {};
  if (provider.value === 'codex') {
    const token = await vscode.window.showInputBox({
      prompt: 'Codex MCP Token (or press Enter to skip if already configured)',
      placeHolder: 'MCP_TOKEN value',
      password: true,
      title: 'VibeFlow: Launch Session (4/7) — Codex Token',
      ignoreFocusOut: true,
    });
    if (token === undefined) { return; }
    if (token) { envVars['MCP_TOKEN'] = token; }
  } else if (provider.value === 'gemini') {
    const token = await vscode.window.showInputBox({
      prompt: 'Gemini API Key (or press Enter to skip if already configured)',
      placeHolder: 'GEMINI_API_KEY value',
      password: true,
      title: 'VibeFlow: Launch Session (4/7) — Gemini Key',
      ignoreFocusOut: true,
    });
    if (token === undefined) { return; }
    if (token) { envVars['GEMINI_API_KEY'] = token; }
  }

  // Step 5: LLM Gateway (conditional)
  const config = vscode.workspace.getConfiguration('vibeflow');
  let _llmGateway = false;
  if (config.get<boolean>('llmGateway.show', false)) {
    const gatewayChoice = await vscode.window.showQuickPick(
      [
        { label: '$(cloud) Route through LLM Gateway', description: 'Axiom Cloud proxy', value: true },
        { label: '$(plug) Direct to provider', description: 'No proxy', value: false },
      ],
      { placeHolder: 'LLM Gateway', title: 'VibeFlow: Launch Session (5/7) — LLM Gateway' },
    );
    if (gatewayChoice === undefined) { return; }
    _llmGateway = gatewayChoice.value;
  }

  // Step 6: Branch
  let branches: string[];
  try {
    const result = execSync('git branch --list --no-color', {
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      encoding: 'utf-8',
    });
    branches = result
      .split('\n')
      .map(b => b.replace(/^\*?\s+/, '').trim())
      .filter(Boolean);
  } catch {
    branches = [project.gitBranch];
  }

  const branchItems = [
    { label: '$(add) Create new branch', value: '_new' },
    ...branches.map(b => ({
      label: b === project.gitBranch ? `$(check) ${b}` : b,
      description: b === project.gitBranch ? 'current' : '',
      value: b,
    })),
  ];

  const branchPick = await vscode.window.showQuickPick(branchItems, {
    placeHolder: 'Select branch',
    title: 'VibeFlow: Launch Session (6/7) — Branch',
  });
  if (!branchPick) { return; }

  let branch = branchPick.value;
  if (branch === '_new') {
    const newBranch = await vscode.window.showInputBox({
      prompt: 'New branch name',
      placeHolder: 'feature/my-feature',
      title: 'VibeFlow: New Branch',
    });
    if (!newBranch) { return; }
    branch = newBranch;
  }

  // Step 7: Worktree (conditional — only if branch ≠ current)
  let _worktreeChoice = 'current';
  if (branch !== project.gitBranch) {
    const wtPick = await vscode.window.showQuickPick(
      [
        { label: '$(folder) Current directory', description: 'Switch branch in place', value: 'current' },
        { label: '$(folder-opened) New worktree', description: 'Create git worktree for this branch', value: 'new' },
      ],
      { placeHolder: 'Working directory', title: 'VibeFlow: Launch Session (7/7) — Worktree' },
    );
    if (!wtPick) { return; }
    _worktreeChoice = wtPick.value;
  }

  // Launch sessions for each persona
  const workDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

  for (const persona of personas) {
    try {
      await client.sessionInit({
        projectName: project.projectName,
        workingDirectory: workDir,
        gitBranch: branch,
        gitRemoteUrl: project.gitRemoteUrl,
        persona,
        agentType: provider.value,
      });
    } catch (err) {
      vscode.window.showErrorMessage(`VibeFlow: Failed to launch ${persona} — ${err}`);
    }
  }

  const names = personas.join(', ');
  vscode.window.showInformationMessage(
    `VibeFlow: Launched ${personas.length} session(s) on ${branch}: ${names}`,
  );
  sessionsProvider.refresh();
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
    `Kill ${session.personaName ?? session.personaKey} session on ${session.gitBranch}?`,
    { modal: true },
    'Kill Session',
  );
  if (confirm !== 'Kill Session') { return; }

  try {
    await client.killSession(session.sid);
    vscode.window.showInformationMessage('VibeFlow: Session killed');
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
    `Restart ${session.personaName ?? session.personaKey} session on ${session.gitBranch}?`,
    { modal: true },
    'Restart',
  );
  if (confirm !== 'Restart') { return; }

  try {
    await client.killSession(session.sid);

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

    vscode.window.showInformationMessage('VibeFlow: Session restarted');
    sessionsProvider.refresh();
  } catch (err) {
    vscode.window.showErrorMessage(`VibeFlow: Failed to restart session — ${err}`);
  }
}
