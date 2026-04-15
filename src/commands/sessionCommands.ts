import * as vscode from 'vscode';
import { execSync } from 'child_process';
import type { VibeFlowClient } from '../api/client.js';
import type { ProjectDetector } from '../project/ProjectDetector.js';
import type { SessionsTreeProvider } from '../views/sessions/SessionsTreeProvider.js';
import type { VibeFlowSession } from '../api/types.js';
import { ensureAllAgentDocs } from '../agentdocs/ensureAgentDocs.js';

const SESSION_MODES = [
  {
    label: '$(shield) Vanilla',
    description: 'Normal mode — Claude asks permission before each action',
    detail: 'Safest. Use for sensitive or exploratory work.',
    value: 'vanilla',
  },
  {
    label: '$(sparkle) Auto Mode',
    description: 'Classifier-approved actions run without prompts',
    detail: 'Safer middle ground. Requires Claude Team/Enterprise/API + Sonnet 4.6+. (--enable-auto-mode)',
    value: 'auto',
  },
  {
    label: '$(rocket) VibeFlow Mode',
    description: 'YOLO — all permissions bypassed',
    detail: 'Dangerous. Use only in isolated environments. (--dangerously-skip-permissions)',
    value: 'vibeflow',
  },
] as const;

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
  extensionUri: vscode.Uri,
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

  // Step 1: Session Mode
  const modePick = await vscode.window.showQuickPick([...SESSION_MODES], {
    placeHolder: 'Select session mode',
    title: 'VibeFlow: Launch Session (1/8) — Session Mode',
  });
  if (!modePick) { return; }
  const sessionMode = modePick.value;

  const personas: string[] = [];

  // Step 2: Code Agent (single select — max 1 per branch)
  const codeAgent = await vscode.window.showQuickPick(CODE_AGENTS, {
    placeHolder: 'Select code agent (max 1 per branch)',
    title: 'VibeFlow: Launch Session (2/8) — Code Agent',
  });
  if (!codeAgent) { return; }
  if (codeAgent.value !== '_skip') {
    personas.push(codeAgent.value);
  }

  // Step 3: Advisory Agents (multi-select)
  const advisoryPicks = await vscode.window.showQuickPick(ADVISORY_AGENTS, {
    placeHolder: 'Select advisory agents (optional, multi-select)',
    title: 'VibeFlow: Launch Session (3/8) — Advisory Agents',
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

  // Step 4: Provider
  const provider = await vscode.window.showQuickPick(PROVIDERS, {
    placeHolder: 'Select AI provider',
    title: 'VibeFlow: Launch Session (4/8) — Provider',
  });
  if (!provider) { return; }

  // Step 5: Environment Token (conditional — codex/gemini need API keys)
  const envVars: Record<string, string> = {};
  if (provider.value === 'codex') {
    const token = await vscode.window.showInputBox({
      prompt: 'Codex MCP Token (or press Enter to skip if already configured)',
      placeHolder: 'MCP_TOKEN value',
      password: true,
      title: 'VibeFlow: Launch Session (5/8) — Codex Token',
      ignoreFocusOut: true,
    });
    if (token === undefined) { return; }
    if (token) { envVars['MCP_TOKEN'] = token; }
  } else if (provider.value === 'gemini') {
    const token = await vscode.window.showInputBox({
      prompt: 'Gemini API Key (or press Enter to skip if already configured)',
      placeHolder: 'GEMINI_API_KEY value',
      password: true,
      title: 'VibeFlow: Launch Session (5/8) — Gemini Key',
      ignoreFocusOut: true,
    });
    if (token === undefined) { return; }
    if (token) { envVars['GEMINI_API_KEY'] = token; }
  }

  // Step 6: LLM Gateway (conditional)
  const config = vscode.workspace.getConfiguration('vibeflow');
  let _llmGateway = false;
  if (config.get<boolean>('llmGateway.show', false)) {
    const gatewayChoice = await vscode.window.showQuickPick(
      [
        { label: '$(cloud) Route through LLM Gateway', description: 'Axiom Cloud proxy', value: true },
        { label: '$(plug) Direct to provider', description: 'No proxy', value: false },
      ],
      { placeHolder: 'LLM Gateway', title: 'VibeFlow: Launch Session (6/8) — LLM Gateway' },
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
    title: 'VibeFlow: Launch Session (7/8) — Branch',
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
      { placeHolder: 'Working directory', title: 'VibeFlow: Launch Session (8/8) — Worktree' },
    );
    if (!wtPick) { return; }
    _worktreeChoice = wtPick.value;
  }

  // Launch sessions for each persona
  const workDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const serverUrl = vscode.workspace.getConfiguration('vibeflow').get<string>('serverUrl', 'https://cloud.axiomstudio.ai');

  // Write agent instruction docs (CLAUDE.md / AGENTS.md / GEMINI.md) into workDir.
  // The agent reads these on startup and calls session_init itself via MCP.
  // Matches CLI EnsureAllAgentDocs behavior.
  if (workDir) {
    ensureAllAgentDocs(extensionUri, workDir);
  }

  // Note: we do NOT call session_init from the extension. That's an MCP tool
  // (not a REST endpoint), and the agent binary itself will call it when it
  // starts up via its configured MCP server. We just spawn the terminal with
  // the right env vars and the agent handles the rest — same behavior as the
  // CLI's `vibeflow launch` command.
  for (const persona of personas) {
    try {
      spawnAgentTerminal({
        persona,
        provider: provider.value,
        branch,
        workDir,
        envVars,
        serverUrl,
        sessionMode,
      });
    } catch (err) {
      vscode.window.showErrorMessage(`VibeFlow: Failed to launch ${persona} — ${err}`);
    }
  }

  vscode.window.showInformationMessage(
    `VibeFlow: Launched ${personas.length} session(s) on ${branch}: ${personas.join(', ')}`,
  );
  sessionsProvider.refresh();
}

/**
 * Spawn an integrated VSCode terminal with the agent binary running.
 * The terminal IS the session — closing it kills the agent.
 */
function spawnAgentTerminal(opts: {
  persona: string;
  provider: string;
  branch: string;
  workDir: string;
  envVars: Record<string, string>;
  serverUrl: string;
  sessionMode: string;
}): void {
  const personaLabel = opts.persona.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const terminalName = `VibeFlow · ${personaLabel} · ${opts.branch}`;

  // Provider binary mapping (matches CLI defaults)
  const binaries: Record<string, string> = {
    claude: 'claude',
    codex: 'codex',
    gemini: 'gemini',
    cursor: 'agent',
  };
  const binary = binaries[opts.provider] ?? 'claude';

  // Build the launch command with mode-specific flags
  const command = buildLaunchCommand(binary, opts.provider, opts.sessionMode);

  // Build env: provider env vars + VibeFlow context
  const env: Record<string, string> = {
    ...opts.envVars,
    VIBEFLOW_SERVER_URL: opts.serverUrl,
    VIBEFLOW_PERSONA: opts.persona,
    VIBEFLOW_BRANCH: opts.branch,
  };

  const terminal = vscode.window.createTerminal({
    name: terminalName,
    cwd: opts.workDir,
    env,
    iconPath: new vscode.ThemeIcon('hubot'),
  });

  terminal.show(true);
  terminal.sendText(command, true);

  // Note: we do not send an init prompt after claude starts.
  // Claude's TUI reads the CLAUDE.md in workDir on startup, and the user
  // can ask it to initialize the vibeflow session in their first message.
  // Sending text via sendText after the TUI is live doesn't execute
  // reliably — the text goes into the input box but requires manual Enter.
}

/**
 * Build the agent binary launch command with session mode flags.
 * vanilla  → no flags (normal claude with permission prompts)
 * auto     → --enable-auto-mode (claude only, requires Team/Enterprise/API)
 * vibeflow → --dangerously-skip-permissions (claude) / --yolo (codex/gemini)
 */
function buildLaunchCommand(binary: string, provider: string, sessionMode: string): string {
  if (sessionMode === 'vanilla') {
    return binary;
  }

  if (sessionMode === 'auto') {
    // Auto mode is a Claude Code feature; other providers fall back to vanilla
    if (provider === 'claude') {
      return `${binary} --enable-auto-mode`;
    }
    return binary;
  }

  // vibeflow mode = YOLO / skip permissions
  if (provider === 'claude') {
    return `${binary} --dangerously-skip-permissions`;
  }
  if (provider === 'codex' || provider === 'gemini') {
    return `${binary} --yolo`;
  }
  if (provider === 'cursor') {
    return `${binary} --yolo --approve-mcps`;
  }
  return binary;
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
    `Kill ${session.persona_name ?? session.persona_key} session on ${session.git_branch}?`,
    { modal: true },
    'Kill Session',
  );
  if (confirm !== 'Kill Session') { return; }

  try {
    await client.killSession(session.session_id);
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
    `Restart ${session.persona_name ?? session.persona_key} session on ${session.git_branch}?`,
    { modal: true },
    'Restart',
  );
  if (confirm !== 'Restart') { return; }

  try {
    await client.killSession(session.session_id);
    // For full restart, user should re-run VibeFlow: Launch Session.
    // A full programmatic restart needs session_init via MCP, which we
    // deliberately don't call from the extension (see P3-B docs).
    vscode.window.showInformationMessage(
      `VibeFlow: Session ${session.persona_key} removed. Run "Launch Session" to spawn a new one.`,
    );
    sessionsProvider.refresh();
  } catch (err) {
    vscode.window.showErrorMessage(`VibeFlow: Failed to restart session — ${err}`);
  }
}
