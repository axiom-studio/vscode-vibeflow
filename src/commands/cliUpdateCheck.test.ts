import { describe, it, expect } from 'vitest';
import {
  compareVersions,
  isNewerVersion,
  resolveUpdateCheckIntervalMs,
  shouldCheckNow,
  shouldNotify,
} from './cliUpdateCheck.js';

const HOUR_MS = 60 * 60 * 1000;

describe('compareVersions', () => {
  it('orders by numeric segment, not lexically', () => {
    // The bug a string compare would ship: '1.0.9' > '1.0.10' lexically.
    expect(compareVersions('1.0.10', '1.0.9')).toBe(1);
    expect(compareVersions('1.0.9', '1.0.10')).toBe(-1);
  });

  it('treats identical versions as equal', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('ignores a v prefix on either side', () => {
    // GitHub tags carry it; `vibeflow version` output does not.
    expect(compareVersions('v1.2.4', '1.2.3')).toBe(1);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
  });

  it('compares missing trailing segments as zero', () => {
    expect(compareVersions('1.3', '1.3.0')).toBe(0);
    expect(compareVersions('1.3.1', '1.3')).toBe(1);
  });

  it('ranks a release above a pre-release of the same core', () => {
    expect(compareVersions('1.4.0', '1.4.0-rc.1')).toBe(1);
    expect(compareVersions('1.4.0-rc.1', '1.4.0')).toBe(-1);
  });

  it('does not rank two pre-releases of the same core against each other', () => {
    // Guessing wrong here would nag the user on every tick.
    expect(compareVersions('1.4.0-rc.2', '1.4.0-rc.1')).toBe(0);
  });

  it('ignores build metadata', () => {
    expect(compareVersions('1.2.3+build.5', '1.2.3')).toBe(0);
  });

  it('reports equal for unparseable input so callers stay quiet', () => {
    // `vibeflow version` reports a bare 'dev' for locally-built binaries.
    expect(compareVersions('v1.0.11', 'dev')).toBe(0);
    expect(compareVersions('dev', 'v1.0.11')).toBe(0);
    expect(compareVersions('', '1.0.0')).toBe(0);
    expect(compareVersions('not.a.version', '1.0.0')).toBe(0);
  });
});

describe('isNewerVersion', () => {
  it('is true only when strictly ahead', () => {
    expect(isNewerVersion('1.0.11', '1.0.10')).toBe(true);
    expect(isNewerVersion('1.0.10', '1.0.10')).toBe(false);
    expect(isNewerVersion('1.0.9', '1.0.10')).toBe(false);
  });

  it('never fires for a dev build running ahead of the published tag', () => {
    // The regression this whole comparator exists to prevent: the old
    // `latest !== installed` check would nag this user on every tick.
    expect(isNewerVersion('v1.0.11', 'dev')).toBe(false);
  });
});

describe('resolveUpdateCheckIntervalMs', () => {
  it('defaults to 12 hours when unset', () => {
    expect(resolveUpdateCheckIntervalMs(undefined)).toBe(12 * HOUR_MS);
  });

  it('honours an explicit cadence', () => {
    expect(resolveUpdateCheckIntervalMs(1)).toBe(HOUR_MS);
    expect(resolveUpdateCheckIntervalMs(24)).toBe(24 * HOUR_MS);
  });

  it('treats zero and negatives as disabled', () => {
    expect(resolveUpdateCheckIntervalMs(0)).toBeUndefined();
    expect(resolveUpdateCheckIntervalMs(-5)).toBeUndefined();
  });

  it('clamps sub-hourly values up to the unauthenticated-API floor', () => {
    expect(resolveUpdateCheckIntervalMs(0.25)).toBe(HOUR_MS);
  });

  it('falls back to the default for non-finite input', () => {
    expect(resolveUpdateCheckIntervalMs(Number.NaN)).toBe(12 * HOUR_MS);
    expect(resolveUpdateCheckIntervalMs(Number.POSITIVE_INFINITY)).toBe(12 * HOUR_MS);
  });
});

describe('shouldCheckNow', () => {
  const now = 1_000_000_000_000;

  it('checks on first run when nothing has been recorded', () => {
    expect(shouldCheckNow(undefined, now, 12 * HOUR_MS)).toBe(true);
  });

  it('waits until the full interval has elapsed', () => {
    expect(shouldCheckNow(now - 11 * HOUR_MS, now, 12 * HOUR_MS)).toBe(false);
    expect(shouldCheckNow(now - 12 * HOUR_MS, now, 12 * HOUR_MS)).toBe(true);
    expect(shouldCheckNow(now - 30 * HOUR_MS, now, 12 * HOUR_MS)).toBe(true);
  });

  it('does not wedge when the system clock moves backwards', () => {
    // A future timestamp would otherwise suppress checks until real time
    // caught up — potentially forever.
    expect(shouldCheckNow(now + 48 * HOUR_MS, now, 12 * HOUR_MS)).toBe(true);
  });

  it('checks when the stored timestamp is corrupt', () => {
    expect(shouldCheckNow(Number.NaN, now, 12 * HOUR_MS)).toBe(true);
  });
});

describe('shouldNotify', () => {
  it('notifies about a newer release not seen before', () => {
    expect(shouldNotify('v1.0.11', '1.0.10', undefined)).toBe(true);
  });

  it('stays silent when already up to date', () => {
    expect(shouldNotify('v1.0.10', '1.0.10', undefined)).toBe(false);
  });

  it('stays silent for a version the user already dismissed', () => {
    expect(shouldNotify('v1.0.11', '1.0.10', 'v1.0.11')).toBe(false);
  });

  it('notifies again once a version newer than the dismissed one ships', () => {
    expect(shouldNotify('v1.0.12', '1.0.10', 'v1.0.11')).toBe(true);
  });

  it('stays silent when the installed version cannot be compared', () => {
    expect(shouldNotify('v1.0.11', 'dev', undefined)).toBe(false);
  });
});
