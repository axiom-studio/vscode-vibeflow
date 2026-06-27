import { describe, it, expect } from 'vitest';
import { buildBootstrapArgs, redactBootstrapArgs, hasVibeflowEntry } from './cliBootstrap.js';

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
