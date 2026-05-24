import * as vscode from 'vscode';
import { execSync, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { VibeFlowClient } from '../api/client.js';
import type { DetectedProject, ProjectDetector } from '../project/ProjectDetector.js';
import type { SessionsTreeProvider } from '../views/sessions/SessionsTreeProvider.js';
import type { VibeFlowProject, VibeFlowSession } from '../api/types.js';
import { ensureAllAgentDocs } from '../agentdocs/ensureAgentDocs.js';
import { TerminalRegistry, type TerminalMode } from '../sessions/TerminalRegistry.js';
import { createOrAttachWorktree, removeWorktreeAt } from './worktreeCommands.js';
import { StickyModels } from '../sessions/stickyModels.js';
import { recordLaunchMode, lookupLaunchMode } from '../sessions/launchModeStore.js';
import { killTmuxSession } from '../sessions/tmuxState.js';
import type { ContextProxy } from '../core/ContextProxy.js';
import { SessionStreamRegistry } from '../sessions/SessionStreamRegistry.js';
import { getAdapter } from '../sessions/providerAdapters/index.js';
import type { ProviderKey } from '../sessions/providerAdapters/types.js';
import { TmuxBacking, buildHeadlessTmuxName } from '../sessions/tmuxBacking.js';
import { detectTmuxAvailability } from '../sessions/tmuxAvailability.js';
import { isBinaryOnPath, clearWhichBinaryCache } from '../utils/whichBinary.js';

/**
 * Best-effort delete of `.vibeflow-session-{persona}` from the session's
 * working directory (or worktree path if set). Used by:
 *   - killAndForgetSession — explicit user request to wipe resume state
 *   - SessionReattacher's stale-sweep path — when liveSessionIds confirms
 *     the file points at a session_id the backend no longer knows
 *
 * No-op when the file is missing, so safe to call from any teardown.
 * Default kill paths intentionally do NOT call this — the file is the
 * session's resume hint and matches CLI semantics
 * (vibeflow-cli/internal/vibeflowcli/tui.go:619).
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

const PROVIDERS = [
  { label: '$(hubot) Claude', description: 'claude', value: 'claude' },
  { label: '$(code) Codex', description: 'codex', value: 'codex' },
  { label: '$(sparkle) Gemini', description: 'gemini', value: 'gemini' },
  { label: '$(terminal) Cursor', description: 'cursor', value: 'cursor' },
];

// Codicon per project status — mirrors FEATURE_STATUS_ICON in
// views/projectItems/ProjectItemsTreeProvider.ts so the picker reads with
// the same iconography users see in the sidebar. QuickPick descriptions
// support the `$(codicon-name)` inline syntax; uppercasing + space
// substitution gives the trailing token a "tag" feel without HTML/CSS.
const PROJECT_STATUS_CODICON: Record<string, string> = {
  in_review: 'search',
  needs_pm_input: 'search',
  needs_ux_input: 'search',
  planning: 'zap',
  ready_to_implement: 'checklist',
  architecture_review_complete: 'checklist',
  implementing: 'zap',
  done: 'check',
  archived: 'archive',
  rejected: 'archive',
};

function formatProjectStatusTag(status: string): string {
  const icon = PROJECT_STATUS_CODICON[status] ?? 'tag';
  const label = (status || 'unknown').replace(/_/g, ' ').toUpperCase();
  return `$(${icon}) ${label}`;
}

// Provider → CLI binary names. Mirrors `SettingsPanel.ts:392-398` (the same
// table the Setup tab uses to render its availability dots). Cursor ships
// as `cursor-agent` but some installers symlink it to `agent`; either name
// satisfies the gate. Aligns with vibeflow-cli's `ProviderRegistry`
// (`internal/vibeflowcli/provider.go:174-180 checkBinaryAvailable`).
const PROVIDER_BINARIES: Record<string, string[]> = {
  claude: ['claude'],
  codex: ['codex'],
  gemini: ['gemini'],
  cursor: ['cursor-agent', 'agent'],
};

function isProviderInstalled(provider: string): boolean {
  const names = PROVIDER_BINARIES[provider] ?? [provider];
  return names.some(n => isBinaryOnPath(n));
}

// Canonical name to print in user-facing error messages.
function providerBinaryDisplayName(provider: string): string {
  return PROVIDER_BINARIES[provider]?.[0] ?? provider;
}

// Conservative minimum-length floor per env-token kind. Goal: trip on the
// "user pasted `abc123` / hit Enter on an empty box" path without rejecting
// the wide variety of real key formats (Google AI Studio keys are 39-char
// `AIza…`; gcloud-issued OAuth tokens are longer and start differently;
// MCP bearer tokens vary by provider). Floors are deliberately well below
// any plausible real-key length.
const PROVIDER_KEY_RULES: Record<string, { minLength: number; hint: string }> = {
  GEMINI_API_KEY: { minLength: 20, hint: 'Real Gemini keys are typically 39 characters starting with "AIza".' },
  MCP_TOKEN: { minLength: 16, hint: 'Real MCP bearer tokens are at least 16 characters.' },
};

/**
 * Detect provider credentials configured outside the VS Code secret store.
 * Called when the user hits Enter on an empty env-token prompt — empty
 * input doesn't mean "no auth", it often means "I have auth set up
 * elsewhere (gcloud, shell rc, ~/.gemini/credentials)." Returning a
 * non-null source lets the wizard proceed without setting `envVars[envName]`;
 * the spawned terminal inherits parent-process env via the existing
 * `vscode.window.createTerminal({ env })` merge semantics, so a shell
 * `GEMINI_API_KEY` survives the launch.
 *
 * Existence-only check — does NOT validate that the credential actually
 * works. The agent binary fails fast at startup if the credential is
 * bad, which is detectable via the #2175 stall sweep.
 */
function detectExternalAuth(envName: string): { source: string } | null {
  if (process.env[envName]) {
    return { source: `${envName} from your shell environment` };
  }
  if (envName === 'GEMINI_API_KEY') {
    const credPath = path.join(os.homedir(), '.gemini', 'credentials');
    if (fs.existsSync(credPath)) {
      return { source: '~/.gemini/credentials (local Gemini auth)' };
    }
  }
  return null;
}

function validateProviderKey(envName: string, raw: string): { ok: true; value: string } | { ok: false; reason: string } {
  // Match vibeflow-cli's paste hygiene (`tui_wizard.go:851`
  // `strings.Trim(w.envTokenValue, "[]\"' ")`) — users frequently paste
  // keys with surrounding quotes/brackets from `.env` files or docs.
  const trimmed = raw.replace(/^[\s[\]'"]+|[\s[\]'"]+$/g, '');
  if (!trimmed) {
    return { ok: false, reason: 'Key is empty.' };
  }
  const rule = PROVIDER_KEY_RULES[envName];
  if (rule && trimmed.length < rule.minLength) {
    return { ok: false, reason: `That value is only ${trimmed.length} characters — too short to be a real key. ${rule.hint}` };
  }
  return { ok: true, value: trimmed };
}

// Build the PROVIDERS list with per-entry availability tagged in the
// description. Picking a flagged provider still triggers the post-pick
// abort below — the tag is informational so users see the constraint
// before picking. Mirrors vibeflow-cli's `Available()` filter pattern
// from `provider.go:81-88`, but renders unavailable rows instead of
// hiding them so the user understands why their preferred provider is
// missing rather than being silently presented a different list.
function buildProvidersWithAvailability(): { label: string; description: string; value: string; available: boolean }[] {
  return PROVIDERS.map(p => {
    const available = isProviderInstalled(p.value);
    return {
      label: p.label,
      description: available ? p.description : `${p.description} · $(error) not installed`,
      value: p.value,
      available,
    };
  });
}

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
      const binary = binaries[personaProviderKey] ?? 'claude';

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
function ensureMcpConfig(workDir: string, serverUrl: string, client: VibeFlowClient): void {
  const mcpPath = path.join(workDir, '.mcp.json');

  // Token resolution: extension's own secret store first (Setup wizard /
  // Settings → Connection), then CLI config as fallback. Reading from the
  // CLI was the legacy single source — but extension users who never
  // installed the CLI had no token and got a silent skip → no .mcp.json
  // → spawned agent had zero VibeFlow MCP tools available. Preferring the
  // extension's own token also fixes the auth-identity hijack: if CLI and
  // extension are signed in as different users, the agent now boots with
  // the extension's identity (the one the user actually sees in Agent
  // Fleet) instead of silently inheriting the CLI's.
  let token: string | undefined;
  let tokenSource: 'extension' | 'cli-config' | undefined;
  token = client.getToken();
  if (token) {
    tokenSource = 'extension';
  } else {
    try {
      const cliConfigPath = path.join(os.homedir(), '.vibeflow-cli', 'config.yaml');
      const cliContent = fs.readFileSync(cliConfigPath, 'utf-8');
      const match = cliContent.match(/^api_token:\s*(.+)$/m);
      if (match) {
        token = match[1].trim();
        tokenSource = 'cli-config';
      }
    } catch {
      // No CLI config — handled by the loud failure below.
    }
  }

  if (!token) {
    vscode.window.showErrorMessage(
      'VibeFlow: Cannot write .mcp.json — no API key found. Run **VibeFlow: Setup** to connect (or set up the CLI), then re-launch the session. Without .mcp.json the agent has no access to VibeFlow tools (session_init, wait_for_work, etc.).',
    );
    return;
  }

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
    console.log(`[VibeFlow] Wrote .mcp.json with vibeflow server config (token source: ${tokenSource})`);
  } catch {
    // Non-fatal — agent can still use global config
  }
}

/**
 * Ensures `.mcp.json` is excluded from git in the given workspace.
 *
 * Returns true if either:
 *   - the workspace is not a git repo (no .git, no .gitignore — write is fine),
 *   - git itself reports `.mcp.json` is ignored (handles all the wrinkles
 *     including anchored paths, double-star globs, parent-dir gitignore,
 *     `.git/info/exclude`, and global `core.excludesFile`), or
 *   - we successfully appended `.mcp.json` to .gitignore AND git confirms
 *     the post-append state still ignores it (defense against a parent
 *     `!.mcp.json` re-include line that beats our local rule).
 *
 * Returns false if the workspace looks like a git repo but we couldn't
 * confirm the file will be ignored. Caller refuses to write the token.
 *
 * History: a prior hand-rolled matcher stripped leading `!` from gitignore
 * lines before pattern-matching, so a `!.mcp.json` re-include line was
 * mis-read as a positive ignore — and the function returned true ("safe to
 * write") for monorepos using the common `*` + `!.mcp.json` idiom, leaking
 * the bearer token on the next `git add .`. Issue #1948 / AXIOMCLOUD-…
 * filed by Sophie 2026-05-07. Fix: delegate to `git check-ignore`, which
 * is the canonical implementation of gitignore semantics.
 */
function ensureMcpJsonIsGitIgnored(workDir: string): boolean {
  const gitignorePath = path.join(workDir, '.gitignore');
  const gitDirPath = path.join(workDir, '.git');

  const isGitRepo = fs.existsSync(gitDirPath) || fs.existsSync(gitignorePath);
  if (!isGitRepo) { return true; }

  if (isPathIgnoredByGit(workDir, '.mcp.json')) { return true; }

  // Not currently ignored — append the rule and re-verify with git.
  try {
    let existing = '';
    try { existing = fs.readFileSync(gitignorePath, 'utf-8'); } catch { /* will create */ }
    const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(
      gitignorePath,
      `${prefix}\n# Added by VibeFlow — contains a Bearer token, do not commit.\n.mcp.json\n`,
      'utf-8',
    );
  } catch {
    return false;
  }

  // Re-check: a parent `.gitignore` with `!.mcp.json` would beat our local
  // append, and git's last-matching-rule semantics mean we wouldn't know
  // without re-asking git itself. Without this re-verify, the post-append
  // path could still be a token leak.
  return isPathIgnoredByGit(workDir, '.mcp.json');
}

/**
 * Authoritative "is this path ignored?" check via `git check-ignore`. Exit 0
 * means ignored; exit 1 means not ignored; anything else (git missing, not
 * a repo, etc.) we conservatively treat as "cannot confirm" → not ignored,
 * so the caller refuses to write the token.
 */
function isPathIgnoredByGit(workDir: string, relPath: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', relPath], {
      cwd: workDir,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
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
 *   vanilla     → no flags (per-action permission prompts)
 *   vibeflow    → --dangerously-skip-permissions (claude) / --yolo (codex/gemini)
 *   chat_first  → same flags as vibeflow (YOLO is bundled because the hidden
 *                 terminal cannot display permission prompts; user opt-in
 *                 was captured at launch time and persisted in launchModeStore)
 *
 * Any other sessionMode string falls through to vanilla so a stale
 * config value (e.g. 'auto' from an older install) doesn't crash launch.
 */
function buildLaunchCommand(binary: string, provider: string, sessionMode: string): string {
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
 *
 * Sidecar file is preserved by default for session-ID resume on next
 * launch (matches CLI semantics — see vibeflow-cli/internal/vibeflowcli/
 * tui.go:619). Use killAndForgetSession when the user explicitly wants
 * to wipe the resume hint.
 */
export async function killSession(
  client: VibeFlowClient,
  session: VibeFlowSession,
  sessionsProvider: SessionsTreeProvider,
  terminalRegistry: TerminalRegistry,
): Promise<void> {
  return killSessionInternal(client, session, sessionsProvider, terminalRegistry, { forget: false });
}

/**
 * Kill a session AND wipe its `.vibeflow-session-{persona}` sidecar so
 * the next launch starts fresh. Matches the CLI's `CleanupStaleSession`
 * concept but invoked explicitly by the user. The default Kill action
 * preserves the sidecar to enable session_id resume; this one is the
 * "forget everything, start over" variant.
 */
export async function killAndForgetSession(
  client: VibeFlowClient,
  session: VibeFlowSession,
  sessionsProvider: SessionsTreeProvider,
  terminalRegistry: TerminalRegistry,
): Promise<void> {
  return killSessionInternal(client, session, sessionsProvider, terminalRegistry, { forget: true });
}

interface KillOptions {
  /** When true, also delete the .vibeflow-session-{persona} sidecar. */
  forget: boolean;
}

async function killSessionInternal(
  client: VibeFlowClient,
  session: VibeFlowSession,
  sessionsProvider: SessionsTreeProvider,
  terminalRegistry: TerminalRegistry,
  opts: KillOptions,
): Promise<void> {
  const personaLabel = session.persona_name ?? session.persona_key;
  const prompt = opts.forget
    ? `Kill ${personaLabel} session on ${session.git_branch} AND forget its resume state? Next launch will start a fresh session.`
    : `Kill ${personaLabel} session on ${session.git_branch}? The session id stays on disk so the next launch can resume.`;
  const button = opts.forget ? 'Kill & Forget' : 'Kill Session';
  const confirm = await vscode.window.showWarningMessage(
    prompt,
    { modal: true },
    button,
  );
  if (confirm !== button) { return; }

  // Tear down the agent's local resources first — even if the backend
  // kill fails, we don't want to leave the agent process alive after
  // the user explicitly asked to kill it.
  //
  // Two custody models to handle:
  //   - Extension-launched terminals live in TerminalRegistry. Disposing
  //     the registered terminal sends Ctrl-C-then-close to the shell.
  //   - CLI-launched agents live under tmux on the `-L vibeflow` socket;
  //     TerminalRegistry has no record of them. Without an explicit
  //     tmux kill-session, the pane keeps running with an orphan claude
  //     process inside that 404s against the now-deleted backend record.
  //     This is exactly the "vibeflow-cli shows a disconnected entry
  //     after extension-side kill" bug.
  //
  // Both calls are no-ops when nothing's there, so it's safe to run
  // both unconditionally — cheaper than threading a "which mode launched
  // this session" flag through the call site.
  terminalRegistry.kill(session.persona_key, session.git_branch);
  killTmuxSession(session.agent_type ?? '', session.session_id);
  // Headless tmux-backing (todo #1615) lives on a different socket
  // (`vibeflow-headless`). Names follow `buildHeadlessTmuxName` —
  // we recompute here from (persona, branch, workDir) so we don't
  // need to thread another parameter through every kill call site.
  // TmuxBacking is stateless (verb dispatcher only); local instance.
  // Best-effort; no-op when the session was launched any other way.
  const workDir = session.git_worktree_path
    || session.working_directory
    || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    || '';
  if (workDir) {
    const headlessName = buildHeadlessTmuxName(session.persona_key, session.git_branch, workDir);
    void new TmuxBacking().kill(headlessName);
  }

  // Sidecar handling depends on whether the user picked "Kill" or
  // "Kill & Forget". Default Kill preserves the sidecar to enable
  // session_id resume on next launch — matches CLI semantics
  // (vibeflow-cli/internal/vibeflowcli/tui.go:619 — "Session file is
  // intentionally kept so the session ID can be reused on next
  // launch.") Kill & Forget wipes the sidecar so the next launch
  // starts a fresh session_id, mirroring the CLI's
  // CleanupStaleSession path.
  //
  // Stale sidecars (kept by Kill, but whose session_id the backend
  // doesn't know about anymore) are swept on the next window load by
  // SessionReattacher.detectPhantoms via the liveSessionIds cross-check.
  if (opts.forget) {
    const workDir = session.git_worktree_path || session.working_directory;
    removeSessionFile(session.persona_key, workDir);
  }

  let backendKillSucceeded = false;
  try {
    await client.killSession(session.session_id);
    backendKillSucceeded = true;
    const msg = opts.forget
      ? 'VibeFlow: Session killed and forgotten'
      : 'VibeFlow: Session killed';
    vscode.window.showInformationMessage(msg);
  } catch (err) {
    // Local terminal is already gone; surface the backend error so the
    // user knows the server record may need manual cleanup, but don't
    // pretend the kill failed entirely.
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`VibeFlow: Local terminal killed but backend record cleanup failed — ${msg}`);
  }

  // Cleanup-on-kill: remove the session's worktree iff backend kill
  // succeeded, the session was running in a worktree, and the user opted
  // in via `vibeflow.worktree.cleanupOnKill`. Skipped on backend failure
  // because we'd be removing the worktree of a still-active session
  // record, which is worse than leaving the worktree in place.
  if (backendKillSucceeded && session.git_worktree_path) {
    await maybeCleanupWorktree(session);
  }

  sessionsProvider.refresh();
}

/**
 * Honor `vibeflow.worktree.cleanupOnKill` after a successful kill:
 *   - `always` → unconditional `git worktree remove --force`
 *   - `ask`    → modal prompt, only removes on confirm
 *   - `never`  → noop
 *
 * Run from the session's launch workspace folder, not the worktree
 * itself — `git worktree remove` cannot remove the cwd it's running in.
 */
async function maybeCleanupWorktree(session: VibeFlowSession): Promise<void> {
  const cleanup = vscode.workspace.getConfiguration('vibeflow')
    .get<'ask' | 'always' | 'never'>('worktree.cleanupOnKill', 'ask');
  if (cleanup === 'never') { return; }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) { return; }
  // If the user happens to have opened the worktree itself as their
  // workspace, fall back to the working_directory the session recorded.
  const cwd = workspaceRoot === session.git_worktree_path
    ? (session.working_directory || workspaceRoot)
    : workspaceRoot;

  if (cleanup === 'ask') {
    const confirm = await vscode.window.showWarningMessage(
      `Delete the worktree this session ran in?\n\n${session.git_worktree_path}`,
      { modal: true },
      'Delete Worktree',
    );
    if (confirm !== 'Delete Worktree') { return; }
  }

  try {
    removeWorktreeAt(cwd, session.git_worktree_path!);
    vscode.window.showInformationMessage(`VibeFlow: Worktree ${session.git_worktree_path} removed`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`VibeFlow: Failed to remove worktree — ${msg}`);
  }
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
    // Defensive tmux kill — this command is gated on inactiveSession in
    // the menu, so the pane SHOULD already be dead. But "ghost" state
    // (backend active + tmux dead) and similar edge cases mean we run
    // it anyway. No-op when nothing matches.
    killTmuxSession(session.agent_type ?? '', session.session_id);
    // Sidecar is intentionally preserved — same reasoning as
    // killSession: it's session-ID memory for resume, not process state.
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
  // Chat-First sessions force `'none'` (hidden terminal) regardless of the
  // workspace `session.terminalMode` setting — chat is the only surface.
  const workspaceTerminalMode = config.get<TerminalMode>('session.terminalMode', 'hybrid');
  const terminalMode: TerminalMode = sessionMode === 'chat_first' ? 'none' : workspaceTerminalMode;
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
