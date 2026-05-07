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
  sessionTerminalMode?: string;

  // Notifications
  notifyAgentPrompts: boolean;
  notifyWorkComplete: boolean;

  // Advanced
  debugSimulateActivity: boolean;

  // Models — per-persona sticky model preferences. `stickyModels`
  // maps persona_key -> model_id; `knownModels` is the full picker
  // catalog grouped by provider key (claude/codex/gemini/cursor).
  stickyModels?: Record<string, string>;
  knownModels?: Record<string, string[]>;

  // CLI Interface
  cliEnabled: boolean;
  cliBinaryPath: string;
  /** Whether the `vibeflow` binary was found on PATH (or at cliBinaryPath
   *  if set). Computed host-side so the tab can render install guidance
   *  inline without round-tripping a child_process call. */
  cliInstalled: boolean;

  // About
  version: string;
}

// Webview -> Extension — re-exported from the shared host/webview protocol.
// The shared union is the single source of truth; the host's SettingsPanel
// switches on it exhaustively, so any drift fails at compile time on both
// sides.
export type { SettingsClientMessage as SettingsCommand } from '../../../../src/core/webviewMessages';

// Extension -> Webview — narrowed locally so the webview can use a typed
// SettingsData payload instead of the shared `unknown`. Compatible with
// the shared SettingsHostMessage shape (same variants, tighter payload).
export type SettingsMessage =
  | { type: 'settingsData'; payload: SettingsData }
  | { type: 'validationResult'; payload: { field: string; valid: boolean; message?: string } };
