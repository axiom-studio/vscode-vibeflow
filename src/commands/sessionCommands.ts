import * as vscode from 'vscode';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { VibeFlowClient } from '../api/client.js';
import type { DetectedProject, ProjectDetector } from '../project/ProjectDetector.js';
import type { SessionsTreeProvider } from '../views/sessions/SessionsTreeProvider.js';
import type { VibeFlowProject, VibeFlowSession } from '../api/types.js';
import { ensureAllAgentDocs } from '../agentdocs/ensureAgentDocs.js';
import { TerminalRegistry, type TerminalMode } from '../sessions/TerminalRegistry.js';
import { createOrAttachWorktree } from './worktreeCommands.js';
import { StickyModels } from '../sessions/stickyModels.js';
import { recordLaunchMode, lookupLaunchMode } from '../sessions/launchModeStore.js';
import type { ContextProxy } from '../core/ContextProxy.js';

/**
 * Best-effort delete of `.vibeflow-session-{persona}` from the session's
 * working directory (or worktree path if set). Stays a no-op when the
 * file isn't there, so it's safe to call from any teardown path.
 *
 * Why this exists: the agent binary (Claude Code, Codex, Gemini) writes
 * this sidecar after calling session_init via MCP — it's the agent's
 * way of remembering its session_id across restarts. We never write
 * these files; we only read them in SessionReattacher. So the agent
 * leaves them behind on exit, and unless we sweep them when killing
 * the session, the next window reload finds a "phantom" pointing to
 * a session_id that the backend has already deleted.
 */
function removeSessionFile(persona: string, workDir: string): void {
  if (!workDir || !persona) { return; }
  const filePath = path.join(workDir, `.vibeflow-session-${persona}`);
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Permissions / already gone — nothing actionable from a kill path.
  }
}

// Two modes: Vanilla (per-action permission prompts) and VibeFlow (YOLO).
// Auto mode (--enable-auto-mode) was a third option but Claude Code 2.1+
// still prompts on every MCP tool's first use even with auto mode on, so
// it didn't deliver the "fewer prompts" UX it advertised. Removed to keep
// the wizard short — vanilla for safety, vibeflow when you want zero
// interruptions in an isolated workspace.
const SESSION_MODES = [
  {
    label: '$(shield) Vanilla',
    description: 'Normal mode — agent asks permission before each action',
    detail: 'Safest. Use for sensitive or exploratory work.',
    value: 'vanilla',
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
 * Launch wizard. Mirrors vibeflow-cli's tui_wizard step set: Project →
 * Mode → Code Agent → Advisory → Provider → [Per-persona override] →
 * [Env token] → [LLM gateway] → Branch → [Worktree]. Bracketed steps
 * are conditional. Title strings deliberately omit step counts because
 * the count varies with conditional branches and stale numbers are
 * worse than no numbers.
 */
export async function launchSession(
  client: VibeFlowClient,
  detector: ProjectDetector,
  sessionsProvider: SessionsTreeProvider,
  extensionUri: vscode.Uri,
  terminalRegistry: TerminalRegistry,
  stickyModels: StickyModels,
  context: ContextProxy,
  onProjectSwitched?: (project: DetectedProject) => void,
): Promise<void> {
  if (!client.isAuthenticated()) {
    vscode.window.showErrorMessage('VibeFlow: Not logged in. Run "VibeFlow: Setup" first.');
    return;
  }

  // Step 1: Project — fetch live, default to cached, re-cache if changed.
  // The CLI's tui_wizard StepProject does the same: every launch is a
  // chance to switch project. Without this, the only path to switch was
  // /vibeflow.openSettings → Project, which most users never find.
  let projects: VibeFlowProject[];
  try {
    projects = await client.listProjects();
  } catch (err) {
    vscode.window.showErrorMessage(`VibeFlow: Failed to load projects — ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (projects.length === 0) {
    vscode.window.showErrorMessage('VibeFlow: No projects available. Create one in the dashboard first.');
    return;
  }

  const cached = detector.getCachedProject();
  const projectItems = projects.map(p => ({
    label: cached?.projectId === p.id ? `$(check) ${p.name}` : p.name,
    description: p.status,
    detail: p.git_remote_url ?? undefined,
    project: p,
  }));
  const projectPick = await vscode.window.showQuickPick(projectItems, {
    placeHolder: 'Select VibeFlow project',
    title: 'VibeFlow: Launch Session — Project',
  });
  if (!projectPick) { return; }

  // Resolve the workspace's current branch eagerly — used both for the
  // gitBranch field below and for the branch step's "current" hint. The
  // cached project's gitBranch is unreliable (stale, often "").
  const currentBranch = await detector.getGitBranch();
  const project: DetectedProject = {
    projectId: projectPick.project.id,
    projectName: projectPick.project.name,
    gitRemoteUrl: projectPick.project.git_remote_url ?? '',
    gitBranch: currentBranch,
  };
  if (cached?.projectId !== project.projectId) {
    await detector.cacheProject(project);
    // Fire the host's connect callback so Work Items / Documents /
    // Sessions providers, status bars, and the activity poller all
    // re-bind to the new project before we spawn terminals against it.
    onProjectSwitched?.(project);
  }

  // Step 2: Session Mode
  const modePick = await vscode.window.showQuickPick([...SESSION_MODES], {
    placeHolder: 'Select session mode',
    title: 'VibeFlow: Launch Session — Session Mode',
  });
  if (!modePick) { return; }
  const sessionMode = modePick.value;

  const personas: string[] = [];

  // Step 3: Code Agent (single select — max 1 per branch)
  const codeAgent = await vscode.window.showQuickPick(CODE_AGENTS, {
    placeHolder: 'Select code agent (max 1 per branch)',
    title: 'VibeFlow: Launch Session — Code Agent',
  });
  if (!codeAgent) { return; }
  if (codeAgent.value !== '_skip') {
    personas.push(codeAgent.value);
  }

  // Step 4: Advisory Agents (multi-select)
  const advisoryPicks = await vscode.window.showQuickPick(ADVISORY_AGENTS, {
    placeHolder: 'Select advisory agents (optional, multi-select)',
    title: 'VibeFlow: Launch Session — Advisory Agents',
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

  // Step 5: Provider
  const provider = await vscode.window.showQuickPick(PROVIDERS, {
    placeHolder: 'Select AI provider',
    title: 'VibeFlow: Launch Session — Provider',
  });
  if (!provider) { return; }

  // Step 5b: Per-persona provider override (conditional — only when
  // running 2+ personas, mirrors tui_wizard's teamModeProvider gate).
  // Default: every persona inherits the main provider. Override mode
  // lets the user route e.g. principal_engineer → claude and
  // product_manager → gemini in the same launch.
  //
  // Caveat carried over from CLI: the env-token step (5c below) only
  // collects credentials for the *main* provider. A persona that
  // overrides to a provider needing a key the user didn't enter falls
  // back to whatever's in the environment / the binary's own config.
  // Document this rather than fan out the token step per-override.
  const personaProviders = new Map<string, string>();
  for (const p of personas) { personaProviders.set(p, provider.value); }

  if (personas.length > 1) {
    const overrideChoice = await vscode.window.showQuickPick(
      [
        {
          label: `$(arrow-right) Use ${provider.label} for all`,
          description: 'Same provider for every persona',
          value: false,
        },
        {
          label: '$(symbol-color) Customize per persona',
          description: 'Pick a different provider for each agent',
          value: true,
        },
      ],
      {
        placeHolder: 'Provider routing',
        title: 'VibeFlow: Launch Session — Provider Routing',
      },
    );
    if (overrideChoice === undefined) { return; }
    if (overrideChoice.value) {
      for (const persona of personas) {
        const personaPick = await vscode.window.showQuickPick(PROVIDERS, {
          placeHolder: `Provider for ${persona}`,
          title: `VibeFlow: Launch Session — Provider for ${persona}`,
        });
        if (!personaPick) { return; }
        personaProviders.set(persona, personaPick.value);
      }
    }
  }

  // Step 6: Environment Token (conditional — codex/gemini need API keys).
  // If the user has already stored a token via Settings → Providers, we
  // pre-fill from `context.secrets` and skip the wizard step entirely.
  // This matches Roo-Code's "set once, reuse" pattern and keeps the
  // launch wizard short for repeat launches.
  const envVars: Record<string, string> = {};
  if (provider.value === 'codex') {
    const stored = await context.getProviderEnvToken('MCP_TOKEN');
    if (stored) {
      envVars['MCP_TOKEN'] = stored;
    } else {
      const token = await vscode.window.showInputBox({
        prompt: 'Codex MCP Token (or press Enter to skip if already configured)',
        placeHolder: 'MCP_TOKEN value',
        password: true,
        title: 'VibeFlow: Launch Session — Codex Token',
        ignoreFocusOut: true,
      });
      if (token === undefined) { return; }
      if (token) { envVars['MCP_TOKEN'] = token; }
    }
  } else if (provider.value === 'gemini') {
    const stored = await context.getProviderEnvToken('GEMINI_API_KEY');
    if (stored) {
      envVars['GEMINI_API_KEY'] = stored;
    } else {
      const token = await vscode.window.showInputBox({
        prompt: 'Gemini API Key (or press Enter to skip if already configured)',
        placeHolder: 'GEMINI_API_KEY value',
        password: true,
        title: 'VibeFlow: Launch Session — Gemini Key',
        ignoreFocusOut: true,
      });
      if (token === undefined) { return; }
      if (token) { envVars['GEMINI_API_KEY'] = token; }
    }
  }

  // Step 7: LLM Gateway (conditional — gated by `vibeflow.llmGateway.show`,
  // off by default). The wizard step is dormant for everyone except dev
  // builds that explicitly enable the flag. When live the answer is wired
  // into the spawned terminal's env via VIBEFLOW_LLM_GATEWAY so the agent
  // binary can route accordingly.
  const config = vscode.workspace.getConfiguration('vibeflow');
  let llmGateway = false;
  if (config.get<boolean>('llmGateway.show', false)) {
    const gatewayChoice = await vscode.window.showQuickPick(
      [
        { label: '$(cloud) Route through LLM Gateway', description: 'Axiom Cloud proxy', value: true },
        { label: '$(plug) Direct to provider', description: 'No proxy', value: false },
      ],
      { placeHolder: 'LLM Gateway', title: 'VibeFlow: Launch Session — LLM Gateway' },
    );
    if (gatewayChoice === undefined) { return; }
    llmGateway = gatewayChoice.value;
  }

  // Step 8: Branch
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
    title: 'VibeFlow: Launch Session — Branch',
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
  let worktreeChoice: 'current' | 'new' = 'current';
  if (branch !== project.gitBranch) {
    const wtPick = await vscode.window.showQuickPick(
      [
        { label: '$(folder) Current directory', description: 'Switch branch in place', value: 'current' as const },
        { label: '$(folder-opened) New worktree', description: 'Create git worktree for this branch', value: 'new' as const },
      ],
      { placeHolder: 'Working directory', title: 'VibeFlow: Launch Session — Worktree' },
    );
    if (!wtPick) { return; }
    worktreeChoice = wtPick.value;
  }

  // Launch sessions for each persona
  let workDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

  // If the user picked "New worktree", create it now and use the new path
  // as workDir so all spawned terminals run inside the worktree. Pre-fix
  // this answer was thrown away — the wizard step did nothing.
  if (worktreeChoice === 'new' && workDir) {
    const wtPath = createOrAttachWorktree(workDir, branch);
    if (!wtPath) {
      vscode.window.showErrorMessage(
        `VibeFlow: Failed to create worktree for "${branch}". Falling back to current directory.`,
      );
    } else {
      workDir = wtPath;
      vscode.window.showInformationMessage(`VibeFlow: Worktree created at ${wtPath}`);
    }
  }
  const serverUrl = vscode.workspace.getConfiguration('vibeflow').get<string>('serverUrl', 'https://cloud.axiomstudio.ai');

  // Write agent instruction docs (CLAUDE.md / AGENTS.md / GEMINI.md) into workDir.
  if (workDir) {
    ensureAllAgentDocs(extensionUri, workDir);
    // Ensure .mcp.json exists with vibeflow server config so the agent
    // can connect to the MCP server regardless of global ~/.claude.json state.
    ensureMcpConfig(workDir, serverUrl, client);
  }

  // Read terminal mode setting
  const terminalMode = vscode.workspace.getConfiguration('vibeflow')
    .get<TerminalMode>('session.terminalMode', 'hybrid');

  // Build env: provider env vars + VibeFlow context
  const env: Record<string, string> = {
    ...envVars,
    VIBEFLOW_SERVER_URL: serverUrl,
    VIBEFLOW_BRANCH: branch,
  };
  // Pass the gateway choice through to the agent binary. The variable is
  // only set when the wizard step actually fired (gated by llmGateway.show);
  // when off the env stays clean.
  if (llmGateway) {
    env.VIBEFLOW_LLM_GATEWAY = '1';
  }

  // Note: we do NOT call session_init from the extension. The agent binary
  // reads CLAUDE.md/AGENTS.md and calls session_init itself via MCP.
  for (const persona of personas) {
    try {
      const personaProviderKey = personaProviders.get(persona) ?? provider.value;
      const model = stickyModels.getModel(persona);
      const command = buildLaunchCommand(
        binaries[personaProviderKey] ?? 'claude',
        personaProviderKey,
        sessionMode,
      );

      // Build the init prompt that tells the agent which persona and project to use.
      // This is sent to the terminal after claude's TUI loads (~4s delay).
      const initPrompt = `Initialize a vibeflow session for project ${project.projectName} with persona ${persona} and follow the agent prompt. Call session_init with project_name: ${project.projectName}, persona: ${persona}, git_branch: ${branch} and begin Phase 1 immediately.`;

      terminalRegistry.create({
        persona,
        branch,
        provider: personaProviderKey,
        workDir,
        command,
        env: {
          ...env,
          VIBEFLOW_PERSONA: persona,
          VIBEFLOW_MODEL: model,
        },
        terminalMode,
        initPrompt,
      });

      // Remember the mode so a future window-reload reattach (or a
      // right-click Restart) doesn't silently downgrade a YOLO agent
      // back to vanilla. Keyed per-{persona, branch, workDir} so two
      // worktrees of the same branch can run different modes.
      void recordLaunchMode(context, persona, branch, workDir, sessionMode);
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
 * Ensure .mcp.json exists in the workspace with the vibeflow MCP server config.
 * Claude reads this on startup to discover MCP servers. Without it, the agent
 * can't call session_init or any other VibeFlow MCP tool.
 *
 * SECURITY: this file embeds a Bearer token in args. Before writing, we verify
 * the workspace's .gitignore excludes .mcp.json (or self-heal it). If the
 * workspace is a git repo and we cannot ensure the file will be ignored, we
 * refuse to write rather than risk leaking the token in a future commit.
 */
function ensureMcpConfig(workDir: string, serverUrl: string, _client: VibeFlowClient): void {
  const mcpPath = path.join(workDir, '.mcp.json');

  // Read token from CLI config (same source as extension auto-login)
  let token: string | undefined;
  try {
    const cliConfigPath = path.join(require('os').homedir(), '.vibeflow-cli', 'config.yaml');
    const cliContent = fs.readFileSync(cliConfigPath, 'utf-8');
    const match = cliContent.match(/^api_token:\s*(.+)$/m);
    if (match) { token = match[1].trim(); }
  } catch {
    // No CLI config — can't write .mcp.json without a token
  }

  if (!token) { return; }

  // SECURITY GUARD: refuse to write if the workspace is a git repo and we
  // cannot guarantee .mcp.json will be ignored.
  if (!ensureMcpJsonIsGitIgnored(workDir)) {
    console.warn('[VibeFlow] Skipping .mcp.json write: cannot ensure file is gitignored.');
    vscode.window.showWarningMessage(
      'VibeFlow: Skipped writing .mcp.json — could not confirm the file is gitignored. ' +
      'Add `.mcp.json` to your workspace .gitignore or configure the MCP server globally instead.',
    );
    return;
  }

  // Read existing .mcp.json if present
  let existing: Record<string, unknown> = {};
  try {
    const content = fs.readFileSync(mcpPath, 'utf-8');
    existing = JSON.parse(content);
  } catch {
    // File doesn't exist or invalid JSON — will create fresh
  }

  const mcpServers = (existing.mcpServers ?? {}) as Record<string, unknown>;

  // Only write if vibeflow isn't already configured
  if (mcpServers.vibeflow) { return; }

  mcpServers.vibeflow = {
    command: 'npx',
    args: [
      '-y',
      'mcp-remote',
      `${serverUrl}/rest/v1/vibeflow/mcp`,
      '--header',
      `Authorization: Bearer ${token}`,
    ],
  };

  existing.mcpServers = mcpServers;

  try {
    fs.writeFileSync(mcpPath, JSON.stringify(existing, null, 2), { encoding: 'utf-8', mode: 0o600 });
    console.log('[VibeFlow] Wrote .mcp.json with vibeflow server config');
  } catch {
    // Non-fatal — agent can still use global config
  }
}

/**
 * Ensures `.mcp.json` is excluded from git in the given workspace.
 *
 * Returns true if either:
 *   - the workspace is not a git repo (no .git, no .gitignore — write is fine),
 *   - .gitignore already contains a rule matching `.mcp.json`, or
 *   - we successfully appended `.mcp.json` to .gitignore.
 *
 * Returns false if the workspace looks like a git repo but we couldn't update
 * .gitignore (permissions, etc.). Caller should refuse to write the token.
 */
function ensureMcpJsonIsGitIgnored(workDir: string): boolean {
  const gitignorePath = path.join(workDir, '.gitignore');
  const gitDirPath = path.join(workDir, '.git');

  const isGitRepo = fs.existsSync(gitDirPath) || fs.existsSync(gitignorePath);
  if (!isGitRepo) { return true; }

  let existing = '';
  try {
    existing = fs.readFileSync(gitignorePath, 'utf-8');
  } catch {
    // .gitignore doesn't exist yet — we'll create it below
  }

  // Match any line that would ignore .mcp.json (exact, leading-slash, or wildcard
  // patterns). Comments and blank lines are skipped.
  const matches = existing.split('\n').some(rawLine => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) { return false; }
    const stripped = line.replace(/^\/+/, '').replace(/^!/, '');
    return stripped === '.mcp.json' || stripped === '*.mcp.json' || stripped === '*';
  });

  if (matches) { return true; }

  try {
    const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(
      gitignorePath,
      `${prefix}\n# Added by VibeFlow — contains a Bearer token, do not commit.\n.mcp.json\n`,
      'utf-8',
    );
    return true;
  } catch {
    return false;
  }
}

// Provider binary mapping (matches CLI defaults from config.go DefaultConfig)
const binaries: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  cursor: 'agent',
};

/**
 * Build the agent binary launch command with session mode flags.
 * vanilla  → no flags (per-action permission prompts)
 * vibeflow → --dangerously-skip-permissions (claude) / --yolo (codex/gemini)
 *
 * Any other sessionMode string falls through to vanilla so a stale
 * config value (e.g. 'auto' from an older install) doesn't crash launch.
 */
function buildLaunchCommand(binary: string, provider: string, sessionMode: string): string {
  if (sessionMode !== 'vibeflow') {
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
 * Focus the terminal for a session. Opens hidden terminals.
 */
export function focusTerminal(
  terminalRegistry: TerminalRegistry,
  session: VibeFlowSession,
): void {
  const found = terminalRegistry.focus(session.persona_key, session.git_branch);
  if (!found) {
    vscode.window.showInformationMessage(
      `VibeFlow: No local terminal for ${session.persona_name ?? session.persona_key}. This session may be running on another machine.`,
    );
  }
}

/**
 * Kill a session with confirmation. Disposes the local terminal AND
 * deletes the backend record — anything less leaves the user looking
 * at a "killed" status badge while the agent process is still running
 * locally, which is confusing and can also cause stale write attempts
 * against the backend (the agent's next heartbeat 404s).
 */
export async function killSession(
  client: VibeFlowClient,
  session: VibeFlowSession,
  sessionsProvider: SessionsTreeProvider,
  terminalRegistry: TerminalRegistry,
): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    `Kill ${session.persona_name ?? session.persona_key} session on ${session.git_branch}?`,
    { modal: true },
    'Kill Session',
  );
  if (confirm !== 'Kill Session') { return; }

  // Dispose the local terminal first — even if the backend kill fails,
  // we don't want to leave the agent running locally after the user
  // explicitly asked to kill it. terminalRegistry.kill is a no-op when
  // there's no registered terminal (e.g. session running on another
  // machine), so this is safe in all cases.
  terminalRegistry.kill(session.persona_key, session.git_branch);

  // Remove the sidecar file the agent dropped at session_init time.
  // Without this, the file lingers and SessionReattacher sees a phantom
  // for a session_id whose backend record has just been deleted.
  // Honor worktree path so worktree-launched agents get cleaned up too.
  const workDir = session.git_worktree_path || session.working_directory;
  removeSessionFile(session.persona_key, workDir);

  try {
    await client.killSession(session.session_id);
    vscode.window.showInformationMessage('VibeFlow: Session killed');
  } catch (err) {
    // Local terminal is already gone; surface the backend error so the
    // user knows the server record may need manual cleanup, but don't
    // pretend the kill failed entirely.
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`VibeFlow: Local terminal killed but backend record cleanup failed — ${msg}`);
  }
  sessionsProvider.refresh();
}

/**
 * Remove an inactive session record from the project. The active path is
 * killSession (which both kills the local terminal and deletes the server
 * record); this is the lighter-weight cleanup for sessions whose terminals
 * are already gone but whose server records linger.
 */
export async function deleteSession(
  client: VibeFlowClient,
  session: VibeFlowSession,
  sessionsProvider: SessionsTreeProvider,
): Promise<void> {
  const persona = session.persona_name ?? session.persona_key;
  const confirm = await vscode.window.showWarningMessage(
    `Delete the ${persona} session record on ${session.git_branch}? This removes it from the Agent Fleet permanently.`,
    { modal: true },
    'Delete',
  );
  if (confirm !== 'Delete') { return; }

  try {
    // killSession already calls DELETE /sessions/{id} on the backend; we
    // just give it a different prompt so the wording matches the user's
    // intent ("delete the record" vs "kill the running agent").
    await client.killSession(session.session_id);
    // Sweep the .vibeflow-session-{persona} sidecar so the next window
    // reload doesn't see a phantom for the now-deleted record.
    const workDir = session.git_worktree_path || session.working_directory;
    removeSessionFile(session.persona_key, workDir);
    vscode.window.showInformationMessage(`VibeFlow: ${persona} session removed`);
    sessionsProvider.refresh();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`VibeFlow: Failed to delete session — ${msg}`);
  }
}

/**
 * Copy a session id to the clipboard. Useful for filing bug reports,
 * pasting into Cloud UI's session detail view, or the agent's
 * `session_init(session_id: ...)` recovery path.
 */
export async function copySessionId(session: VibeFlowSession): Promise<void> {
  await vscode.env.clipboard.writeText(session.session_id);
  vscode.window.showInformationMessage(`VibeFlow: Copied session id ${session.session_id}`);
}

/**
 * Restart a session — kill the existing record + terminal, then spawn a
 * fresh terminal for the same persona / provider / branch / workdir so
 * the agent re-enters its polling loop without the user having to walk
 * the wizard again.
 *
 * The agent itself calls `session_init` from inside the new terminal
 * (via the standard init prompt that launchSession also uses), so the
 * extension still doesn't touch session_init directly — same constraint
 * documented in the P3-B notes, just executed via the agent binary
 * instead of bouncing the user back to "Launch Session" manually.
 */
export async function restartSession(
  client: VibeFlowClient,
  session: VibeFlowSession,
  detector: ProjectDetector,
  sessionsProvider: SessionsTreeProvider,
  terminalRegistry: TerminalRegistry,
  stickyModels: StickyModels,
  context: ContextProxy,
): Promise<void> {
  const personaLabel = session.persona_name ?? session.persona_key;
  const confirm = await vscode.window.showWarningMessage(
    `Restart ${personaLabel} session on ${session.git_branch}?`,
    { modal: true },
    'Restart',
  );
  if (confirm !== 'Restart') { return; }

  const project = detector.getCachedProject();
  if (!project) {
    vscode.window.showErrorMessage('VibeFlow: No project cached. Run "VibeFlow: Setup" first.');
    return;
  }

  try {
    await client.killSession(session.session_id);
  } catch (err) {
    // Backend kill failure shouldn't block the respawn — the local
    // terminal might already be gone and the user just wants the agent
    // back. Log and continue; the new session_init will reconcile.
    console.warn('[VibeFlow] killSession failed during restart, continuing:', err);
  }

  // Resolve respawn parameters from the session record + config.
  // Prefer the session's worktree path so a worktree-launched agent
  // restarts inside the worktree, not the main workspace.
  const config = vscode.workspace.getConfiguration('vibeflow');
  const provider = session.agent_type || config.get<string>('defaultProvider', 'claude');
  const persona = session.persona_key;
  const branch = session.git_branch;
  const workDir = session.git_worktree_path
    || session.working_directory
    || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    || '';
  if (!workDir) {
    vscode.window.showErrorMessage('VibeFlow: cannot resolve a working directory for restart.');
    return;
  }

  // Resolution order for sessionMode:
  //   1. The mode we recorded when this persona was originally launched
  //      on this branch+workDir (so YOLO stays YOLO and vanilla stays
  //      vanilla — no surprise downgrade or upgrade).
  //   2. vibeflow.session.reattachMode config — applies when the launch
  //      record is missing (e.g. session created before this tracking
  //      shipped, or workspace state was wiped).
  //   3. 'vanilla' as the safety floor.
  const recordedMode = lookupLaunchMode(context, persona, branch, workDir);
  const sessionMode = recordedMode
    ?? config.get<string>('session.reattachMode', 'vanilla');
  const terminalMode = config.get<TerminalMode>('session.terminalMode', 'hybrid');
  const serverUrl = config.get<string>('serverUrl', 'https://cloud.axiomstudio.ai');

  const binary = binaries[provider] ?? 'claude';
  const command = buildLaunchCommand(binary, provider, sessionMode);
  const model = stickyModels.getModel(persona);
  const initPrompt = `Initialize a vibeflow session for project ${project.projectName} with persona ${persona} and follow the agent prompt. Call session_init with project_name: ${project.projectName}, persona: ${persona}, git_branch: ${branch} and begin Phase 1 immediately.`;

  try {
    terminalRegistry.create({
      persona,
      branch,
      provider,
      workDir,
      command,
      env: {
        VIBEFLOW_SERVER_URL: serverUrl,
        VIBEFLOW_PERSONA: persona,
        VIBEFLOW_BRANCH: branch,
        VIBEFLOW_MODEL: model,
      },
      terminalMode,
      initPrompt,
    });
    // Refresh the launch-mode record. Usually it's already there from
    // the original launch; this keeps it accurate when a config-driven
    // fallback resolved the mode (e.g. when the original launch
    // pre-dates this tracking).
    void recordLaunchMode(context, persona, branch, workDir, sessionMode);
    vscode.window.showInformationMessage(
      `VibeFlow: Restarted ${personaLabel} on ${branch}.`,
    );
    sessionsProvider.refresh();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`VibeFlow: Failed to respawn terminal — ${msg}`);
  }
}
