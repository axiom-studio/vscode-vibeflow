// Settings data model — mirrors CLI config.go

export interface ProviderConfig {
  key: string;
  name: string;
  binary: string;
  available: boolean;
  vibeflowIntegrated: boolean;
  envTokenName?: string; // e.g., "MCP_TOKEN" for codex, "GEMINI_API_KEY" for gemini
  envTokenSet: boolean;
}

export interface SettingsData {
  // Connection
  serverUrl: string;
  serverReachable: boolean | null; // null = not checked
  apiKeySet: boolean;
  apiKeyValid: boolean | null;
  projectId: number | null;
  projectName: string | null;
  projects: { id: number; name: string }[];

  // Providers
  defaultProvider: string;
  providers: ProviderConfig[];

  // Worktree
  worktreeBaseDir: string;
  worktreeAutoCreate: boolean;
  worktreeCleanupOnKill: 'ask' | 'always' | 'never';

  // Session
  pollInterval: number;
  liveInterval: number;
  sessionTerminalMode?: string;
  sessionHeadlessBacking?: 'auto' | 'tmux' | 'vscode';

  // Notifications
  notifyAgentPrompts: boolean;
  notifyWorkComplete: boolean;

  // Chat rendering preferences (session-defaults concern)
  chatDiffView: 'unified' | 'split';

  // Diagnostics — Cloud Runners API trace toggle (#3397). Optional so older
  // host snapshots without the field don't break the tabs.
  cloudRunnersDebug?: boolean;

  // CLI Interface
  cliEnabled: boolean;
  cliBinaryPath: string;
  cliMcpName: string;
  cliRootPath: string;
  /** Whether the `vibeflow` binary was found on PATH (or at cliBinaryPath
   *  if set). Computed host-side so the tab can render install guidance
   *  inline without round-tripping a child_process call. */
  cliInstalled: boolean;
  /** Per-agent MCP wiring status — every supported coding agent paired with
   *  whether its config currently declares the VibeFlow MCP server. Computed
   *  host-side by scanning each agent's config file. */
  mcpAgents: { key: string; label: string; enabled: boolean }[];
  /** Installed vibeflow CLI version (from `vibeflow version`), or null when
   *  the binary isn't found. */
  cliVersion: string | null;
  /** When `cli.binaryPath` is set but the file is missing, the stale path —
   *  so the UI can say "configured path not found" instead of "not installed".
   *  null when no override is set or the configured file exists. */
  cliBinaryPathStale: string | null;

  // About
  version: string;
}

// Webview -> Extension — re-exported from the shared host/webview protocol.
// The shared union is the single source of truth; the host's SettingsPanel
// switches on it exhaustively, so any drift fails at compile time on both
// sides.
export type { SettingsClientMessage as SettingsCommand } from '../../../../src/core/webviewMessages';

// GitProviderView is defined host-side; re-export the type so the Git
// Configuration tab (feature #603) can render the list without redeclaring it.
export type { GitProviderView } from '../../../../src/api/types';

// Extension -> Webview — narrowed locally so the webview can use a typed
// SettingsData payload instead of the shared `unknown`. Compatible with
// the shared SettingsHostMessage shape (same variants, tighter payload).
export type SettingsMessage =
  | { type: 'settingsData'; payload: SettingsData }
  | { type: 'validationResult'; payload: { field: string; valid: boolean; message?: string } }
  | { type: 'gitProvidersData'; payload: { providers: import('../../../../src/api/types').GitProviderView[]; loading?: boolean; error?: string } }
  | { type: 'gitProviderCreateResult'; payload: { ok: boolean; error?: string } };
