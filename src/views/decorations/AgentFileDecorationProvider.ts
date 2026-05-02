import * as vscode from 'vscode';
import { personaDisplayName } from '../../sessions/personas.js';

/**
 * What the persona is doing to the file. Drives the human-readable verb in
 * the hover tooltip. `edit` is the default when the verb is unknown.
 */
export type FileAction = 'edit' | 'read' | 'write' | 'delete';

interface FileActivity {
  persona: string;
  type: 'active' | 'committed' | 'commented';
  /** Wall-clock millis of the most recent `markActive` call. */
  lastActiveAt: number;
  /** Last action the persona performed on this file (active state only). */
  action?: FileAction;
}

/** Active markers fade after this much idle time. */
const ACTIVE_TTL_MS = 30_000;
/** How often the sweep timer runs to demote/clear expired markers. */
const SWEEP_INTERVAL_MS = 10_000;

/**
 * Shows colored badges on files in the Explorer indicating which
 * agent persona is currently modifying them.
 *
 * Lifecycle:
 *  - markActive(file, persona)       → green/blue/etc. letter, refreshed timestamp.
 *  - markCommitted(file, persona)    → subtle dim dot for files an agent committed.
 *  - markCommented(file)             → magenta dot for files with unresolved comments.
 *
 * Active markers age out: a sweep runs every 10s and clears any active
 * marker whose `lastActiveAt` is older than 30s. If a commit was recorded
 * for that file we demote to "committed" instead of clearing — same shape
 * VS Code's git extension uses (M → committed indicator after stage).
 */
export class AgentFileDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  private activities = new Map<string, FileActivity>();
  /**
   * Files we've seen in commit log entries — used as fallback state when an
   * `active` marker ages out. Keyed by absolute fsPath, value is the persona
   * that produced the commit.
   */
  private committedBy = new Map<string, string>();

  private sweepTimer: ReturnType<typeof setInterval>;

  /**
   * Role-tier shape + per-persona color. Shape conveys the *function* at a
   * glance (engineering vs review vs product), color identifies the specific
   * persona once you've learned the legend, and the tooltip names them
   * outright. Always 1 char wide so we don't crowd Git's M/U markers in the
   * Explorer.
   */
  private static PERSONA_BADGES: Record<string, { shape: string; color: string }> = {
    developer:          { shape: '●', color: 'charts.green' },
    architect:          { shape: '●', color: 'charts.blue' },
    principal_engineer: { shape: '●', color: 'charts.yellow' },
    security_lead:      { shape: '▲', color: 'charts.red' },
    qa_lead:            { shape: '▲', color: 'terminal.ansiCyan' },
    product_manager:    { shape: '■', color: 'charts.orange' },
    project_manager:    { shape: '■', color: 'charts.purple' },
    ux_designer:        { shape: '■', color: 'terminal.ansiMagenta' },
    customer:           { shape: '○', color: 'disabledForeground' },
  };

  private static ACTION_VERBS: Record<FileAction, string> = {
    edit: 'editing',
    read: 'reading',
    write: 'writing to',
    delete: 'deleting',
  };

  constructor() {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const activity = this.activities.get(uri.fsPath);
    if (!activity) { return undefined; }

    const badge = AgentFileDecorationProvider.PERSONA_BADGES[activity.persona];
    if (!badge && activity.type !== 'commented') { return undefined; }

    const name = activity.persona ? personaDisplayName(activity.persona) : '';

    if (activity.type === 'active' && badge) {
      const verb = AgentFileDecorationProvider.ACTION_VERBS[activity.action ?? 'edit'];
      return new vscode.FileDecoration(
        badge.shape,
        `${name} is ${verb} this file`,
        new vscode.ThemeColor(badge.color),
      );
    }

    if (activity.type === 'committed' && badge) {
      return new vscode.FileDecoration(
        '•',
        `${name} committed changes to this file`,
        new vscode.ThemeColor('disabledForeground'),
      );
    }

    if (activity.type === 'commented') {
      return new vscode.FileDecoration(
        '•',
        'Has unresolved comments',
        new vscode.ThemeColor('terminal.ansiMagenta'),
      );
    }

    return undefined;
  }

  /**
   * Mark a file as being actively modified by a persona. Idempotent —
   * subsequent calls just refresh `lastActiveAt` (and update the action verb
   * if it changed, e.g. read → edit).
   */
  markActive(filePath: string, persona: string, action: FileAction = 'edit'): void {
    const existing = this.activities.get(filePath);
    const now = Date.now();
    if (existing && existing.type === 'active' && existing.persona === persona && existing.action === action) {
      existing.lastActiveAt = now;
      // No fire — VS Code already shows the same decoration.
      return;
    }
    this.activities.set(filePath, { persona, type: 'active', lastActiveAt: now, action });
    this._onDidChangeFileDecorations.fire(vscode.Uri.file(filePath));
  }

  /**
   * Bulk-mark many files at once. Single fire() event keeps re-render cost
   * proportional to the number of *changed* rows, not number of marks.
   */
  markActiveBatch(entries: Array<{ filePath: string; persona: string; action?: FileAction }>): void {
    const changed: vscode.Uri[] = [];
    const now = Date.now();
    for (const { filePath, persona, action = 'edit' } of entries) {
      const existing = this.activities.get(filePath);
      if (existing && existing.type === 'active' && existing.persona === persona && existing.action === action) {
        existing.lastActiveAt = now;
        continue;
      }
      this.activities.set(filePath, { persona, type: 'active', lastActiveAt: now, action });
      changed.push(vscode.Uri.file(filePath));
    }
    if (changed.length > 0) {
      this._onDidChangeFileDecorations.fire(changed);
    }
  }

  /**
   * Mark a file as committed by a persona (subtler decoration). Also
   * remembered so an aging-out `active` marker for the same file demotes
   * to `committed` rather than clearing.
   */
  markCommitted(filePath: string, persona: string): void {
    this.committedBy.set(filePath, persona);
    const existing = this.activities.get(filePath);
    // Don't downgrade an active state — let the sweep promote later.
    if (existing && existing.type === 'active') { return; }
    this.activities.set(filePath, {
      persona,
      type: 'committed',
      lastActiveAt: Date.now(),
    });
    this._onDidChangeFileDecorations.fire(vscode.Uri.file(filePath));
  }

  /**
   * Mark a file as having unresolved comments.
   */
  markCommented(filePath: string): void {
    this.activities.set(filePath, { persona: '', type: 'commented', lastActiveAt: Date.now() });
    this._onDidChangeFileDecorations.fire(vscode.Uri.file(filePath));
  }

  /** Clear decoration for a specific file. */
  clear(filePath: string): void {
    if (this.activities.delete(filePath)) {
      this._onDidChangeFileDecorations.fire(vscode.Uri.file(filePath));
    }
  }

  /** Clear all decorations. */
  clearAll(): void {
    this.activities.clear();
    this.committedBy.clear();
    this._onDidChangeFileDecorations.fire(undefined);
  }

  /**
   * Demote `active` markers older than the TTL. If a commit was recorded
   * for that file, switch to `committed`; otherwise clear entirely.
   */
  private sweep(): void {
    const now = Date.now();
    const changed: vscode.Uri[] = [];
    for (const [filePath, activity] of this.activities) {
      if (activity.type !== 'active') { continue; }
      if (now - activity.lastActiveAt < ACTIVE_TTL_MS) { continue; }

      const commitPersona = this.committedBy.get(filePath);
      if (commitPersona) {
        this.activities.set(filePath, {
          persona: commitPersona,
          type: 'committed',
          lastActiveAt: now,
        });
      } else {
        this.activities.delete(filePath);
      }
      changed.push(vscode.Uri.file(filePath));
    }
    if (changed.length > 0) {
      this._onDidChangeFileDecorations.fire(changed);
    }
  }

  dispose(): void {
    clearInterval(this.sweepTimer);
    this._onDidChangeFileDecorations.dispose();
  }
}
