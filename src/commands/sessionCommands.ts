import * as vscode from 'vscode';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { VibeFlowClient } from '../api/client.js';
import type { DetectedProject, ProjectDetector } from '../project/ProjectDetector.js';
import type { SessionsTreeProvider } from '../views/sessions/SessionsTreeProvider.js';
import type { VibeFlowProject } from '../api/types.js';
import { ensureAllAgentDocs } from '../agentdocs/ensureAgentDocs.js';
import { TerminalRegistry, type TerminalMode } from '../sessions/TerminalRegistry.js';
import { createOrAttachWorktree } from './worktreeCommands.js';
import { StickyModels } from '../sessions/stickyModels.js';
import { recordLaunchMode } from '../sessions/launchModeStore.js';
import type { ContextProxy } from '../core/ContextProxy.js';
import { SessionStreamRegistry } from '../sessions/SessionStreamRegistry.js';
import { getAdapter } from '../sessions/providerAdapters/index.js';
import type { ProviderKey } from '../sessions/providerAdapters/types.js';
import { TmuxBacking, buildHeadlessTmuxName } from '../sessions/tmuxBacking.js';
import { detectTmuxAvailability } from '../sessions/tmuxAvailability.js';
import { clearWhichBinaryCache } from '../utils/whichBinary.js';
import {
  isProviderInstalled,
  providerBinaryDisplayName,
  detectExternalAuth,
  validateProviderKey,
  buildProvidersWithAvailability,
} from './launchWizard/providers.js';
import { formatProjectStatusTag } from './launchWizard/projectStatus.js';
import { ensureMcpConfig } from './launchWizard/mcpConfig.js';

// Re-export the helpers covered by the P5-A test cohort so existing
// callers (and `sessionCommands.test.ts`) keep working unchanged.
export { detectExternalAuth, validateProviderKey, buildProvidersWithAvailability };

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
  {
    label: '$(comment-discussion) Chat-First (headless)',
    description: 'YOLO + hidden terminal — interact via embedded Chat panel only',
    detail: 'Agent runs hidden; chat is the only surface. Bundles --dangerously-skip-permissions because there is no terminal to display permission prompts.',
    value: 'chat_first',
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

/**
 * Launch wizard. Mirrors vibeflow-cli's tui_wizard step set: Project →
 * Mode → Code Agent → Advisory → Provider → [Per-persona override] →
 * [Env token] → [LLM gateway] → Branch → [Worktree]. Bracketed steps
 * are conditional. Title strings deliberately omit step counts because
 * the count varies with conditional branches and stale numbers are
 * worse than no numbers.
 */
/**
 * Optional pre-fill for branch and worktree path. When provided (e.g.
 * from the Agent Fleet right-click "Create Session Here" command), the
 * branch picker is skipped, the worktree-choice step is skipped, and
 * the spawned terminals run inside `prefill.workDir`.
 */
export interface LaunchSessionPrefill {
  branch: string;
  workDir: string;
}

export async function launchSession(
  client: VibeFlowClient,
  detector: ProjectDetector,
  sessionsProvider: SessionsTreeProvider,
  extensionUri: vscode.Uri,
  terminalRegistry: TerminalRegistry,
  stickyModels: StickyModels,
  context: ContextProxy,
  streamRegistry: SessionStreamRegistry,
  tmuxBacking: TmuxBacking,
  onProjectSwitched?: (project: DetectedProject) => void,
  prefill?: LaunchSessionPrefill,
): Promise<void> {
  if (!client.isAuthenticated()) {
    vscode.window.showErrorMessage('VibeFlow: Not logged in. Run "VibeFlow: Setup" first.');
    return;
  }

  // Refresh binary-availability cache so install-then-relaunch works in
  // the same VS Code session. `isBinaryOnPath` memoizes per-process for
  // the Settings snapshot's hot path; the wizard wants a fresh read on
  // every launch — one `which` exec per provider is negligible.
  clearWhichBinaryCache();

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
    description: formatProjectStatusTag(p.status),
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

  // Chat-First (headless) bundles YOLO + hidden terminal because there is no
  // terminal to display permission prompts. Mirror the explicit-opt-in
  // precedent set by `vibeflow.session.reattachMode` (default `vanilla`,
  // opt-in YOLO) from `8f42c97`. NO silent default to YOLO.
  if (sessionMode === 'chat_first') {
    const consent = await vscode.window.showWarningMessage(
      'VibeFlow: Chat-First mode runs the agent with --dangerously-skip-permissions in a hidden terminal. The agent will not block on confirmation prompts; every tool action runs immediately. Continue?',
      { modal: true },
      'Continue in Chat-First',
    );
    if (consent !== 'Continue in Chat-First') { return; }
  }

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

  // Step 5: Provider — tag unavailable providers in-list, then gate on pick.
  const provider = await vscode.window.showQuickPick(buildProvidersWithAvailability(), {
    placeHolder: 'Select AI provider',
    title: 'VibeFlow: Launch Session — Provider',
  });
  if (!provider) { return; }
  if (!provider.available) {
    const binary = providerBinaryDisplayName(provider.value);
    vscode.window.showErrorMessage(
      `VibeFlow: '${binary}' CLI not found on PATH. Install it and reload the window, then re-run the wizard.`,
    );
    return;
  }

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
        const personaPick = await vscode.window.showQuickPick(buildProvidersWithAvailability(), {
          placeHolder: `Provider for ${persona}`,
          title: `VibeFlow: Launch Session — Provider for ${persona}`,
        });
        if (!personaPick) { return; }
        if (!personaPick.available) {
          const binary = providerBinaryDisplayName(personaPick.value);
          vscode.window.showErrorMessage(
            `VibeFlow: '${binary}' CLI not found on PATH — cannot route '${persona}' to ${personaPick.value}. Install it and re-run the wizard.`,
          );
          return;
        }
        personaProviders.set(persona, personaPick.value);
      }
    }
  }

  // Belt-and-suspenders preflight: every provider in the final routing
  // map must be installed. The pickers above already gate on selection,
  // so this only trips if a future code path adds a provider without
  // going through `buildProvidersWithAvailability()`. Mirrors
  // vibeflow-cli's `ResolvePersonaProvider` actionable-error pattern
  // (`provider.go:191-208`).
  const providersInUse = new Set(personaProviders.values());
  for (const p of providersInUse) {
    if (!isProviderInstalled(p)) {
      vscode.window.showErrorMessage(
        `VibeFlow: '${providerBinaryDisplayName(p)}' CLI not found on PATH — cannot launch session.`,
      );
      return;
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
        prompt: 'Codex MCP Token (paste your token, or press Enter if MCP_TOKEN is set in your shell)',
        placeHolder: 'MCP_TOKEN value',
        password: true,
        title: 'VibeFlow: Launch Session — Codex Token',
        ignoreFocusOut: true,
      });
      if (token === undefined) { return; }
      if (!token.trim()) {
        // Empty Enter — only valid if external auth is present.
        const external = detectExternalAuth('MCP_TOKEN');
        if (!external) {
          vscode.window.showErrorMessage(
            'VibeFlow: Cannot launch Codex session — no MCP_TOKEN found in VS Code secret store, shell environment, or anywhere else. Configure it via Settings → Providers (or export MCP_TOKEN in your shell) and retry.',
          );
          return;
        }
        vscode.window.showInformationMessage(`VibeFlow: Using ${external.source} for Codex.`);
        // Leave envVars['MCP_TOKEN'] unset — spawned terminal inherits from parent env.
      } else {
        const result = validateProviderKey('MCP_TOKEN', token);
        if (!result.ok) {
          vscode.window.showErrorMessage(
            `VibeFlow: Cannot launch Codex session — ${result.reason} If your MCP_TOKEN is set elsewhere, configure it via Settings → Providers and retry.`,
          );
          return;
        }
        envVars['MCP_TOKEN'] = result.value;
      }
    }
  } else if (provider.value === 'gemini') {
    const stored = await context.getProviderEnvToken('GEMINI_API_KEY');
    if (stored) {
      envVars['GEMINI_API_KEY'] = stored;
    } else {
      const token = await vscode.window.showInputBox({
        prompt: 'Gemini API Key (paste your key, or press Enter if GEMINI_API_KEY / gcloud / ~/.gemini/credentials is configured)',
        placeHolder: 'GEMINI_API_KEY value',
        password: true,
        title: 'VibeFlow: Launch Session — Gemini Key',
        ignoreFocusOut: true,
      });
      if (token === undefined) { return; }
      if (!token.trim()) {
        // Empty Enter — only valid if external auth is present.
        const external = detectExternalAuth('GEMINI_API_KEY');
        if (!external) {
          vscode.window.showErrorMessage(
            'VibeFlow: Cannot launch Gemini session — no GEMINI_API_KEY found in VS Code secret store, shell environment, or ~/.gemini/credentials. Configure it via Settings → Providers (or run `gcloud auth application-default login`) and retry.',
          );
          return;
        }
        vscode.window.showInformationMessage(`VibeFlow: Using ${external.source} for Gemini.`);
        // Leave envVars['GEMINI_API_KEY'] unset — spawned terminal inherits from parent env.
      } else {
        const result = validateProviderKey('GEMINI_API_KEY', token);
        if (!result.ok) {
          vscode.window.showErrorMessage(
            `VibeFlow: Cannot launch Gemini session — ${result.reason} If your GEMINI_API_KEY is set elsewhere, configure it via Settings → Providers and retry.`,
          );
          return;
        }
        envVars['GEMINI_API_KEY'] = result.value;
      }
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

  // Step 8: Branch (skipped when caller pre-filled it via `prefill`)
  let branch: string;
  if (prefill) {
    branch = prefill.branch;
  } else {
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

    branch = branchPick.value;
    if (branch === '_new') {
      const newBranch = await vscode.window.showInputBox({
        prompt: 'New branch name',
        placeHolder: 'feature/my-feature',
        title: 'VibeFlow: New Branch',
      });
      if (!newBranch) { return; }
      branch = newBranch;
    }
  }

  // Step 7: Worktree choice (skipped when prefill supplies a workDir, or
  // when the chosen branch is the current branch — switch-in-place is the
  // only meaningful option there). When `vibeflow.worktree.autoCreate` is
  // on, the prompt is also skipped and we go straight to creating a new
  // worktree — matches the CLI's WorktreeConfig.AutoCreate semantics.
  let worktreeChoice: 'current' | 'new' = 'current';
  if (!prefill && branch !== project.gitBranch) {
    const autoCreate = config.get<boolean>('worktree.autoCreate', false);
    if (autoCreate) {
      worktreeChoice = 'new';
    } else {
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
  }

  // Launch sessions for each persona. When the caller pre-filled a workDir
  // (e.g. "Create Session Here" from a Worktrees TreeView item), we skip
  // the on-the-fly worktree creation entirely and spawn directly inside it.
  let workDir = prefill
    ? prefill.workDir
    : (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '');

  if (!prefill && worktreeChoice === 'new' && workDir) {
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

  // Read terminal mode setting. Chat-First mode forces `'none'` (hidden)
  // regardless of workspace setting — chat is the only surface, the
  // terminal is plumbing.
  const workspaceTerminalMode = vscode.workspace.getConfiguration('vibeflow')
    .get<TerminalMode>('session.terminalMode', 'hybrid');
  const terminalMode: TerminalMode = sessionMode === 'chat_first' ? 'none' : workspaceTerminalMode;

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
      const binary = AGENT_BINARIES[personaProviderKey] ?? 'claude';

      // Build the init prompt that tells the agent which persona and project to use.
      // For TUI mode this is sent to the terminal after the agent loads (~4s delay).
      // For stream-json mode it's passed as a positional argv element to the agent CLI.
      const initPrompt = `Initialize a vibeflow session for project ${project.projectName} with persona ${persona} and follow the agent prompt. Call session_init with project_name: ${project.projectName}, persona: ${persona}, git_branch: ${branch} and begin Phase 1 immediately.`;

      const fullEnv = {
        ...env,
        VIBEFLOW_PERSONA: persona,
        VIBEFLOW_MODEL: model,
      };

      // Chat-first sessions spawn directly via SessionStreamRegistry in
      // stream-json mode (todo #1620, doc #285). The hidden TUI terminal
      // is replaced by a direct child_process.spawn — chat is the only
      // surface, and the "Agent Activity" Output channel is the escape
      // hatch for raw event visibility.
      //
      // If the chosen provider has no stream-json adapter yet, fall back
      // to the hidden-TUI behavior shipped in #1611 (visible-terminal-
      // wrapped agent with REST polling at 5s cadence) and warn the user
      // once. The chat panel works either way; the only difference is
      // sub-second realtime vs. 5s polling.
      const adapter = sessionMode === 'chat_first' ? getAdapter(personaProviderKey) : undefined;

      // Resolve headless backing for chat-first sessions (todo
      // #1615). 'tmux' is opt-in only — 'auto' and 'vscode' both
      // route to the existing flow (streamJsonProcess if an
      // adapter exists, hidden VS Code terminal otherwise). On
      // Windows or when tmux is missing, an explicit 'tmux'
      // request degrades to 'vscode' with a one-time warning.
      const headlessBacking = sessionMode === 'chat_first'
        ? await resolveHeadlessBacking()
        : 'vscode';

      if (sessionMode === 'chat_first' && headlessBacking === 'tmux') {
        // Tmux-backed chat-first launch. The agent runs inside a
        // detached tmux session on the dedicated
        // `vibeflow-headless` socket. Chat events route via REST
        // polling (no stream-json — capturing JSONL from a tmux
        // pane is unreliable when the pane is also showing the
        // TUI). Trade-off the user explicitly opted into.
        const tmuxName = buildHeadlessTmuxName(persona, branch, workDir);
        // Reuse semantic: if a tmux session for this (persona, branch,
        // workDir) is already alive, don't spawn a duplicate — that
        // surfaces as `tmux new-session: duplicate session` and aborts
        // the launch with a raw error. Tmux backing's design intent IS
        // "agent survives IDE restart" (#1615), so the right move on a
        // relaunch is to skip the spawn and let the chat-panel opener
        // attach to the existing agent's backend session. Issue #2324.
        if (await tmuxBacking.hasSession(tmuxName)) {
          vscode.window.showInformationMessage(
            `VibeFlow: Reusing existing ${persona} session in tmux ("${tmuxName}"). ` +
            `To start fresh, kill the existing first: tmux -L vibeflow-headless kill-session -t ${tmuxName}`,
          );
          // Skip new-session — the existing agent is already polling and
          // the chat panel opener will pick up its backend session record.
        } else {
          const command = buildLaunchCommand(binary, personaProviderKey, sessionMode);
          const fullCommand = initPrompt
            ? `${command} ${shellQuote(initPrompt)}`
            : command;
          await tmuxBacking.start({
            name: tmuxName,
            workDir,
            command: fullCommand,
            env: fullEnv,
          });
          vscode.window.showInformationMessage(
            `VibeFlow: ${persona} launched in tmux session "${tmuxName}" on socket "vibeflow-headless". ` +
            `Attach from any terminal: tmux -L vibeflow-headless attach -t ${tmuxName}`,
          );
        }
      } else if (sessionMode === 'chat_first' && adapter) {
        // Pin the workspace `.mcp.json` so headless agents (Claude
        // especially — see todo #1621) can register the VibeFlow MCP
        // server explicitly. `ensureMcpConfig` already wrote this file
        // earlier in launchSession; if it isn't there, the agent will
        // boot with no MCP servers and the 30s session-poll will time
        // out without ever opening the chat panel. Warn loudly so the
        // user sees a path forward rather than a silent failure.
        const mcpConfigPath = path.join(workDir, '.mcp.json');
        const mcpConfigExists = fs.existsSync(mcpConfigPath);
        if (!mcpConfigExists) {
          vscode.window.showWarningMessage(
            `VibeFlow: ${persona} chat-first launch — \`.mcp.json\` not found in ${workDir}. ` +
            'The agent will likely fail to call session_init. Run "VibeFlow: Setup" or set ' +
            'vibeflow.serverUrl + API key, then relaunch.',
          );
        }
        const handle = streamRegistry.start({
          providerKey: personaProviderKey as ProviderKey,
          persona,
          branch,
          workDir,
          binary,
          adapter,
          env: fullEnv,
          initPrompt,
          mcpConfigPath: mcpConfigExists ? mcpConfigPath : undefined,
        });
        // Optimistic "Starting…" row in Agent Fleet so the launch has
        // immediate visual confirmation. Cleared automatically when
        // `session_init` lands (or upgraded to "Failed" if the child
        // exits before registering). See SessionsTreeProvider.addPending.
        sessionsProvider.addPending({
          handleId: handle.handleId,
          personaKey: persona,
          branch,
        });
      } else {
        if (sessionMode === 'chat_first' && !adapter) {
          vscode.window.showWarningMessage(
            `VibeFlow: ${personaProviderKey} has no stream-json adapter yet; chat-first mode for this persona falls back to a hidden TUI terminal with REST polling. Chat still works at ~5s cadence.`,
          );
        }
        const command = buildLaunchCommand(binary, personaProviderKey, sessionMode);
        terminalRegistry.create({
          persona,
          branch,
          provider: personaProviderKey,
          workDir,
          command,
          env: fullEnv,
          terminalMode,
          initPrompt,
        });
      }

      // Remember the mode so a future window-reload reattach (or a
      // right-click Restart) doesn't silently downgrade a YOLO agent
      // back to vanilla. Keyed per-{persona, branch, workDir} so two
      // worktrees of the same branch can run different modes.
      void recordLaunchMode(context, persona, branch, workDir, sessionMode);
    } catch (err) {
      vscode.window.showErrorMessage(`VibeFlow: Failed to launch ${persona} — ${err}`);
    }
  }

  if (sessionMode === 'chat_first') {
    vscode.window.showInformationMessage(
      `VibeFlow: Launched ${personas.length} chat-first session(s) on ${branch}: ${personas.join(', ')}. Opening Chat panel…`,
    );
    // Fire-and-forget: poll for each persona's session record and auto-open
    // its Chat panel. The agent binary calls session_init shortly after the
    // terminal spawns; in chat-first mode the panel is the only surface, so
    // we want it visible the moment the agent registers.
    for (const persona of personas) {
      void waitForAgentSessionThenOpenPanel(client, project.projectId, persona, branch);
    }
  } else {
    vscode.window.showInformationMessage(
      `VibeFlow: Launched ${personas.length} session(s) on ${branch}: ${personas.join(', ')}`,
    );
  }
  sessionsProvider.refresh();
}

/**
 * Poll the active-sessions endpoint for up to ~30s waiting for the agent
 * binary to call `session_init` and register itself, then open the
 * matching Session Panel via the `vibeflow.openSessionPanel` command.
 *
 * Used only by Chat-First launches (todo #1611), where the terminal is
 * hidden and the chat panel is the user's only interaction surface — so
 * we want it visible the moment the agent appears in `listSessions`.
 *
 * Failures (timeout / network) surface a soft hint pointing the user at
 * the Agent Fleet view; we deliberately don't error-toast because the
 * launch itself succeeded — only the auto-open convenience timed out.
 */
async function waitForAgentSessionThenOpenPanel(
  client: VibeFlowClient,
  projectId: number,
  persona: string,
  branch: string,
): Promise<void> {
  const timeoutMs = 30000;
  const pollMs = 2000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const sessions = await client.listSessions(projectId);
      const found = sessions.find(s =>
        s.persona_key === persona && s.git_branch === branch && s.active,
      );
      if (found) {
        await vscode.commands.executeCommand('vibeflow.openSessionPanel', found.session_id);
        return;
      }
    } catch {
      // Continue polling — transient errors should not abort.
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  vscode.window.showWarningMessage(
    `VibeFlow: ${persona} session is taking longer than 30s to register. Open the Chat panel manually from the Agent Fleet view once it appears.`,
  );
}

// Provider binary mapping (matches CLI defaults from config.go DefaultConfig).
// Single-name lookup used at launch + restart — distinct from PROVIDER_BINARIES
// in launchWizard/providers.ts, which lists ALL acceptable names per provider
// for availability detection (cursor accepts both `cursor-agent` and `agent`).
export const AGENT_BINARIES: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  cursor: 'agent',
};

/**
 * Build the agent binary launch command with session mode flags.
 *   vanilla     → no flags (per-action permission prompts)
 *   vibeflow    → --dangerously-skip-permissions (claude) / --yolo (codex/gemini)
 *   chat_first  → same flags as vibeflow (YOLO is bundled because the hidden
 *                 terminal cannot display permission prompts; user opt-in
 *                 was captured at launch time and persisted in launchModeStore)
 *
 * Any other sessionMode string falls through to vanilla so a stale
 * config value (e.g. 'auto' from an older install) doesn't crash launch.
 */
export function buildLaunchCommand(binary: string, provider: string, sessionMode: string): string {
  const isYolo = sessionMode === 'vibeflow' || sessionMode === 'chat_first';
  if (!isYolo) {
    return binary;
  }

  // YOLO / skip permissions
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
 * Resolve `vibeflow.session.headlessBacking` to a concrete
 * 'tmux' | 'vscode' value (todo #1615).
 *
 * Conservative policy: 'auto' maps to 'vscode' — tmux is OFF by
 * default per the feature-level architectural decision in
 * #1610. Users who want tmux must set the config explicitly
 * to 'tmux'. This avoids silently changing agent lifecycle
 * semantics for users who happen to have tmux installed.
 *
 * If the user explicitly chose 'tmux' but tmux isn't available
 * (Windows; not on PATH; missing), we fall back to 'vscode'
 * with a one-time warning.
 */
async function resolveHeadlessBacking(): Promise<'tmux' | 'vscode'> {
  const config = vscode.workspace.getConfiguration('vibeflow');
  const setting = config.get<string>('session.headlessBacking', 'auto');
  // Explicit 'vscode' = opt out of multi-turn — the user wants the agent
  // tied to this IDE window's lifetime (one-shot `claude --print`).
  if (setting === 'vscode') { return 'vscode'; }
  // 'auto' (default) or explicit 'tmux' → prefer tmux when available.
  // tmux-backed chat-first runs `claude --dangerously-skip-permissions
  // <initPrompt>` (interactive TUI, NOT --print) inside a detached
  // tmux pane — the agent stays alive and keeps polling wait_for_work,
  // which is what makes multi-turn chat actually work. The vscode-backed
  // path uses claude --print which exits after one assistant response;
  // it's the right choice only when the user wants that lifecycle
  // explicitly. See issue #2306 for the full diagnosis.
  const probe = await detectTmuxAvailability();
  if (probe.available) { return 'tmux'; }
  // Only warn on explicit 'tmux' — silent fallback on 'auto' is
  // expected (Windows, or Unix without tmux installed).
  if (setting === 'tmux') {
    vscode.window.showWarningMessage(
      'VibeFlow: tmux backing requested but tmux is not available on this system. Falling back to a hidden VS Code terminal. Install tmux or change vibeflow.session.headlessBacking to suppress this warning.',
    );
  }
  return 'vscode';
}

/**
 * Minimal POSIX-shell single-quoter for the init prompt passed
 * to tmux's `new-session <command>`. tmux invokes `$SHELL -c
 * <command>` to run our argument string; we hand it a single
 * argv element that's already correctly quoted for that shell.
 *
 * Pattern matches the existing `terminal.sendText` path in
 * TerminalRegistry (line 103): wrap in single quotes, escape
 * embedded `'` as `'\''`. Single-quotes are immune to all other
 * shell metacharacters under POSIX rules.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
