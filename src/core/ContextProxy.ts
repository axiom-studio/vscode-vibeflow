import * as vscode from 'vscode';

/**
 * Single source of truth for every key the extension persists.
 *
 * Why: previously each service (AuthService, ProjectDetector, …)
 * defined its own string constants and called
 * `context.globalState.get(...)` / `context.secrets.store(...)`
 * directly. That worked but had three rough edges:
 *
 *   1. **Key drift** — typos in get vs update silently lose data.
 *      A typed registry stops that at compile time.
 *   2. **No reset path** — clearing every persisted value (e.g. when
 *      the user runs "VibeFlow: Sign Out & Reset") meant tracking
 *      down each service's keys. resetAll() centralizes that.
 *   3. **No migration hook** — if we ever change the shape of a
 *      stored value, there was no obvious place to put a one-time
 *      migration. ContextProxy gives us that hook (see migrate()).
 *
 * This is intentionally thin — it does NOT replace the service
 * classes (AuthService, etc.); it gives them a typed handle to the
 * underlying storage instead of raw context references.
 */

/**
 * GlobalState key registry. Keys live here so that:
 *  - We can grep one file to see everything we persist.
 *  - The compiler enforces that only registered keys are accessed.
 *  - The value type is locked to the key.
 *
 * Add new keys here. Don't reuse old key strings — bump the suffix.
 */
export interface GlobalStateSchema {
  'vibeflow.projectId': number;
  'vibeflow.projectName': string;
  'vibeflow.gitRemoteUrl': string;
  /**
   * Per-launch session mode, keyed by `{persona}::{branch}::{workDir}`.
   * Written when launchSession spawns a terminal, read by SessionReattacher
   * (window reload) and restartSession so a YOLO-launched agent comes back
   * up in YOLO instead of silently downgrading to vanilla. The reattachMode
   * config is the fallback when no entry is recorded for a phantom.
   */
  'vibeflow.launchModes': Record<string, string>;
  /**
   * User-customized Agent Topology node positions, keyed by projectId.
   * Each value is a partial map of `{persona key → {x, y}}`. Persisted on
   * drag-stop in DashboardView and re-applied on next mount so the user's
   * preferred layout survives reloads. Cleared via the "Reset layout"
   * button in the section header — falls back to PERSONA_POSITIONS.
   */
  'vibeflow.dashboard.nodePositions': Record<string, Record<string, { x: number; y: number }>>;
  /**
   * Epoch-ms of the last background CLI update check. Gates the periodic
   * check on wall-clock time so it survives reloads and laptop sleep
   * (the polling coordinator only accumulates elapsed time while the
   * window is focused). See commands/cliUpdateCheck.ts.
   */
  'vibeflow.cli.updateCheckedAt': number;
  /**
   * The last CLI release tag the user was shown an upgrade prompt for.
   * Suppresses a repeat prompt for the same version on every subsequent
   * tick; a newer tag still gets through.
   */
  'vibeflow.cli.updateNotifiedVersion': string;
}

/**
 * Secrets key registry. Same pattern as globalState but for
 * vscode.SecretStorage (encrypted, per-machine).
 */
export interface SecretsSchema {
  'vibeflow.authToken': string;
}

export type GlobalStateKey = keyof GlobalStateSchema;
export type SecretKey = keyof SecretsSchema;

/**
 * Typed proxy over `vscode.ExtensionContext.globalState` and
 * `.secrets`. Construct once at activation, hand to services that
 * need persistence.
 */
export class ContextProxy {
  constructor(private readonly context: vscode.ExtensionContext) {}

  // --- Global state (per-machine, unencrypted) ---

  /** Read a value. Returns undefined when nothing has been written. */
  get<K extends GlobalStateKey>(key: K): GlobalStateSchema[K] | undefined {
    return this.context.globalState.get<GlobalStateSchema[K]>(key);
  }

  /** Write a value. Pass `undefined` to delete. */
  async set<K extends GlobalStateKey>(
    key: K,
    value: GlobalStateSchema[K] | undefined,
  ): Promise<void> {
    await this.context.globalState.update(key, value);
  }

  // --- Secrets (per-machine, encrypted) ---

  async getSecret<K extends SecretKey>(key: K): Promise<SecretsSchema[K] | undefined> {
    return (await this.context.secrets.get(key)) as SecretsSchema[K] | undefined;
  }

  async setSecret<K extends SecretKey>(key: K, value: SecretsSchema[K]): Promise<void> {
    await this.context.secrets.store(key, value);
  }

  async deleteSecret<K extends SecretKey>(key: K): Promise<void> {
    await this.context.secrets.delete(key);
  }

  // --- Provider env-tokens (dynamic name; not in SecretsSchema) ---
  //
  // Provider tokens (`MCP_TOKEN`, `GEMINI_API_KEY`, ...) are stored under
  // their literal env-var name so the launch-wizard pre-fill in
  // sessionCommands.ts can read them with the same string the spawned
  // terminal will inject. Kept off SecretsSchema because the set is
  // open-ended and the keys ARE the env vars — a static registry would
  // duplicate that contract.
  async getProviderEnvToken(envName: string): Promise<string | undefined> {
    return this.context.secrets.get(envName);
  }

  /**
   * Wipe every value the extension has persisted — both globalState
   * and secrets. Used by the "Sign Out & Reset" command and the
   * onboarding "start fresh" path.
   *
   * Listed keys must include every entry in GlobalStateSchema and
   * SecretsSchema. The compiler enforces exhaustiveness via the
   * `satisfies` check on the arrays below.
   */
  async resetAll(): Promise<void> {
    const globalKeys: GlobalStateKey[] = [
      'vibeflow.projectId',
      'vibeflow.projectName',
      'vibeflow.gitRemoteUrl',
      'vibeflow.launchModes',
      'vibeflow.dashboard.nodePositions',
      'vibeflow.cli.updateCheckedAt',
      'vibeflow.cli.updateNotifiedVersion',
    ] satisfies GlobalStateKey[];
    for (const key of globalKeys) {
      await this.context.globalState.update(key, undefined);
    }

    const secretKeys: SecretKey[] = [
      'vibeflow.authToken',
    ] satisfies SecretKey[];
    for (const key of secretKeys) {
      await this.context.secrets.delete(key);
    }
  }

  /**
   * Hook for future schema migrations. Right now no-op. Pattern:
   *
   *   const v = this.get('vibeflow.someKey');
   *   if (v && needsMigration(v)) {
   *     await this.set('vibeflow.someKey', migrate(v));
   *   }
   *
   * Call from extension.ts activate() before any service constructs.
   */
  async migrate(): Promise<void> {
    // No-op until we need it.
  }
}
