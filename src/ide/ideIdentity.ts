/**
 * Which IDE is this extension actually running in?
 *
 * VS Code, Cursor, Windsurf, VSCodium and Kiro all run the same VS Code
 * extension, so "the vscode extension" is really five products. The only
 * signal available inside the extension host is `vscode.env.appName` (the
 * fork's display name), which is what these helpers map onto the slug the
 * server stores.
 *
 * The mapping is NOT cosmetic. `axiomcloud`'s `NormalizeIDEID`
 * (database/user_ide_usage.go, shipped in its #4210) is an exact,
 * case-sensitive map lookup:
 *
 *     var IDEUsageAllowlist = map[string]bool{
 *         "vscode": true, "cursor": true, "windsurf": true, "vscodium": true, "other": true,
 *     }
 *
 * Anything outside that set becomes "other". So sending the raw appName would
 * file *every* client under "other" — "Cursor" is not the key "cursor", and
 * "Visual Studio Code" is not a key at all — while the endpoint still returns
 * 204. The failure would be completely silent and the operator's per-IDE
 * breakdown would be uniformly useless. Hence: normalize here, exactly.
 */

/** The slugs the server's allowlist accepts, plus `kiro` (see KIRO note). */
export type IdeId = 'vscode' | 'cursor' | 'windsurf' | 'vscodium' | 'kiro' | 'other';

/**
 * Ordered longest-token-first so a fork whose name embeds another product's
 * name can't be mis-attributed. Matching is substring + case-insensitive
 * rather than equality because forks append qualifiers ("… - Insiders") and
 * we cannot enumerate every future variant.
 *
 * `vscode` is matched LAST of the real products: VSCodium's appName contains
 * "VSCodium" but a loose "code" test would also catch it, and Cursor/Windsurf
 * /Kiro must win over any generic fallback.
 */
const IDE_PATTERNS: ReadonlyArray<readonly [IdeId, RegExp]> = [
  ['cursor', /cursor/i],
  ['windsurf', /windsurf/i],
  ['kiro', /\bkiro\b/i],
  ['vscodium', /vscodium|codium/i],
  ['vscode', /visual studio code|vs ?code/i],
];

/**
 * Map a raw `vscode.env.appName` onto a bounded slug.
 *
 * Unrecognized or empty input returns `other`, matching what the server would
 * have done anyway — so an unknown fork is recorded honestly rather than
 * being guessed at.
 *
 * Pure (no `vscode` import) so it is unit-testable without a fake editor API.
 */
export function detectIde(appName: string | undefined): IdeId {
  const name = (appName ?? '').trim();
  if (!name) { return 'other'; }
  for (const [id, pattern] of IDE_PATTERNS) {
    if (pattern.test(name)) { return id; }
  }
  return 'other';
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether enough wall-clock time has passed to report again.
 *
 * Reporting is once per session start and at most once per 24h — this is seat
 * bookkeeping, not analytics, so there is nothing to gain from chattiness.
 *
 * A timestamp in the future means the clock moved backwards (or the stored
 * value was corrupted); we report immediately rather than wedge until real
 * time catches up. Mirrors `shouldCheckNow` in commands/cliUpdateCheck.ts.
 */
export function shouldReportIdeUsage(
  lastReportedAtMs: number | undefined,
  nowMs: number,
  intervalMs: number = DAY_MS,
): boolean {
  if (lastReportedAtMs === undefined || !Number.isFinite(lastReportedAtMs)) { return true; }
  if (lastReportedAtMs > nowMs) { return true; }
  return nowMs - lastReportedAtMs >= intervalMs;
}
