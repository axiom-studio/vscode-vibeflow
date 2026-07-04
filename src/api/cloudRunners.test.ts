import { describe, it, expect } from 'vitest';
import {
  FEATURE_CLOUD_RUNNERS,
  isFeatureEnabled,
  cloudRunnersEnabled,
  unwrapList,
  validateCreateRunner,
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
