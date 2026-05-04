// Settings data model — mirrors CLI config.go

export interface ProviderConfig {
  key: string;
  name: string;
  binary: string;
  available: boolean;
  vibeflowIntegrated: boolean;
  llmGatewayEnabled: boolean;
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
  viewMode: 'flat' | 'grouped';
  skipPermissions: boolean;
  sessionTerminalMode?: string;

  // Advanced
  errorRecoveryEnabled: boolean;
  errorRecoveryMaxRetries: number;
  errorRecoveryDebounce: number;
  notifyAgentPrompts: boolean;
  notifyWorkComplete: boolean;
  debugSimulateActivity: boolean;
  debugVerboseLogging: boolean;

  // Models — per-persona sticky model preferences. `stickyModels`
  // maps persona_key -> model_id; `knownModels` is the full picker
  // catalog grouped by provider key (claude/codex/gemini/cursor).
  stickyModels?: Record<string, string>;
  knownModels?: Record<string, string[]>;

  // About
  version: string;
}

// Extension -> Webview
export type SettingsMessage =
  | { type: 'settingsData'; payload: SettingsData }
  | { type: 'validationResult'; payload: { field: string; valid: boolean; message?: string } };

// Webview -> Extension
export type SettingsCommand =
  | { type: 'getSetting' }
  | { type: 'updateSetting'; payload: { key: string; value: unknown } }
  | { type: 'validateServerUrl'; payload: string }
  | { type: 'validateApiKey'; payload: string }
  | { type: 'setApiKey'; payload: string }
  // Token is collected by the host's InputBox (webview can't open a
  // password-masked native input), so the message is fire-and-forget
  // — only the provider key is needed.
  | { type: 'setProviderToken'; payload: { provider: string } }
  | { type: 'selectProject'; payload: number }
  | { type: 'refreshProjects' }
  // Models tab — per-persona sticky model preferences. updateStickyModel
  // writes through to extension state; resetStickyModel restores the
  // hardcoded default for that persona.
  | { type: 'updateStickyModel'; payload: { persona: string; model: string } }
  | { type: 'resetStickyModel'; payload: { persona: string } }
  | { type: 'closeSettings' };
