import * as vscode from 'vscode';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { VibeFlowClient } from '../../api/client.js';

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
export function ensureMcpConfig(workDir: string, serverUrl: string, client: VibeFlowClient): void {
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
export function ensureMcpJsonIsGitIgnored(workDir: string): boolean {
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
export function isPathIgnoredByGit(workDir: string, relPath: string): boolean {
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
