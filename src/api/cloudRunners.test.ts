import { describe, it, expect } from 'vitest';
import {
  FEATURE_CLOUD_RUNNERS,
  isFeatureEnabled,
  cloudRunnersEnabled,
  unwrapList,
  validateCreateRunner,
  parseRepoUrls,
  runnerPollState,
  createRunnerErrorMessage,
  isRunnerRunning,
  isRunnerTransitioning,
  runnerActionErrorMessage,
  canManageRunner,
  isPodReady,
  authCompletesAutomatically,
  canLaunch,
  routeInitialStep,
  firstPresent,
  buildRunnerManifest,
  VIBEFLOW_PERSONAS,
  type LaunchConfig,
} from './cloudRunners.js';
import type { FeatureFlags, CreateRunnerRequest } from './types.js';

describe('FEATURE_CLOUD_RUNNERS', () => {
  it('is the exact org flag key the AxiomCloud middleware gates on', () => {
    expect(FEATURE_CLOUD_RUNNERS).toBe('feature_cloud_runners');
  });
});

describe('isFeatureEnabled', () => {
  it('returns true only when the flag is strictly true', () => {
    const flags: FeatureFlags = { flags: { feature_cloud_runners: true, feature_clickup: false } };
    expect(isFeatureEnabled(flags, 'feature_cloud_runners')).toBe(true);
    expect(isFeatureEnabled(flags, 'feature_clickup')).toBe(false);
  });

  it('treats a missing key as disabled', () => {
    const flags: FeatureFlags = { flags: { feature_clickup: true } };
    expect(isFeatureEnabled(flags, 'feature_cloud_runners')).toBe(false);
  });

  it('treats an empty flag map as disabled', () => {
    expect(isFeatureEnabled({ flags: {} }, 'feature_cloud_runners')).toBe(false);
  });

  it('does not throw on undefined / null envelopes', () => {
    expect(isFeatureEnabled(undefined, 'feature_cloud_runners')).toBe(false);
    expect(isFeatureEnabled(null, 'feature_cloud_runners')).toBe(false);
  });

  it('does not coerce truthy non-boolean values to enabled', () => {
    // A malformed server payload with a stringy "true" must NOT enable the gate.
    const flags = { flags: { feature_cloud_runners: 'true' } } as unknown as FeatureFlags;
    expect(isFeatureEnabled(flags, 'feature_cloud_runners')).toBe(false);
  });
});

describe('cloudRunnersEnabled', () => {
  it('reads the feature_cloud_runners key specifically', () => {
    expect(cloudRunnersEnabled({ flags: { feature_cloud_runners: true } })).toBe(true);
    expect(cloudRunnersEnabled({ flags: { feature_cloud_runners: false } })).toBe(false);
    expect(cloudRunnersEnabled({ flags: {} })).toBe(false);
    expect(cloudRunnersEnabled(undefined)).toBe(false);
  });
});

describe('unwrapList', () => {
  it('returns the array under the given key', () => {
    expect(unwrapList<number>({ runners: [1, 2, 3] }, 'runners')).toEqual([1, 2, 3]);
    expect(unwrapList<string>({ providers: ['a'] }, 'providers')).toEqual(['a']);
  });

  it('returns an empty array when the key is missing', () => {
    expect(unwrapList({ other: [1] }, 'runners')).toEqual([]);
  });

  it('returns an empty array when the value is not an array', () => {
    expect(unwrapList({ runners: null }, 'runners')).toEqual([]);
    expect(unwrapList({ runners: 'nope' }, 'runners')).toEqual([]);
    expect(unwrapList({ runners: { 0: 'x' } }, 'runners')).toEqual([]);
  });

  it('returns an empty array for null / undefined / non-object envelopes', () => {
    expect(unwrapList(null, 'runners')).toEqual([]);
    expect(unwrapList(undefined, 'runners')).toEqual([]);
    expect(unwrapList('runners', 'runners')).toEqual([]);
    expect(unwrapList(42, 'runners')).toEqual([]);
  });

  it('preserves an empty array (zero rows is success, not an error)', () => {
    expect(unwrapList({ runners: [] }, 'runners')).toEqual([]);
  });
});

describe('validateCreateRunner', () => {
  const base: CreateRunnerRequest = { name: 'vscode-dev', agentType: 'claude', authMode: 'api_key' };

  it('accepts a minimal valid body', () => {
    expect(validateCreateRunner(base)).toBeNull();
  });

  it('rejects a missing or whitespace-only name', () => {
    expect(validateCreateRunner({ ...base, name: '' })).toBe('name is required');
    expect(validateCreateRunner({ ...base, name: '   ' })).toBe('name is required');
  });

  it('rejects gitRepos without a gitProviderId (mirrors the server rule)', () => {
    expect(
      validateCreateRunner({ ...base, gitRepos: [{ url: 'https://github.com/acme/app' }] }),
    ).toBe('repositories require a git provider');
  });

  it('accepts gitRepos when a gitProviderId is present', () => {
    expect(
      validateCreateRunner({
        ...base,
        gitProviderId: 12,
        gitRepos: [{ url: 'https://github.com/acme/app' }],
      }),
    ).toBeNull();
  });

  it('accepts a gitProviderId with no repos (credentials-only)', () => {
    expect(validateCreateRunner({ ...base, gitProviderId: 12 })).toBeNull();
  });

  it('treats an empty gitRepos array as no repos', () => {
    expect(validateCreateRunner({ ...base, gitRepos: [] })).toBeNull();
  });
});

describe('parseRepoUrls', () => {
  it('splits on commas and newlines, trimming and dropping blanks', () => {
    expect(parseRepoUrls('https://github.com/a/b, https://github.com/c/d')).toEqual([
      { url: 'https://github.com/a/b' },
      { url: 'https://github.com/c/d' },
    ]);
    expect(parseRepoUrls('https://x/1\n  https://x/2 \n')).toEqual([
      { url: 'https://x/1' },
      { url: 'https://x/2' },
    ]);
  });

  it('returns an empty list for empty or whitespace-only input', () => {
    expect(parseRepoUrls('')).toEqual([]);
    expect(parseRepoUrls('   ,  \n , ')).toEqual([]);
  });
});

describe('runnerPollState', () => {
  it('maps active/failed to terminal states and everything else to pending', () => {
    expect(runnerPollState('active')).toBe('active');
    expect(runnerPollState('failed')).toBe('failed');
    expect(runnerPollState('pending')).toBe('pending');
    expect(runnerPollState('starting')).toBe('pending');
    expect(runnerPollState('stopping')).toBe('pending');
    expect(runnerPollState('')).toBe('pending');
  });
});

describe('createRunnerErrorMessage', () => {
  it('maps 403 to a permission message', () => {
    expect(createRunnerErrorMessage(403, 'forbidden')).toMatch(/permission/i);
  });

  it('maps 502 and 503 to a transient-outage message', () => {
    expect(createRunnerErrorMessage(502, 'bad gateway')).toMatch(/temporarily unavailable/i);
    expect(createRunnerErrorMessage(503, 'unavailable')).toMatch(/temporarily unavailable/i);
  });

  it('falls back to the server text for other/unknown statuses', () => {
    expect(createRunnerErrorMessage(500, 'boom')).toBe('could not create cloud runner — boom');
    expect(createRunnerErrorMessage(undefined, 'network down')).toBe('could not create cloud runner — network down');
  });
});

describe('isRunnerRunning / isRunnerTransitioning', () => {
  it('treats active and running as running', () => {
    expect(isRunnerRunning('active')).toBe(true);
    expect(isRunnerRunning('running')).toBe(true);
    for (const s of ['stopped', 'starting', 'stopping', 'pending', 'failed', '']) {
      expect(isRunnerRunning(s)).toBe(false);
    }
  });

  it('treats starting and stopping as transitioning', () => {
    expect(isRunnerTransitioning('starting')).toBe(true);
    expect(isRunnerTransitioning('stopping')).toBe(true);
    for (const s of ['active', 'running', 'stopped', 'pending', 'failed', '']) {
      expect(isRunnerTransitioning(s)).toBe(false);
    }
  });
});

describe('runnerActionErrorMessage', () => {
  it('maps 403/409/502/503 to specific messages', () => {
    expect(runnerActionErrorMessage(403, 'forbidden')).toMatch(/permission/i);
    expect(runnerActionErrorMessage(409, 'conflict')).toMatch(/current state/i);
    expect(runnerActionErrorMessage(502, 'bad gateway')).toMatch(/temporarily unavailable/i);
    expect(runnerActionErrorMessage(503, 'unavailable')).toMatch(/temporarily unavailable/i);
  });

  it('softens transient pod/DNS errors to "still starting"', () => {
    expect(runnerActionErrorMessage(500, 'dial tcp: no such host')).toMatch(/still starting/i);
    expect(runnerActionErrorMessage(undefined, 'connection refused')).toMatch(/still starting/i);
  });

  it('passes through an unrecognized server message', () => {
    expect(runnerActionErrorMessage(400, 'name is required')).toBe('name is required');
  });
});

describe('canManageRunner', () => {
  it('is false for stopped/stopping/starting (no manageable pod)', () => {
    for (const s of ['stopped', 'stopping', 'starting']) {
      expect(canManageRunner(s)).toBe(false);
    }
  });
  it('is true for active/pending/failed', () => {
    for (const s of ['active', 'running', 'pending', 'failed']) {
      expect(canManageRunner(s)).toBe(true);
    }
  });
});

describe('isPodReady', () => {
  it('matches the ready pod-status family, case-insensitively', () => {
    for (const p of ['Running', 'healthy', 'READY', 'available', 'Succeeded']) {
      expect(isPodReady(p)).toBe(true);
    }
  });
  it('is false for not-ready / missing pod status', () => {
    for (const p of ['pending', 'scheduling', undefined, '']) {
      expect(isPodReady(p)).toBe(false);
    }
  });
});

describe('authCompletesAutomatically', () => {
  it('is true for codex/cursor and false for claude/unknown', () => {
    expect(authCompletesAutomatically('codex')).toBe(true);
    expect(authCompletesAutomatically('cursor')).toBe(true);
    expect(authCompletesAutomatically('claude')).toBe(false);
    expect(authCompletesAutomatically(undefined)).toBe(false);
  });
});

describe('canLaunch', () => {
  it('requires a working dir, a project, and ≥1 persona', () => {
    expect(canLaunch('/w', 'proj', ['developer'])).toBe(true);
    expect(canLaunch('', 'proj', ['developer'])).toBe(false);
    expect(canLaunch('/w', '  ', ['developer'])).toBe(false);
    expect(canLaunch('/w', 'proj', [])).toBe(false);
  });
});

describe('routeInitialStep', () => {
  it('lands on configure when authenticated or configured', () => {
    expect(routeInitialStep({ authenticated: true, authMode: 'oauth' })).toBe('configure');
    expect(routeInitialStep({ configured: true, authMode: 'oauth' })).toBe('configure');
  });
  it('starts at authenticate for an unauthenticated oauth runner', () => {
    expect(routeInitialStep({ authMode: 'oauth' })).toBe('authenticate');
  });
  it('defaults to configure for non-oauth', () => {
    expect(routeInitialStep({ authMode: 'api_key' })).toBe('configure');
    expect(routeInitialStep({})).toBe('configure');
  });
});

describe('firstPresent', () => {
  it('returns the first non-empty value', () => {
    expect(firstPresent(undefined, '', 'https://x')).toBe('https://x');
    expect(firstPresent('a', 'b')).toBe('a');
    expect(firstPresent(undefined, '')).toBe('');
  });
});

describe('VIBEFLOW_PERSONAS', () => {
  it('is the 9 canonical personas', () => {
    expect(VIBEFLOW_PERSONAS).toHaveLength(9);
    expect(VIBEFLOW_PERSONAS).toContain('principal_engineer');
    expect(VIBEFLOW_PERSONAS).toContain('security_lead');
  });
});

describe('buildRunnerManifest', () => {
  const cfg: LaunchConfig = {
    agentType: 'claude', authMode: 'oauth', project: 'vscode-vibeflow',
    personas: ['principal_engineer', 'qa_lead'], sessionType: 'vibeflow',
    workingDir: '/workspace/repos/app', branch: 'main', worktree: false,
    newBranch: false, llmGateway: false, skipPermissions: true,
  };

  it('produces a RunnerSession doc with the config wired through', () => {
    const m = buildRunnerManifest(cfg) as Record<string, any>;
    expect(m.kind).toBe('RunnerSession');
    expect(m.vibeflow.project).toBe('vscode-vibeflow');
    expect(m.vibeflow.personas).toEqual(['principal_engineer', 'qa_lead']);
    expect(m.repos[0]).toEqual({ path: '/workspace/repos/app', branch: 'main', trusted: true });
    expect(m.agent).toMatchObject({ type: 'claude', authMode: 'oauth', skipPermissions: true });
  });

  it('NEVER embeds a real secret — only ${VAULT:...} placeholders', () => {
    const json = JSON.stringify(buildRunnerManifest({ ...cfg, personas: ['developer'] }));
    expect(json).toContain('${VAULT:base_url}');
    expect(json).toContain('${VAULT:api_key}');
    // The server resolves the vault refs; the client must not inline a token.
    const m = buildRunnerManifest(cfg) as Record<string, any>;
    expect(m.vibeflow.apiToken).toBe('${VAULT:api_key}');
    expect(m.vibeflow.serverUrl).toBe('${VAULT:base_url}');
    expect(m.mcpServers[0].headers.Authorization).toBe('Bearer ${VAULT:api_key}');
  });
});
