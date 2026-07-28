import * as vscode from 'vscode';
import { getCliVersion } from './cliCommands.js';
import { fetchLatestCliTag } from './cliInstaller.js';
import type { ContextProxy } from '../core/ContextProxy.js';
import type { Disposer, PollingCoordinator } from '../core/PollingCoordinator.js';

/**
 * Periodic "a newer VibeFlow CLI is out" check.
 *
 * The pieces already existed — `getCliVersion()` reads the installed
 * binary, `fetchLatestCliTag()` reads the published release, and the
 * `vibeflow.checkCliUpdate` command wired them together. What was missing
 * is a trigger: the user had to run the command by hand. This module adds
 * the schedule and the notification hygiene around it.
 *
 * Scheduling note: we do NOT own a timer. `PollingCoordinator` owns the
 * one timer every poller shares, so we subscribe to it — but at a short
 * granularity, with the real cadence enforced by a persisted wall-clock
 * timestamp. That indirection is load-bearing, because the
 * coordinator pauses while the window is unfocused and re-fires every
 * subscriber on refocus: a subscriber registered directly at 12h would
 * run on every alt-tab and never actually mature. Gating on wall-clock
 * makes refocus fires cheap no-ops, and turns the refocus behavior into a
 * feature — a laptop waking from sleep runs its overdue check on the next
 * focus instead of waiting out 12h of accumulated foreground time.
 */

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_INTERVAL_HOURS = 12;

/**
 * Floor on the configured cadence. The GitHub release endpoint is called
 * unauthenticated (60 requests/hour/IP, shared with the installer), so we
 * refuse to poll it faster than hourly no matter what the setting says.
 * Hourly is the fastest cadence the request asked for anyway.
 */
const MIN_INTERVAL_HOURS = 1;

/**
 * How often the subscription wakes to consult the wall-clock gate. This is
 * NOT the check cadence — it's just the resolution at which an overdue
 * check gets noticed. Each wake that isn't due costs two integer reads.
 */
const GATE_POLL_MS = 5 * 60 * 1000;

interface ParsedVersion {
  core: number[];
  prerelease: string | undefined;
}

/**
 * Parse a release tag into comparable parts. Tolerates the `v` prefix that
 * GitHub tags carry but `vibeflow version` output doesn't, plus semver
 * pre-release and build suffixes.
 *
 * Returns undefined for anything without a numeric core — notably the
 * literal `dev` that a locally-built CLI reports. Callers treat that as
 * "not comparable", which is what keeps dev builds from being nagged.
 */
function parseVersion(raw: string): ParsedVersion | undefined {
  const withoutBuild = raw.trim().replace(/^v/i, '').split('+')[0] ?? '';
  const [core, ...prereleaseParts] = withoutBuild.split('-');
  const segments = (core ?? '').split('.');
  if (!segments.every(s => /^\d+$/.test(s))) {
    return undefined;
  }
  return {
    core: segments.map(Number),
    prerelease: prereleaseParts.length > 0 ? prereleaseParts.join('-') : undefined,
  };
}

/**
 * Order two version strings: 1 when `a` is newer, -1 when older, 0 when
 * equal or not comparable.
 *
 * Unparseable input compares equal on purpose. Every caller acts only on a
 * strictly-positive result, so "can't tell" degrades to staying quiet
 * rather than to a false upgrade prompt.
 *
 * Two different pre-releases of the same core also compare equal — we
 * don't rank `beta.1` against `beta.2`, because guessing wrong there means
 * nagging someone on every tick. A release always outranks a pre-release
 * of the same core, which is the case that matters.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) { return 0; }

  const len = Math.max(pa.core.length, pb.core.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (diff !== 0) { return diff > 0 ? 1 : -1; }
  }

  if (pa.prerelease && !pb.prerelease) { return -1; }
  if (!pa.prerelease && pb.prerelease) { return 1; }
  return 0;
}

/** True only when `latest` is strictly ahead of `installed`. */
export function isNewerVersion(latest: string, installed: string): boolean {
  return compareVersions(latest, installed) > 0;
}

/**
 * Resolve the configured cadence to milliseconds, or undefined when the
 * check is disabled. `0` (or negative) disables; anything below the floor
 * is raised to it; a missing or non-finite value falls back to the default.
 */
export function resolveUpdateCheckIntervalMs(hours: number | undefined): number | undefined {
  if (hours === undefined || !Number.isFinite(hours)) {
    return DEFAULT_INTERVAL_HOURS * HOUR_MS;
  }
  if (hours <= 0) { return undefined; }
  return Math.max(MIN_INTERVAL_HOURS, hours) * HOUR_MS;
}

/**
 * Whether enough wall-clock time has passed to run the real check.
 *
 * A timestamp in the future means the system clock moved backwards (or the
 * value was corrupted); we check immediately rather than wedge until real
 * time catches up.
 */
export function shouldCheckNow(
  lastCheckedAtMs: number | undefined,
  nowMs: number,
  intervalMs: number,
): boolean {
  if (lastCheckedAtMs === undefined || !Number.isFinite(lastCheckedAtMs)) { return true; }
  if (lastCheckedAtMs > nowMs) { return true; }
  return nowMs - lastCheckedAtMs >= intervalMs;
}

/**
 * Whether an unsolicited toast is warranted: the release must be strictly
 * newer than what's installed AND newer than whatever we last told this
 * user about. Comparing (rather than equality-checking) the last-notified
 * version means dismissing v2 stays dismissed, but v3 still gets through.
 */
export function shouldNotify(
  latest: string,
  installed: string,
  lastNotifiedVersion: string | undefined,
): boolean {
  if (!isNewerVersion(latest, installed)) { return false; }
  if (lastNotifiedVersion === undefined) { return true; }
  return compareVersions(latest, lastNotifiedVersion) > 0;
}

async function offerInstall(installed: string, latest: string): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    `VibeFlow CLI update available: v${installed} → ${latest}.`,
    'Install Latest',
  );
  if (choice === 'Install Latest') {
    await vscode.commands.executeCommand('vibeflow.installCli');
  }
}

/**
 * The two ways the check runs. The background mode carries the store it
 * needs to remember what it already prompted about; the manual mode has no
 * such state, so the type keeps it out rather than leaving an optional
 * field that only one path may pass.
 */
export type CliUpdateCheckOptions =
  | { silent: false }
  | { silent: true; store: ContextProxy };

/**
 * Run the check and surface the result.
 *
 * `silent: false` is the manual command — the user explicitly asked, so
 * every outcome gets feedback, including "up to date" and the failure
 * modes, and any version difference is worth reporting.
 *
 * `silent: true` is the background tick — an unsolicited interruption, so
 * only a strictly newer release earns a toast. Not installed, offline,
 * rate-limited, up to date, or already-dismissed all pass silently.
 */
export async function runCliUpdateCheck(opts: CliUpdateCheckOptions): Promise<void> {
  const installed = getCliVersion();
  if (!installed) {
    if (!opts.silent) {
      vscode.window.showWarningMessage('VibeFlow CLI not found — install it first (Settings → Connection).');
    }
    return;
  }

  const latest = await fetchLatestCliTag();
  if (!latest) {
    if (!opts.silent) {
      vscode.window.showWarningMessage(`VibeFlow CLI v${installed} — could not reach GitHub to check for updates.`);
    }
    return;
  }

  if (!opts.silent) {
    const norm = (v: string) => v.replace(/^v/, '');
    if (norm(latest) === norm(installed)) {
      vscode.window.showInformationMessage(`VibeFlow CLI is up to date (v${installed}).`);
      return;
    }
    await offerInstall(installed, latest);
    return;
  }

  const { store } = opts;
  if (!shouldNotify(latest, installed, store.get('vibeflow.cli.updateNotifiedVersion'))) {
    return;
  }
  // Record before prompting: whether the user installs or dismisses, this
  // version has now been surfaced and must not reappear on the next tick.
  await store.set('vibeflow.cli.updateNotifiedVersion', latest);
  await offerInstall(installed, latest);
}

/**
 * Subscribe the background check to the shared polling timer. The returned
 * subscription is registered on `context.subscriptions`, so it is disposed
 * on deactivate and cannot outlive a reload.
 *
 * The interval setting is read on each wake rather than captured, so
 * changing it (including setting it to 0) takes effect without a reload.
 */
export function registerCliUpdateCheck(
  context: vscode.ExtensionContext,
  coordinator: PollingCoordinator,
  store: ContextProxy,
): void {
  const sub: Disposer = coordinator.subscribe(
    GATE_POLL_MS,
    () => {
      // The coordinator's try/catch only guards synchronous throws, so the
      // promise needs its own. A background check has nowhere to report an
      // error to — staying silent IS the correct behavior here.
      void maybeRunScheduledCheck(store).catch(() => { /* never surfaced */ });
    },
    'cliUpdateCheck',
  );
  context.subscriptions.push(sub);
}

async function maybeRunScheduledCheck(store: ContextProxy): Promise<void> {
  const configured = vscode.workspace
    .getConfiguration('vibeflow')
    .get<number>('cli.updateCheckIntervalHours');
  const intervalMs = resolveUpdateCheckIntervalMs(configured);
  if (intervalMs === undefined) { return; }

  const now = Date.now();
  if (!shouldCheckNow(store.get('vibeflow.cli.updateCheckedAt'), now, intervalMs)) { return; }

  // Stamp before running, not after: a network call that hangs or throws
  // must not leave the gate open for a retry on every subsequent wake.
  await store.set('vibeflow.cli.updateCheckedAt', now);
  await runCliUpdateCheck({ silent: true, store });
}
