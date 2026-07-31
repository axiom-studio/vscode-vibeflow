import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AuthService } from '../auth/AuthService.js';
import { resolveBinary, staleCliBinaryPath } from './cliCommands.js';

const execFileAsync = promisify(execFile);

// The MCP server name `vibeflow bootstrap` writes into every agent config
// (the CLI's DefaultMCPToolName). The extension always bootstraps with the
// default, so detection and provisioning agree on this single literal.
const MCP_SERVER_NAME = 'vibeflow';

// Matches the bootstrap CLI default; we still pass --base-url explicitly so
// the agents point at whatever server the user configured in Settings.
const DEFAULT_BASE_URL = 'https://cloud.axiomstudio.ai';

type AgentConfigType = 'json' | 'toml';

interface McpAgent {
  /** `--agents` CSV value (codex, gemini, cursor, claude-cli, claude-desktop, kiro). */
  key: string;
  /** Human label shown in the picker and the Settings status line. */
  label: string;
  type: AgentConfigType;
  configPath(): string;
}

/** OS-specific Claude Desktop config path — mirrors bootstrap.go. */
function claudeDesktopConfigPath(): string {
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
    default:
      return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
  }
}

/**
 * The agents `vibeflow bootstrap` supports, with the config paths it writes
 * (default root). Mirrors the resolvers in vibeflow-cli's bootstrap.go so the
 * extension can detect existing MCP config without shelling out.
 */
const MCP_AGENTS: McpAgent[] = [
  { key: 'codex', label: 'Codex CLI', type: 'toml', configPath: () => path.join(os.homedir(), '.codex', 'config.toml') },
  { key: 'gemini', label: 'Gemini CLI', type: 'json', configPath: () => path.join(os.homedir(), '.gemini', 'settings.json') },
  { key: 'cursor', label: 'Cursor', type: 'json', configPath: () => path.join(os.homedir(), '.cursor', 'mcp.json') },
  { key: 'claude-cli', label: 'Claude CLI', type: 'json', configPath: () => path.join(os.homedir(), '.claude.json') },
  { key: 'claude-desktop', label: 'Claude Desktop', type: 'json', configPath: claudeDesktopConfigPath },
  // Kiro (#4201). vibeflow-cli has supported `--agents kiro` since its feature
  // #648; only this list was missing it, which made Kiro invisible in the
  // extension's picker AND in status detection even though the binary could
  // already bootstrap it. Key/label/path mirror the CLI's own resolver
  // (internal/vibeflowcli/bootstrap.go:78 + kiroConfigPath at :174) — user-level
  // config only, matching Claude CLI's scope. Kiro also supports a
  // workspace-level `<root>/.kiro/settings/mcp.json`, which `vibeflow bootstrap`
  // deliberately does not write, so we don't detect it either.
  { key: 'kiro', label: 'Kiro CLI', type: 'json', configPath: () => path.join(os.homedir(), '.kiro', 'settings', 'mcp.json') },
];

/**
 * Reports whether `content` declares the VibeFlow MCP server. JSON agents
 * carry it under `mcpServers.vibeflow`; Codex's TOML uses a
 * `[mcp_servers.vibeflow]` section. Pure so it's unit-testable without fs.
 */
export function hasVibeflowEntry(content: string, type: AgentConfigType): boolean {
  if (type === 'toml') {
    return content.includes(`[mcp_servers.${MCP_SERVER_NAME}]`);
  }
  try {
    const root = JSON.parse(content) as { mcpServers?: Record<string, unknown> };
    return !!root.mcpServers && Object.prototype.hasOwnProperty.call(root.mcpServers, MCP_SERVER_NAME);
  } catch {
    return false;
  }
}

/**
 * Labels of the coding agents whose config currently declares the VibeFlow
 * MCP server. Drives the Settings status line and the uninstall picker's
 * default selection. Best-effort: a missing or unreadable config counts as
 * "not configured" rather than erroring.
 */
export function detectConfiguredMcpAgents(): string[] {
  return mcpAgentStatuses().filter(a => a.enabled).map(a => a.label);
}

/**
 * Per-agent MCP status for the Settings UI: every supported agent paired with
 * whether its config file currently declares the VibeFlow MCP server.
 * Best-effort — a missing/unreadable config counts as not enabled.
 */
export function mcpAgentStatuses(): { key: string; label: string; enabled: boolean }[] {
  return MCP_AGENTS.map(agent => {
    let enabled = false;
    try {
      enabled = hasVibeflowEntry(fs.readFileSync(agent.configPath(), 'utf-8'), agent.type);
    } catch {
      // missing / unreadable → not enabled
    }
    return { key: agent.key, label: agent.label, enabled };
  });
}

/**
 * Builds the argv for `vibeflow bootstrap`. `all` configures every supported
 * agent; otherwise `agents` is the `--agents` CSV. `apiKey` goes on argv
 * (bootstrap has no stdin/env path) — pass the result straight to execFile,
 * never join it into a shell string.
 */
export function buildBootstrapArgs(opts: { apiKey: string; baseUrl: string; all?: boolean; agents?: string[] }): string[] {
  const args = ['bootstrap', '--api-key', opts.apiKey, '--base-url', opts.baseUrl];
  if (opts.all) {
    args.push('--all');
  } else if (opts.agents && opts.agents.length > 0) {
    args.push('--agents', opts.agents.join(','));
  }
  return args;
}

/** Returns a copy of `args` with the `--api-key` value masked, for logging. */
export function redactBootstrapArgs(args: string[]): string[] {
  const out = [...args];
  const i = out.indexOf('--api-key');
  if (i >= 0 && i + 1 < out.length) {
    out[i + 1] = '***';
  }
  return out;
}

let channel: vscode.OutputChannel | undefined;
function outputChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('VibeFlow MCP Setup');
  }
  return channel;
}

/**
 * Multi-select picker over the supported agents. `preselect` decides which
 * rows start checked. Returns the chosen `--agents` keys, or undefined if the
 * user dismissed the picker.
 */
async function pickAgents(placeHolder: string, preselect: (a: McpAgent) => boolean): Promise<string[] | undefined> {
  const items = MCP_AGENTS.map(a => ({ label: a.label, key: a.key, picked: preselect(a) }));
  const chosen = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder,
    ignoreFocusOut: true,
  });
  if (!chosen) {
    return undefined; // dismissed
  }
  return chosen.map(c => c.key);
}

/**
 * Runs a `vibeflow` subcommand under a progress notification, streaming its
 * output to the "VibeFlow MCP Setup" channel. `secret` (the API key) is masked
 * out of every logged/surfaced string — Node's execFile error message echoes
 * the full argv, which would otherwise leak the key.
 */
async function runVibeflow(
  binary: string,
  args: string[],
  opts: { title: string; success: string; secret?: string },
): Promise<void> {
  const ch = outputChannel();
  const redact = (s: string) => (opts.secret ? s.split(opts.secret).join('***') : s);
  ch.appendLine(`$ ${binary} ${redactBootstrapArgs(args).join(' ')}`);
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: opts.title },
      async () => {
        const { stdout, stderr } = await execFileAsync(binary, args, { timeout: 120_000 });
        if (stdout) { ch.append(redact(stdout)); }
        if (stderr) { ch.append(redact(stderr)); }
      },
    );
    vscode.window.showInformationMessage(opts.success);
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : String(err));
    const stderr = (err as { stderr?: string }).stderr;
    if (stderr) { ch.append(redact(stderr)); }
    ch.appendLine(`error: ${message}`);
    const choice = await vscode.window.showErrorMessage(`VibeFlow MCP setup failed: ${message}`, 'Show Output');
    if (choice === 'Show Output') { ch.show(); }
  }
}

/**
 * Configure the VibeFlow MCP server into the user's coding agents via
 * `vibeflow bootstrap`, reusing the extension's stored API key + server URL so
 * the user never re-enters them. `auto` (post-install) skips the picker and
 * configures every agent; otherwise the user multi-selects which to set up.
 */
export async function bootstrapMcp(
  authService: AuthService | undefined,
  opts: { auto?: boolean } = {},
): Promise<void> {
  const binary = resolveBinary();
  if (!binary) {
    const stale = staleCliBinaryPath();
    vscode.window.showWarningMessage(
      stale
        ? `The configured VibeFlow CLI path doesn't exist:\n${stale}\nUpdate it (Settings → CLI Interface → Browse) or Install Latest.`
        : 'VibeFlow CLI not found — install it first (Settings → CLI Interface).',
    );
    return;
  }
  const apiKey = authService?.getToken();
  if (!apiKey) {
    const msg = 'VibeFlow MCP setup needs an API key — sign in first (Settings → Connection).';
    if (opts.auto) {
      vscode.window.showInformationMessage(`Skipped MCP setup: ${msg}`);
    } else {
      vscode.window.showWarningMessage(msg);
    }
    return;
  }
  const baseUrl = (vscode.workspace.getConfiguration('vibeflow').get<string>('serverUrl', DEFAULT_BASE_URL) || DEFAULT_BASE_URL).trim();

  let args: string[];
  if (opts.auto) {
    args = buildBootstrapArgs({ apiKey, baseUrl, all: true });
  } else {
    const configured = new Set(detectConfiguredMcpAgents());
    // Pre-check the agents that aren't wired up yet, so the common case
    // (configure what's missing) is one Enter away while still letting the
    // user re-run against an already-configured agent to repair it.
    const agents = await pickAgents(
      'Select coding agents to configure for the VibeFlow MCP server',
      a => !configured.has(a.label),
    );
    if (agents === undefined) {
      return; // dismissed
    }
    if (agents.length === 0) {
      vscode.window.showInformationMessage('No agents selected — nothing to configure.');
      return;
    }
    args = buildBootstrapArgs({ apiKey, baseUrl, agents });
  }

  await runVibeflow(binary, args, {
    title: 'Configuring VibeFlow MCP…',
    success: 'VibeFlow MCP configured for your coding agents.',
    secret: apiKey,
  });
}

/**
 * Remove the VibeFlow MCP server entry from selected coding agents via
 * `vibeflow uninstall`. No API key needed — only the server entry is removed,
 * sibling MCP servers are preserved by the CLI.
 */
export async function uninstallMcp(): Promise<void> {
  const binary = resolveBinary();
  if (!binary) {
    vscode.window.showWarningMessage('VibeFlow CLI not found.');
    return;
  }
  const configured = new Set(detectConfiguredMcpAgents());
  const agents = await pickAgents(
    'Select coding agents to remove the VibeFlow MCP server from',
    a => configured.has(a.label),
  );
  if (agents === undefined) {
    return; // dismissed
  }
  if (agents.length === 0) {
    vscode.window.showInformationMessage('No agents selected — nothing to remove.');
    return;
  }
  await runVibeflow(binary, ['uninstall', '--agents', agents.join(',')], {
    title: 'Removing VibeFlow MCP config…',
    success: 'VibeFlow MCP config removed.',
  });
}
