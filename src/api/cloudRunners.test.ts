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
  deriveTmuxWsUrl,
  encodeTmuxInput,
  encodeTmuxResize,
  parseTmuxServerFrame,
  suggestRunnerName,
  summarizeResponseShape,
  redactSecretsDeep,
  isSensitiveBodyPath,
  unwrapStatusEnvelope,
  summarizeRepos,
  validateRunnerName,
  RUNNER_NAME_RULES,
  RUNNER_NAME_MAX,
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
});

describe('deriveTmuxWsUrl', () => {
  it('upgrades https→wss and builds the tmux path', () => {
    expect(deriveTmuxWsUrl('https://cloud.axiomstudio.ai', 28, 5))
      .toBe('wss://cloud.axiomstudio.ai/rest/v1/vibeflow/projects/28/cloud-runners/5/tmux/ws');
  });
  it('upgrades http→ws for localhost and strips query/hash', () => {
    expect(deriveTmuxWsUrl('http://localhost:8080/?x=1#f', 1, 2))
      .toBe('ws://localhost:8080/rest/v1/vibeflow/projects/1/cloud-runners/2/tmux/ws');
  });
  it('rejects empty or non-http(s) base URLs (no bearer over insecure transport)', () => {
    expect(() => deriveTmuxWsUrl('', 1, 1)).toThrow();
    expect(() => deriveTmuxWsUrl('ftp://x', 1, 1)).toThrow();
  });
});

describe('tmux frame codec', () => {
  it('encodes input and resize frames', () => {
    expect(JSON.parse(encodeTmuxInput('ls\n'))).toEqual({ type: 'input', data: 'ls\n' });
    expect(JSON.parse(encodeTmuxResize(120, 40))).toEqual({ type: 'resize', cols: 120, rows: 40 });
  });
  it('parses an error control frame', () => {
    expect(parseTmuxServerFrame('{"type":"error","message":"pod gone"}')).toEqual({ kind: 'error', message: 'pod gone' });
  });
  it('treats raw text and non-error JSON as output', () => {
    expect(parseTmuxServerFrame('hello$ ')).toEqual({ kind: 'output', data: 'hello$ ' });
    expect(parseTmuxServerFrame('{"type":"data","x":1}')).toEqual({ kind: 'output', data: '{"type":"data","x":1}' });
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
});
