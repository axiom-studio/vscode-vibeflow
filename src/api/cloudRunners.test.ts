import { describe, it, expect } from 'vitest';
import {
  FEATURE_CLOUD_RUNNERS,
  isFeatureEnabled,
  cloudRunnersEnabled,
  CLOUD_RUNNERS_BUILD_ENABLED,
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
  deriveTerminalWsUrl,
  extractTerminalSessionId,
  encodeTerminalBind,
  encodeTerminalStdin,
  encodeTerminalResize,
  parseTerminalServerMessage,
  suggestRunnerName,
  summarizeResponseShape,
  redactSecretsDeep,
  isSensitiveBodyPath,
  unwrapStatusEnvelope,
  summarizeRepos,
  validateRunnerName,
  RUNNER_NAME_RULES,
  RUNNER_NAME_MAX,
  LOGIN_METHODS,
  manifestToSavedConfig,
  WORKSPACE_PERSONAS,
  ADVISORY_PERSONAS,
  togglePersonaSelection,
  MODEL_OPTIONS_BY_AGENT,
  defaultModelForAgent,
  modelOptionsForAgent,
  isPresetModel,
  gitRepoUrlAuthError,
  llmGatewaySupportedForAgent,
  runnerHealthIcon,
  runnerPrimaryAction,
  bulkEligibility,
  createRunnerReviewLines,
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
  it('reads the feature_cloud_runners key specifically (build switch forced on)', () => {
    expect(cloudRunnersEnabled({ flags: { feature_cloud_runners: true } }, true)).toBe(true);
    expect(cloudRunnersEnabled({ flags: { feature_cloud_runners: false } }, true)).toBe(false);
    expect(cloudRunnersEnabled({ flags: {} }, true)).toBe(false);
    expect(cloudRunnersEnabled(undefined, true)).toBe(false);
  });

  it('is fully disabled while the build switch is off, regardless of the org flag (#2833)', () => {
    expect(cloudRunnersEnabled({ flags: { feature_cloud_runners: true } }, false)).toBe(false);
    // The default tracks the compiled-in constant — this stays correct when
    // the switch is later flipped to true.
    expect(cloudRunnersEnabled({ flags: { feature_cloud_runners: true } })).toBe(CLOUD_RUNNERS_BUILD_ENABLED);
    expect(cloudRunnersEnabled({ flags: { feature_cloud_runners: false } })).toBe(false);
  });
});

describe('unwrapList', () => {
  it('returns the array under the given key', () => {
    expect(unwrapList<number>({ runners: [1, 2, 3] }, 'runners')).toEqual([1, 2, 3]);
    expect(unwrapList<string>({ providers: ['a'] }, 'providers')).toEqual(['a']);
  });

  it('falls back to the sole array property when the documented key is absent (#3393 shape drift)', () => {
    expect(unwrapList({ git_providers: [{ id: 1 }] }, 'providers')).toEqual([{ id: 1 }]);
    expect(unwrapList({ items: [1, 2] }, 'runners')).toEqual([1, 2]);
  });

  it('handles a bare top-level array (#3393)', () => {
    expect(unwrapList([{ id: 1 }, { id: 2 }], 'providers')).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('returns an empty array when there is no array to find', () => {
    expect(unwrapList({ other: 'x', n: 1 }, 'runners')).toEqual([]);
  });

  it('does not guess when multiple array properties are present (ambiguous → empty)', () => {
    expect(unwrapList({ a: [1], b: [2] }, 'runners')).toEqual([]);
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

  it('accepts every supported agent type — claude, codex, cursor (#2823)', () => {
    for (const agentType of ['claude', 'codex', 'cursor'] as const) {
      expect(validateCreateRunner({ ...base, agentType })).toBeNull();
    }
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

  it('applies an explicit branch to every entry, omitting the field otherwise (#2883)', () => {
    expect(parseRepoUrls('https://x/1, https://x/2', 'master')).toEqual([
      { url: 'https://x/1', branch: 'master' },
      { url: 'https://x/2', branch: 'master' },
    ]);
    // No branch → {url} only (wire-compatible with the previous shape).
    expect(parseRepoUrls('https://x/1')[0]).toEqual({ url: 'https://x/1' });
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

  it("accepts cortex's live vocabulary (#3630): running = success, error = failure", () => {
    // Provisioned detail GETs relay cortex, which emits running/error — never
    // 'active'/'failed' (those are axiomcloud's local-row statuses).
    expect(runnerPollState('running')).toBe('active');
    expect(runnerPollState('error')).toBe('failed');
    expect(runnerPollState('authenticating')).toBe('pending');
    // The raw envelope status text must never read as terminal.
    expect(runnerPollState('OK')).toBe('pending');
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
  it('treats active, running, and authenticating as running', () => {
    expect(isRunnerRunning('active')).toBe(true);
    expect(isRunnerRunning('running')).toBe(true);
    // Mid-login pod is up (#437 §1) — the row offers Stop, not Start.
    expect(isRunnerRunning('authenticating')).toBe(true);
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

describe('suggestRunnerName', () => {
  it('appends the caller-supplied random salt to the trimmed base name (#3395)', () => {
    expect(suggestRunnerName('vscode-dev', 'a3f9')).toBe('vscode-dev-a3f9');
    expect(suggestRunnerName('  spaced  ', 'k7')).toBe('spaced-k7');
    // The base is used verbatim (no -N walking through reserved names).
    expect(suggestRunnerName('foo-2', 'zz')).toBe('foo-2-zz');
  });
});

describe('redactSecretsDeep (#3400)', () => {
  it('masks credential-named fields at any depth, preserving structure', () => {
    const input = {
      name: 'gh', gitUrl: 'https://github.com', authType: 'pat',
      accessToken: 'ghp_secret', sshPrivateKey: '-----BEGIN KEY-----',
      nested: { apiKey: 'sk-live-123', Authorization: 'Bearer abc', keep: 42 },
      list: [{ api_key: 'x', ok: true }],
    };
    expect(redactSecretsDeep(input)).toEqual({
      name: 'gh', gitUrl: 'https://github.com', authType: 'pat',
      accessToken: '***', sshPrivateKey: '***',
      nested: { apiKey: '***', Authorization: '***', keep: 42 },
      list: [{ api_key: '***', ok: true }],
    });
  });

  it('never leaks a secret value into the serialized output', () => {
    const json = JSON.stringify(redactSecretsDeep({ apiToken: 'tok-999', body: { password: 'hunter2' } }));
    expect(json).not.toContain('tok-999');
    expect(json).not.toContain('hunter2');
  });

  it('passes through primitives, arrays and null untouched', () => {
    expect(redactSecretsDeep('plain')).toBe('plain');
    expect(redactSecretsDeep(null)).toBeNull();
    expect(redactSecretsDeep([1, 'a'])).toEqual([1, 'a']);
  });
});

describe('summarizeResponseShape', () => {
  it('describes a wrapped list by key + length', () => {
    expect(summarizeResponseShape({ providers: [{ id: 1 }, { id: 2 }] })).toBe('{providers[2]}');
    expect(summarizeResponseShape({ git_providers: [{ id: 1 }] })).toBe('{git_providers[1]}');
  });
  it('describes a bare array and scalar/object shapes without values', () => {
    expect(summarizeResponseShape([1, 2, 3])).toBe('array[3]');
    expect(summarizeResponseShape({ id: 1, name: 'x', authMode: 'pat' })).toBe('{id:number, name:string, authMode:string}');
    expect(summarizeResponseShape('hi')).toBe('string');
    expect(summarizeResponseShape(null)).toBe('object');
  });
  it('never leaks values — only keys, lengths and types', () => {
    const out = summarizeResponseShape({ providers: [{ accessToken: 'ghp_secret' }] });
    expect(out).toBe('{providers[1]}');
    expect(out).not.toContain('ghp_secret');
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
  it('requires a working dir, a project, and exactly one workspace persona (#2887)', () => {
    expect(canLaunch('/w', 'proj', ['developer'])).toBe(true);
    expect(canLaunch('/w', 'proj', ['principal_engineer', 'qa_lead'])).toBe(true);
    expect(canLaunch('', 'proj', ['developer'])).toBe(false);
    expect(canLaunch('/w', '  ', ['developer'])).toBe(false);
    expect(canLaunch('/w', 'proj', [])).toBe(false);
    // Advisory-only sessions write no code — blocked.
    expect(canLaunch('/w', 'proj', ['qa_lead', 'security_lead'])).toBe(false);
    // Two workspace agents would fight over the branch lock — blocked.
    expect(canLaunch('/w', 'proj', ['developer', 'architect'])).toBe(false);
  });
});

describe('persona grouping (#2887)', () => {
  it('partitions the 9 personas into 3 workspace + 6 advisory', () => {
    expect([...WORKSPACE_PERSONAS]).toEqual(['developer', 'principal_engineer', 'architect']);
    expect(ADVISORY_PERSONAS).toHaveLength(6);
    expect(ADVISORY_PERSONAS).not.toContain('developer');
  });

  it('workspace picks replace each other (radio semantics), advisory picks toggle', () => {
    let sel: string[] = [];
    sel = togglePersonaSelection(sel, 'developer');
    expect(sel).toEqual(['developer']);
    sel = togglePersonaSelection(sel, 'qa_lead');
    expect(sel).toEqual(['developer', 'qa_lead']);
    sel = togglePersonaSelection(sel, 'architect'); // replaces developer
    expect(sel).toEqual(['architect', 'qa_lead']);
    sel = togglePersonaSelection(sel, 'qa_lead'); // toggles off
    expect(sel).toEqual(['architect']);
    // Re-picking the current workspace persona is a no-op (radio can't untick).
    expect(togglePersonaSelection(sel, 'architect')).toEqual(['architect']);
  });

  it('manifestToSavedConfig keeps only the first workspace persona from a stale manifest', () => {
    const cfg = manifestToSavedConfig({
      vibeflow: { personas: ['developer', 'architect', 'qa_lead', 'principal_engineer'] },
    });
    expect(cfg?.personas).toEqual(['developer', 'qa_lead']);
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

  it('routes an authenticating runner to the auth workflow even without authMode (#437)', () => {
    // The provisioned-runner detail relays the Studio view, which may drop
    // authMode — the LIVE status must be enough to reach the auth step.
    expect(routeInitialStep({ status: 'authenticating' })).toBe('authenticate');
    expect(routeInitialStep({ status: 'Authenticate' })).toBe('authenticate');
    expect(routeInitialStep({ status: 'authenticating', authMode: 'oauth' })).toBe('authenticate');
  });

  it('authenticated wins over a stale authenticating status (#437 §2 normalization)', () => {
    expect(routeInitialStep({ authenticated: true, status: 'authenticating' })).toBe('configure');
    expect(routeInitialStep({ configured: true, status: 'authenticating' })).toBe('configure');
  });

  it('does not route non-auth statuses to authenticate without oauth', () => {
    expect(routeInitialStep({ status: 'running' })).toBe('configure');
    expect(routeInitialStep({ status: 'stopped', authMode: 'api_key' })).toBe('configure');
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

interface ManifestShape {
  kind: string;
  agent: { type: string; authMode: string; skipPermissions: boolean };
  vibeflow: { project: string; personas: string[]; apiToken: string; serverUrl: string };
  mcpServers: { headers: { Authorization: string } }[];
  repos: { path: string; branch: string; trusted: boolean }[];
}

describe('buildRunnerManifest', () => {
  const cfg: LaunchConfig = {
    agentType: 'claude', authMode: 'oauth', project: 'vscode-vibeflow',
    personas: ['principal_engineer', 'qa_lead'], sessionType: 'vibeflow',
    workingDir: '/workspace/repos/app', branch: 'main', worktree: false,
    newBranch: false, llmGateway: false, skipPermissions: true,
  };

  it('produces a RunnerSession doc with the config wired through', () => {
    const m = buildRunnerManifest(cfg) as unknown as ManifestShape;
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
    const m = buildRunnerManifest(cfg) as unknown as ManifestShape;
    expect(m.vibeflow.apiToken).toBe('${VAULT:api_key}');
    expect(m.vibeflow.serverUrl).toBe('${VAULT:base_url}');
    expect(m.mcpServers[0].headers.Authorization).toBe('Bearer ${VAULT:api_key}');
  });

  it('carries a provided loginMethod into agent config (Console-billing Claude, device-auth Codex)', () => {
    const console_ = buildRunnerManifest({ ...cfg, loginMethod: 'console' }) as unknown as { agent: { loginMethod: string } };
    expect(console_.agent.loginMethod).toBe('console');
    const codex = buildRunnerManifest({ ...cfg, agentType: 'codex', loginMethod: 'device_auth' }) as unknown as { agent: { loginMethod: string } };
    expect(codex.agent.loginMethod).toBe('device_auth');
  });

  it("falls back to 'claude' when the runner detail carried no loginMethod (web parity: detail.loginMethod || 'claude')", () => {
    const m = buildRunnerManifest(cfg) as unknown as { agent: { loginMethod: string } };
    expect(m.agent.loginMethod).toBe('claude');
  });

  it('emits agent.model only when a model is chosen, and always launches runMode direct (#2886)', () => {
    const withModel = buildRunnerManifest({ ...cfg, model: 'claude-opus-4.8' }) as unknown as { agent: { model?: string }; vibeflow: { runMode: string } };
    expect(withModel.agent.model).toBe('claude-opus-4.8');
    expect(withModel.vibeflow.runMode).toBe('direct');
    const withoutModel = buildRunnerManifest(cfg) as unknown as { agent: Record<string, unknown> };
    expect('model' in withoutModel.agent).toBe(false); // server default applies
  });
});

describe('createRunnerReviewLines (#2894)', () => {
  it('summarizes an OAuth runner with a git provider and repos — never the apiKey value', () => {
    const lines = createRunnerReviewLines({
      name: 'dev-box', agentType: 'claude', authMode: 'oauth', loginMethod: 'console',
      gitProviderId: 4, gitRepos: [{ url: 'https://github.com/o/r.git', branch: 'develop' }],
    });
    expect(lines).toContain('Name: dev-box');
    expect(lines).toContain('Agent: claude');
    expect(lines).toContain('Auth: OAuth');
    expect(lines).toContain('Login method: console');
    expect(lines).toContain('Git provider: #4');
    expect(lines.some(l => l.startsWith('Repos:') && l.includes('branch develop'))).toBe(true);
  });

  it('reports API-key presence without leaking the value, and omits absent fields', () => {
    const withKey = createRunnerReviewLines({ name: 'a', agentType: 'codex', authMode: 'api_key', apiKey: 'sk-supersecret' });
    expect(withKey).toContain('API key: provided');
    expect(withKey.join('\n')).not.toContain('sk-supersecret');
    expect(withKey.some(l => l.startsWith('Git provider'))).toBe(false);
    expect(createRunnerReviewLines({ name: 'b', agentType: 'cursor', authMode: 'api_key' })).toContain('API key: missing');
  });
});

describe('bulkEligibility (#2893)', () => {
  it('counts startable (not running) and stoppable (running) rows, skipping transitioning', () => {
    expect(bulkEligibility(['stopped', 'running', 'active', 'starting', 'stopping', 'failed'])).toEqual({
      startable: 2, // stopped + failed
      stoppable: 2, // running + active
      // starting/stopping skipped
    });
    expect(bulkEligibility([])).toEqual({ startable: 0, stoppable: 0 });
    expect(bulkEligibility(['authenticating'])).toEqual({ startable: 0, stoppable: 1 }); // pod up
  });
});

describe('runnerPrimaryAction (#2891)', () => {
  it('derives the one-click action from the (status, podStatus) tuple like the web', () => {
    expect(runnerPrimaryAction('stopped', '')).toEqual({ label: 'Stopped', disabled: true });
    expect(runnerPrimaryAction('stopping', 'Healthy')).toEqual({ label: 'Stopped', disabled: true });
    expect(runnerPrimaryAction('failed', '')).toEqual({ label: 'Manage Agents', disabled: false });
    expect(runnerPrimaryAction('running', 'Degraded')).toEqual({ label: 'Manage Agents', disabled: false });
    expect(runnerPrimaryAction('authenticating', 'Healthy')).toEqual({ label: 'Authenticate', disabled: false });
    expect(runnerPrimaryAction('running', 'Healthy')).toEqual({ label: 'Manage Agents', disabled: false });
    expect(runnerPrimaryAction('active', 'Healthy')).toEqual({ label: 'Manage Agents', disabled: false });
    // Healthy pod required for the one-click paths — otherwise still coming up.
    expect(runnerPrimaryAction('authenticating', 'Progressing')).toEqual({ label: 'Initializing', disabled: true });
    expect(runnerPrimaryAction('pending', '')).toEqual({ label: 'Initializing', disabled: true });
  });
});

describe('runnerHealthIcon (#2890)', () => {
  it('classifies the (status, podStatus) tuple like the web', () => {
    expect(runnerHealthIcon('stopped', '')).toEqual({ kind: 'none', title: '' });
    expect(runnerHealthIcon('stopping', 'Healthy')).toEqual({ kind: 'none', title: '' });
    expect(runnerHealthIcon('failed', 'Healthy').kind).toBe('error');
    expect(runnerHealthIcon('running', 'Degraded').kind).toBe('error');
    expect(runnerHealthIcon('running', 'Missing').kind).toBe('error');
    expect(runnerHealthIcon('running', 'Healthy')).toEqual({ kind: 'healthy', title: 'Healthy' });
    expect(runnerHealthIcon('pending', '').kind).toBe('busy');
    expect(runnerHealthIcon('authenticating', 'Progressing').kind).toBe('busy');
  });

  it('carries the stored strings in the error/busy tooltips', () => {
    expect(runnerHealthIcon('running', 'Degraded').title).toBe('Status: running · Health: Degraded');
    expect(runnerHealthIcon(undefined, undefined).title).toBe('Provisioning — Status: pending · Health: starting');
  });
});

describe('gitRepoUrlAuthError (#2888)', () => {
  it('requires SSH-style URLs for SSH providers and https for PAT/OAuth providers, foregrounding the repo URL', () => {
    // The message leads with the repo-URL requirement (#2904), not the provider.
    expect(gitRepoUrlAuthError('https://github.com/o/r.git', 'SSH')).toContain('repository URL must be an SSH URL');
    expect(gitRepoUrlAuthError('git@github.com:o/r.git', 'SSH')).toBe('');
    expect(gitRepoUrlAuthError('ssh://git@github.com/o/r.git', 'SSH')).toBe('');
    expect(gitRepoUrlAuthError('git@github.com:o/r.git', 'ACCESS_TOKEN')).toContain('repository URL must be an HTTPS URL');
    expect(gitRepoUrlAuthError('https://github.com/o/r.git', 'ACCESS_TOKEN')).toBe('');
    expect(gitRepoUrlAuthError('http://github.com/o/r.git', 'OAUTH')).toContain('repository URL must be an HTTPS URL');
  });

  it('tolerates lowercase auth modes and passes when there is no provider or URL', () => {
    expect(gitRepoUrlAuthError('git@github.com:o/r.git', 'pat')).toContain('repository URL must be an HTTPS URL');
    expect(gitRepoUrlAuthError('https://x/o/r', 'ssh')).toContain('repository URL must be an SSH URL');
    expect(gitRepoUrlAuthError('', 'SSH')).toBe('');
    expect(gitRepoUrlAuthError('https://x/o/r', undefined)).toBe('');
  });
});

describe('launch manifest deltas (#2888)', () => {
  const cfg: LaunchConfig = {
    agentType: 'claude', authMode: 'oauth', project: 'p', personas: ['developer'],
    sessionType: 'vibeflow', workingDir: '/w', branch: 'main', worktree: true,
    newBranch: false, llmGateway: true, skipPermissions: true,
  };

  it('emits vibeflow.worktreeName only when provided', () => {
    const withName = buildRunnerManifest({ ...cfg, worktreeName: 'wt-fix' }) as unknown as { vibeflow: { worktreeName?: string } };
    expect(withName.vibeflow.worktreeName).toBe('wt-fix');
    const without = buildRunnerManifest(cfg) as unknown as { vibeflow: Record<string, unknown> };
    expect('worktreeName' in without.vibeflow).toBe(false);
  });

  it('forces llmGateway off for cursor runners (gateway cannot proxy them)', () => {
    const cursor = buildRunnerManifest({ ...cfg, agentType: 'cursor' }) as unknown as { vibeflow: { llmGateway: boolean } };
    expect(cursor.vibeflow.llmGateway).toBe(false);
    const claude = buildRunnerManifest(cfg) as unknown as { vibeflow: { llmGateway: boolean } };
    expect(claude.vibeflow.llmGateway).toBe(true);
    expect(llmGatewaySupportedForAgent('cursor')).toBe(false);
    expect(llmGatewaySupportedForAgent('codex')).toBe(true);
  });
});

describe('model presets (#2886)', () => {
  it('covers every agent with a non-empty preset list and a valid default', () => {
    for (const agent of ['claude', 'codex', 'cursor']) {
      const options = MODEL_OPTIONS_BY_AGENT[agent];
      expect(options.length).toBeGreaterThan(0);
      expect(options.some(o => o.value === defaultModelForAgent(agent))).toBe(true);
    }
    expect(defaultModelForAgent(undefined)).toBe('claude-sonnet-5'); // unknown → claude default
  });

  it('injects a saved non-preset model as the first option (web parity)', () => {
    const options = modelOptionsForAgent('claude', 'my-org/custom-model');
    expect(options[0]).toEqual({ value: 'my-org/custom-model', label: 'my-org/custom-model' });
    // A preset current model does not duplicate.
    expect(modelOptionsForAgent('claude', 'claude-sonnet-5')).toEqual(MODEL_OPTIONS_BY_AGENT.claude);
  });

  it('classifies preset vs custom models per agent', () => {
    expect(isPresetModel('codex', 'gpt-5.5')).toBe(true);
    expect(isPresetModel('codex', 'claude-sonnet-5')).toBe(false);
    expect(isPresetModel(undefined, 'claude-sonnet-5')).toBe(true); // defaults to claude list
  });
});

describe('manifestToSavedConfig (#2885)', () => {
  it('recovers every Configure default from a full saved manifest', () => {
    const cfg = manifestToSavedConfig({
      agent: { type: 'claude', model: 'claude-opus-4.8', skipPermissions: false },
      vibeflow: {
        personas: ['principal_engineer', 'qa_lead', 'not-a-persona'],
        sessionType: 'vanilla', branch: 'develop', worktree: true,
        worktreeName: 'wt-1', newBranch: true, llmGateway: true,
      },
      repos: [{ path: '/workspace/repos/app', branch: 'develop', trusted: true }],
    });
    expect(cfg).toEqual({
      personas: ['principal_engineer', 'qa_lead'], // unknown persona dropped
      sessionType: 'vanilla', branch: 'develop', worktree: true,
      worktreeName: 'wt-1', newBranch: true, llmGateway: true,
      skipPermissions: false, workingDir: '/workspace/repos/app', model: 'claude-opus-4.8',
    });
  });

  it('leaves absent fields undefined so the form keeps its own defaults', () => {
    const cfg = manifestToSavedConfig({ vibeflow: { personas: ['developer'] } });
    expect(cfg?.personas).toEqual(['developer']);
    expect(cfg?.branch).toBeUndefined();
    expect(cfg?.sessionType).toBeUndefined();
    expect(cfg?.model).toBeUndefined();
    expect(cfg?.workingDir).toBeUndefined();
  });

  it('tolerates garbage: non-object manifests yield undefined, a missing vibeflow block yields empty personas', () => {
    expect(manifestToSavedConfig(undefined)).toBeUndefined();
    expect(manifestToSavedConfig('boom')).toBeUndefined();
    expect(manifestToSavedConfig({ agent: { skipPermissions: true } })?.personas).toEqual([]);
  });
});

describe('LOGIN_METHODS', () => {
  it('covers every creatable agent type with at least one method (the OAuth step depends on it)', () => {
    const agentTypes: CreateRunnerRequest['agentType'][] = ['claude', 'codex', 'cursor'];
    for (const t of agentTypes) {
      expect(LOGIN_METHODS[t].length).toBeGreaterThan(0);
    }
  });

  it("matches cortex's auth-strategy values (web CreateCloudRunnerModal parity)", () => {
    expect(LOGIN_METHODS.claude.map(m => m.value)).toEqual(['claude', 'console', 'third_party']);
    expect(LOGIN_METHODS.codex.map(m => m.value)).toEqual(['device_auth']);
    expect(LOGIN_METHODS.cursor.map(m => m.value)).toEqual(['cursor']);
  });
});

describe('deriveTerminalWsUrl', () => {
  it('upgrades https→wss and builds the terminal/ws path (the route axiomcloud registers)', () => {
    expect(deriveTerminalWsUrl('https://cloud.axiomstudio.ai', 28, 5))
      .toBe('wss://cloud.axiomstudio.ai/rest/v1/vibeflow/projects/28/cloud-runners/5/terminal/ws');
  });
  it('upgrades http→ws for localhost and strips query/hash', () => {
    expect(deriveTerminalWsUrl('http://localhost:8080/?x=1#f', 1, 2))
      .toBe('ws://localhost:8080/rest/v1/vibeflow/projects/1/cloud-runners/2/terminal/ws');
  });
  it('rejects empty or non-http(s) base URLs (no bearer over insecure transport)', () => {
    expect(() => deriveTerminalWsUrl('', 1, 1)).toThrow();
    expect(() => deriveTerminalWsUrl('ftp://x', 1, 1)).toThrow();
  });
});

describe('extractTerminalSessionId', () => {
  it('reads every spelling the relay can deliver (enveloped and bare, both casings)', () => {
    expect(extractTerminalSessionId({ result: { sessionId: 'a1' } })).toBe('a1');
    expect(extractTerminalSessionId({ result: { SessionID: 'b2' } })).toBe('b2');
    expect(extractTerminalSessionId({ sessionId: 'c3' })).toBe('c3');
    expect(extractTerminalSessionId({ SessionID: 'd4' })).toBe('d4');
  });
  it('returns empty when the id is absent or the response is malformed', () => {
    expect(extractTerminalSessionId({})).toBe('');
    expect(extractTerminalSessionId(null)).toBe('');
    expect(extractTerminalSessionId(undefined)).toBe('');
    expect(extractTerminalSessionId({ result: {} })).toBe('');
  });
});

describe('terminal message codec (cortex TerminalMessage protocol)', () => {
  it('encodes bind, stdin and resize frames with the capitalized wire fields', () => {
    expect(JSON.parse(encodeTerminalBind('sess-1'))).toEqual({ Op: 'bind', SessionID: 'sess-1' });
    expect(JSON.parse(encodeTerminalStdin('ls\n'))).toEqual({ Op: 'stdin', SessionID: '', Data: 'ls\n' });
    expect(JSON.parse(encodeTerminalResize(120, 40))).toEqual({ Op: 'resize', Cols: 120, Rows: 40 });
  });
  it('classifies stdout as terminal output', () => {
    expect(parseTerminalServerMessage('{"Op":"stdout","Data":"hello$ "}')).toEqual({ kind: 'stdout', data: 'hello$ ' });
  });
  it('classifies the bridge dial-failure error frame', () => {
    expect(parseTerminalServerMessage('{"Op":"error","Data":"pod gone"}')).toEqual({ kind: 'error', message: 'pod gone' });
    expect(parseTerminalServerMessage('{"Op":"error"}')).toEqual({ kind: 'error', message: 'terminal error' });
  });
  it('ignores other Ops and non-JSON frames (web parity)', () => {
    expect(parseTerminalServerMessage('{"Op":"stdin","Data":"x"}')).toEqual({ kind: 'ignore' });
    expect(parseTerminalServerMessage('raw text')).toEqual({ kind: 'ignore' });
    expect(parseTerminalServerMessage('null')).toEqual({ kind: 'ignore' });
  });
});

/**
 * #3401 — free-text content endpoints must be excluded from full-body tracing.
 * Key-name redaction can't mask a secret TYPED INTO the content (a shell
 * command carrying `export API_KEY=…`, a password at a tmux prompt, an oauth
 * device code), so request() omits these bodies entirely; this predicate is
 * the gate.
 */
describe('isSensitiveBodyPath (#3401)', () => {
  const base = '/rest/v1/vibeflow/projects/7/cloud-runners/12';

  it('matches the three content-carrying endpoints', () => {
    expect(isSensitiveBodyPath(`${base}/exec`)).toBe(true);
    expect(isSensitiveBodyPath(`${base}/tmux/input`)).toBe(true);
    expect(isSensitiveBodyPath(`${base}/oauth/submit`)).toBe(true);
  });

  it('ignores query strings', () => {
    expect(isSensitiveBodyPath(`${base}/exec?timeout=5`)).toBe(true);
  });

  it('does NOT match structured-field endpoints — their secrets are redacted by key name', () => {
    expect(isSensitiveBodyPath(base)).toBe(false);                     // create/get/delete
    expect(isSensitiveBodyPath(`${base}/oauth/start`)).toBe(false);    // returns url+code, no typed input
    expect(isSensitiveBodyPath(`${base}/tmux`)).toBe(false);           // ws attach, not input
    expect(isSensitiveBodyPath(`${base}/manifest`)).toBe(false);       // VAULT placeholders only
    expect(isSensitiveBodyPath('/rest/v1/vibeflow/git-providers')).toBe(false);
  });
});

/** #2825 — Repository/Branch summary for the project-scoped runners table. */
describe('summarizeRepos', () => {
  it('renders dashes when repos are missing or empty', () => {
    expect(summarizeRepos(undefined)).toEqual({ repo: '—', branch: '—' });
    expect(summarizeRepos([])).toEqual({ repo: '—', branch: '—' });
  });

  it('shows the first git repo name and branch', () => {
    expect(summarizeRepos([{ name: 'vscode-vibeflow', isGitRepo: true, branch: 'main' }]))
      .toEqual({ repo: 'vscode-vibeflow', branch: 'main' });
  });

  it('adds a +N suffix when multiple git repos are cloned', () => {
    expect(summarizeRepos([
      { name: 'api', isGitRepo: true, branch: 'main' },
      { name: 'web', isGitRepo: true, branch: 'dev' },
      { name: 'docs', isGitRepo: true },
    ])).toEqual({ repo: 'api +2', branch: 'main' });
  });

  it('skips non-git entries and falls back to the last path segment for the name', () => {
    expect(summarizeRepos([
      { name: 'scratch', isGitRepo: false },
      { path: '/workspace/repos/my-app', isGitRepo: true, branch: 'feature/x' },
    ])).toEqual({ repo: 'my-app', branch: 'feature/x' });
  });

  it('dashes the branch when the repo has none reported', () => {
    expect(summarizeRepos([{ name: 'api', isGitRepo: true }])).toEqual({ repo: 'api', branch: '—' });
  });
});

/**
 * #2827 — pod-safe runner names. The pod's DNS name derives from the runner
 * name, so names must be lowercase-alphanumeric-with-hyphens, letter-first,
 * alphanumeric-last, within RUNNER_NAME_MAX. The message never mentions k8s.
 */
describe('validateRunnerName (#2827)', () => {
  it('accepts well-formed names', () => {
    expect(validateRunnerName('vscode-dev')).toBeNull();
    expect(validateRunnerName('a')).toBeNull();
    expect(validateRunnerName('runner-2')).toBeNull();
    expect(validateRunnerName('  padded  ')).toBeNull(); // trimmed before checking
  });

  it('rejects uppercase, bad edges, and separators other than hyphen', () => {
    expect(validateRunnerName('MyRunner')).toBe(RUNNER_NAME_RULES);
    expect(validateRunnerName('1runner')).toBe(RUNNER_NAME_RULES);   // must start with a letter
    expect(validateRunnerName('-runner')).toBe(RUNNER_NAME_RULES);
    expect(validateRunnerName('runner-')).toBe(RUNNER_NAME_RULES);   // must end alphanumeric
    expect(validateRunnerName('my_runner')).toBe(RUNNER_NAME_RULES);
    expect(validateRunnerName('my runner')).toBe(RUNNER_NAME_RULES);
  });

  it('enforces the length budget and requires a name', () => {
    expect(validateRunnerName('a'.repeat(RUNNER_NAME_MAX))).toBeNull();
    expect(validateRunnerName('a'.repeat(RUNNER_NAME_MAX + 1))).toBe(RUNNER_NAME_RULES);
    expect(validateRunnerName('')).toContain('Name is required');
  });

  it('keeps the user-facing message free of infrastructure jargon', () => {
    expect(RUNNER_NAME_RULES.toLowerCase()).not.toMatch(/k8s|kubernetes|dns|pod|statefulset|deployment/);
  });

  it('is enforced by validateCreateRunner too', () => {
    const body: CreateRunnerRequest = { name: 'Bad_Name', agentType: 'claude', authMode: 'api_key' };
    expect(validateCreateRunner(body)).toBe(RUNNER_NAME_RULES);
  });

  it('suggestRunnerName output always satisfies the rules, even for max-length bases', () => {
    const long = 'a'.repeat(RUNNER_NAME_MAX);
    const suggested = suggestRunnerName(long, 'a3f9');
    expect(suggested.length).toBeLessThanOrEqual(RUNNER_NAME_MAX);
    expect(validateRunnerName(suggested)).toBeNull();
    // A hyphen landing at the clip point is stripped, not doubled.
    expect(validateRunnerName(suggestRunnerName('abc-def-ghi-jkl-mno-pqr-stu-vwx-yz1-234', 'k7z2'))).toBeNull();
  });
});

/**
 * #2832 — doc #437 §2: /status relays the Studio envelope
 * {code, status, result, errors}; the live fields live in `result`.
 */
describe('unwrapStatusEnvelope (#2832)', () => {
  it('unwraps the envelope and reads result', () => {
    const body = {
      code: 200, status: 'ok', errors: [],
      result: { status: 'authenticating', authenticated: false, podStatus: 'Running' },
    };
    expect(unwrapStatusEnvelope(body)).toEqual({ status: 'authenticating', authenticated: false, podStatus: 'Running' });
  });

  it('passes a bare (pre-unwrapped) status body through unchanged', () => {
    const bare = { status: 'running', authenticated: true, configured: true };
    expect(unwrapStatusEnvelope(bare)).toEqual(bare);
  });

  it('yields an empty object for an envelope with a missing or invalid result', () => {
    expect(unwrapStatusEnvelope({ code: 200, status: 'ok', result: null })).toEqual({});
    expect(unwrapStatusEnvelope({ code: 502, status: 'error', result: 'boom' })).toEqual({});
    expect(unwrapStatusEnvelope(null)).toEqual({});
  });

  // #3630 — the same envelope wraps three more relayed endpoints. Shapes below
  // mirror cortex's real structs (RunnerResponse, OAuthStartResponse,
  // RunnerHealthStatus via common.WriteJsonResp).
  it('unwraps the provisioned runner-detail envelope, exposing the agent identity fields', () => {
    const body = {
      code: 200, status: 'OK',
      result: { id: 7, name: 'r1', status: 'running', agentType: 'codex', authMode: 'oauth', loginMethod: 'device_auth' },
    };
    const runner = unwrapStatusEnvelope<{ status: string; agentType: string; authMode: string; loginMethod: string }>(body);
    expect(runner.agentType).toBe('codex');
    expect(runner.authMode).toBe('oauth');
    expect(runner.loginMethod).toBe('device_auth');
    expect(runner.status).toBe('running'); // NOT the envelope's "OK"
  });

  it('passes a bare pending-runner detail (axiomcloud local view, no envelope) through unchanged', () => {
    const bare = { id: 7, name: 'r1', status: 'pending', podName: '', studioRunnerId: 0 };
    expect(unwrapStatusEnvelope(bare)).toEqual(bare);
  });

  it('unwraps the oauth/start envelope so the URL and device code reach the Authenticate step', () => {
    const body = { code: 200, status: 'OK', result: { stage: 'waiting_for_code', url: 'https://auth.example/device', code: 'WXYZ-1234' } };
    const start = unwrapStatusEnvelope<{ url: string; code: string }>(body);
    expect(start.url).toBe('https://auth.example/device');
    expect(start.code).toBe('WXYZ-1234'); // NOT the envelope's numeric 200
  });

  it('unwraps the health envelope so the launch poll can observe phase and errors', () => {
    const body = { code: 200, status: 'OK', result: { phase: 'error', errors: ['session crashed'] } };
    const health = unwrapStatusEnvelope<{ phase: string; errors: string[] }>(body);
    expect(health.phase).toBe('error');
    expect(health.errors).toEqual(['session crashed']);
  });
});
