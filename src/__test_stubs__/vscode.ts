/**
 * Vitest-only stub for the `vscode` module.
 *
 * Wired in via `vitest.config.ts`'s `resolve.alias`. Lets vitest
 * import source files that have a top-level `import * as vscode
 * from 'vscode'` (every src/ file outside of pure utilities does)
 * without crashing the test runner on the missing built-in module.
 *
 * Per project test policy: stubs are allowed ONLY for external
 * boundaries (here the VSCode runtime API, which doesn't exist in
 * Node). We do NOT use this stub to fake behaviors the unit under
 * test depends on — tests that need a specific vscode behavior
 * belong in integration tests (separate phase, separate config).
 *
 * Each export below is the minimum surface area required by the
 * source files our test cohort imports. Extend ONLY as a new unit
 * test surfaces a fresh missing-export error.
 */

// Configuration / workspace surface — sessionCommands.ts touches
// `workspace.getConfiguration` from a top-level helper (LLM gateway
// gate). Tests don't exercise that code path; the stub just lets
// the module load.
export const workspace = {
  getConfiguration(_section?: string) {
    return {
      get<T>(_key: string, defaultValue?: T): T | undefined { return defaultValue; },
    };
  },
};

// Window surface — used inside the wizard for UI prompts. Tests
// never reach this code; presence prevents import errors only.
export const window = {
  showInformationMessage(..._args: unknown[]) { /* no-op */ },
  showWarningMessage(..._args: unknown[]) { /* no-op */ },
  showErrorMessage(..._args: unknown[]) { /* no-op */ },
  showQuickPick<T>(..._args: unknown[]): Promise<T | undefined> { return Promise.resolve(undefined); },
  showInputBox(..._args: unknown[]): Promise<string | undefined> { return Promise.resolve(undefined); },
  createTerminal(..._args: unknown[]): unknown { return {}; },
};

// Uri — referenced as a type; an empty object satisfies the loader.
export const Uri = {
  parse(s: string): { toString(): string } { return { toString() { return s; } }; },
  file(p: string): { toString(): string } { return { toString() { return p; } }; },
};

// ThemeIcon / ThemeColor — instantiated as new ThemeIcon(...).
export class ThemeIcon { constructor(public id: string, public color?: unknown) {} }
export class ThemeColor { constructor(public id: string) {} }

// TerminalLocation enum — sessionCommands references the Editor value.
export const TerminalLocation = { Editor: 1, Panel: 2 } as const;

// ConfigurationTarget enum — settingsPersistence routes updates by target;
// values mirror the real API (Global=1, Workspace=2, WorkspaceFolder=3).
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;

// TreeItem / TreeItemCollapsibleState — view providers reference them.
export class TreeItem { constructor(public label: string, public collapsibleState?: unknown) {} }
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;

// EventEmitter — view providers fire from it. Simple in-memory stub.
export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  readonly event = (cb: (e: T) => void): { dispose(): void } => {
    this.listeners.push(cb);
    return { dispose: () => { this.listeners = this.listeners.filter(l => l !== cb); } };
  };
  fire(e: T): void { for (const l of this.listeners) { l(e); } }
  dispose(): void { this.listeners = []; }
}

// commands.executeCommand — invoked from a few helpers. No-op return.
export const commands = {
  executeCommand<T = unknown>(..._args: unknown[]): Promise<T | undefined> { return Promise.resolve(undefined); },
};

// env — Uri.parse is the only thing used.
export const env = {
  openExternal(_uri: unknown): Promise<boolean> { return Promise.resolve(true); },
  clipboard: { writeText(_t: string): Promise<void> { return Promise.resolve(); } },
};

// extensions.getExtension — used to read packageJSON version. Returns
// undefined so callers fall back to their default branch.
export const extensions = {
  getExtension(_id: string): undefined { return undefined; },
};
