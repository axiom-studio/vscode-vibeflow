import { describe, it, expect } from 'vitest';
import { buildBootstrapArgs, redactBootstrapArgs, hasVibeflowEntry, mcpAgentStatuses } from './cliBootstrap.js';

describe('buildBootstrapArgs', () => {
  it('builds an --all invocation when all is set, with no --agents', () => {
    const args = buildBootstrapArgs({ apiKey: 'k', baseUrl: 'https://cloud.example.ai', all: true });
    expect(args).toEqual(['bootstrap', '--api-key', 'k', '--base-url', 'https://cloud.example.ai', '--all']);
    expect(args).not.toContain('--agents');
  });

  it('passes the selected agents as a CSV --agents value', () => {
    const args = buildBootstrapArgs({ apiKey: 'k', baseUrl: 'https://x', agents: ['claude-cli', 'cursor'] });
    const i = args.indexOf('--agents');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('claude-cli,cursor');
  });

  it('threads the base URL through so agents target the configured server', () => {
    const args = buildBootstrapArgs({ apiKey: 'k', baseUrl: 'https://self-hosted.internal', agents: ['gemini'] });
    const i = args.indexOf('--base-url');
    expect(args[i + 1]).toBe('https://self-hosted.internal');
  });

  it('omits --agents entirely when the agent list is empty (and not all)', () => {
    const args = buildBootstrapArgs({ apiKey: 'k', baseUrl: 'https://x', agents: [] });
    expect(args).toEqual(['bootstrap', '--api-key', 'k', '--base-url', 'https://x']);
  });
});

describe('redactBootstrapArgs', () => {
  it('masks the api-key value so argv is safe to log', () => {
    const args = buildBootstrapArgs({ apiKey: 'super-secret-token', baseUrl: 'https://x', all: true });
    const redacted = redactBootstrapArgs(args);
    expect(redacted).not.toContain('super-secret-token');
    expect(redacted[redacted.indexOf('--api-key') + 1]).toBe('***');
    // original is untouched (still carries the real key for execFile)
    expect(args).toContain('super-secret-token');
  });

  it('is a no-op when there is no --api-key (uninstall path)', () => {
    const args = ['uninstall', '--agents', 'cursor'];
    expect(redactBootstrapArgs(args)).toEqual(args);
  });
});

describe('hasVibeflowEntry (json)', () => {
  it('detects the vibeflow server under mcpServers', () => {
    const content = JSON.stringify({ mcpServers: { vibeflow: { type: 'http', url: 'https://x' } } });
    expect(hasVibeflowEntry(content, 'json')).toBe(true);
  });

  it('returns false when only a sibling server is present', () => {
    const content = JSON.stringify({ mcpServers: { somethingElse: {} } });
    expect(hasVibeflowEntry(content, 'json')).toBe(false);
  });

  it('returns false when mcpServers is absent', () => {
    expect(hasVibeflowEntry(JSON.stringify({ other: 1 }), 'json')).toBe(false);
  });

  it('returns false for invalid JSON rather than throwing', () => {
    expect(hasVibeflowEntry('{ not json', 'json')).toBe(false);
  });
});

describe('hasVibeflowEntry (toml / codex)', () => {
  it('detects the [mcp_servers.vibeflow] section', () => {
    const content = '[mcp_servers.vibeflow]\nurl = "https://x"\nbearer_token_env_var = "MCP_TOKEN"\n';
    expect(hasVibeflowEntry(content, 'toml')).toBe(true);
  });

  it('returns false when only a sibling section exists', () => {
    const content = '[mcp_servers.other]\nurl = "https://x"\n';
    expect(hasVibeflowEntry(content, 'toml')).toBe(false);
  });
});

/**
 * Kiro's presence in MCP_AGENTS (#4201).
 *
 * Asserted through `mcpAgentStatuses()` rather than by exporting the array:
 * that function and `pickAgents()` both derive from MCP_AGENTS, so proving
 * Kiro surfaces here proves it reaches BOTH the agent picker and the
 * bootstrapped/not-bootstrapped status line — the two places it was missing.
 * `uninstallMcp()` routes through the same `pickAgents()`, so install and
 * uninstall stay symmetric by construction.
 *
 * The key is the `--agents` CSV value forwarded to the CLI binary, so it must
 * match vibeflow-cli's own agent key exactly (bootstrap.go:78) — the
 * extension writes no config itself.
 */
describe('MCP_AGENTS — Kiro support (#4201)', () => {
  it('exposes Kiro to the picker and status detection', () => {
    const kiro = mcpAgentStatuses().find(a => a.key === 'kiro');
    expect(kiro).toBeDefined();
    expect(kiro?.label).toBe('Kiro CLI');
  });

  it('keeps every previously supported agent', () => {
    // Guards against a careless edit dropping an agent while adding one.
    const keys = mcpAgentStatuses().map(a => a.key);
    expect(keys).toEqual(
      expect.arrayContaining(['codex', 'gemini', 'cursor', 'claude-cli', 'claude-desktop', 'kiro']),
    );
  });

  it('reports a status for every agent without throwing on absent config', () => {
    // configPath() is called for each agent; a missing file must degrade to
    // `enabled: false`, never an exception.
    const statuses = mcpAgentStatuses();
    expect(statuses.length).toBeGreaterThanOrEqual(6);
    for (const s of statuses) {
      expect(typeof s.enabled).toBe('boolean');
    }
  });
});
