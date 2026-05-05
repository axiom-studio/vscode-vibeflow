import * as vscode from 'vscode';
import { isCodeAgent, personaDisplayName } from './personas.js';

export type TerminalMode = 'hybrid' | 'all' | 'none';

interface RegisteredTerminal {
  terminal: vscode.Terminal;
  persona: string;
  branch: string;
  provider: string;
  hidden: boolean;
}

/**
 * Tracks VibeFlow agent terminals by a composite key (persona + branch).
 * Provides focus/show/kill operations and integrates with the terminal
 * dispose event to keep state consistent.
 */
export class TerminalRegistry implements vscode.Disposable {
  private terminals = new Map<string, RegisteredTerminal>();
  private disposeListener: vscode.Disposable;
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor() {
    // Listen for terminal closures to clean up
    this.disposeListener = vscode.window.onDidCloseTerminal(terminal => {
      for (const [key, entry] of this.terminals) {
        if (entry.terminal === terminal) {
          this.terminals.delete(key);
          this._onDidChange.fire();
          break;
        }
      }
    });
  }

  private key(persona: string, branch: string): string {
    return `${persona}::${branch}`;
  }

  /**
   * Create and register a terminal for the given persona + branch.
   * Visibility determined by terminal mode + persona classification.
   */
  create(opts: {
    persona: string;
    branch: string;
    provider: string;
    workDir: string;
    command: string;
    env: Record<string, string>;
    terminalMode: TerminalMode;
    initPrompt?: string;
  }): vscode.Terminal {
    const k = this.key(opts.persona, opts.branch);

    // Kill existing terminal for same persona+branch if any
    const existing = this.terminals.get(k);
    if (existing) {
      existing.terminal.dispose();
      this.terminals.delete(k);
    }

    // Determine visibility
    let hidden = false;
    if (opts.terminalMode === 'none') {
      hidden = true;
    } else if (opts.terminalMode === 'hybrid') {
      hidden = !isCodeAgent(opts.persona);
    }
    // 'all' → visible (hidden = false)

    const displayName = personaDisplayName(opts.persona);
    const terminalName = `VibeFlow: ${displayName} [${opts.branch}]`;

    const terminal = vscode.window.createTerminal({
      name: terminalName,
      cwd: opts.workDir,
      env: opts.env,
      hideFromUser: hidden,
      iconPath: new vscode.ThemeIcon('hubot'),
    });

    this.terminals.set(k, {
      terminal,
      persona: opts.persona,
      branch: opts.branch,
      provider: opts.provider,
      hidden,
    });

    // Show and run command.
    // If initPrompt is provided, append it as a positional argument to the
    // binary command. Claude accepts `claude [options] [prompt]` — the prompt
    // becomes the first user message, no TUI input timing issues.
    if (!hidden) {
      terminal.show(true); // preserveFocus = true
    }

    if (opts.initPrompt) {
      // Use single quotes to avoid escaping issues with double quotes in the prompt
      const escaped = opts.initPrompt.replace(/'/g, "'\\''");
      const fullCommand = `${opts.command} '${escaped}'`;
      console.log('[VibeFlow] Terminal command:', fullCommand.slice(0, 200));
      terminal.sendText(fullCommand, true);
    } else {
      console.log('[VibeFlow] Terminal command (no prompt):', opts.command);
      terminal.sendText(opts.command, true);
    }

    this._onDidChange.fire();
    return terminal;
  }

  /**
   * Focus the terminal for a given persona + branch.
   * If hidden, makes it visible first.
   */
  focus(persona: string, branch: string): boolean {
    const entry = this.terminals.get(this.key(persona, branch));
    if (!entry) { return false; }
    entry.terminal.show(false); // false = take focus
    return true;
  }

  /**
   * Check if a terminal exists for a given persona + branch.
   */
  has(persona: string, branch: string): boolean {
    return this.terminals.has(this.key(persona, branch));
  }

  /**
   * Kill (dispose) the terminal for a given persona + branch.
   * Also deletes the terminal from the registry.
   */
  kill(persona: string, branch: string): boolean {
    const k = this.key(persona, branch);
    const entry = this.terminals.get(k);
    if (!entry) { return false; }
    entry.terminal.dispose();
    this.terminals.delete(k);
    this._onDidChange.fire();
    return true;
  }

  /**
   * Get all registered terminals.
   */
  getAll(): Array<{ persona: string; branch: string; provider: string; hidden: boolean }> {
    return Array.from(this.terminals.values()).map(e => ({
      persona: e.persona,
      branch: e.branch,
      provider: e.provider,
      hidden: e.hidden,
    }));
  }

  /**
   * Reveal every registered terminal in the VS Code UI, even ones launched
   * with hideFromUser: true. Used by the "Show All VibeFlow Terminals"
   * command — without this, hidden advisory-agent terminals are invisible
   * because VS Code excludes them from both the dropdown and the Tabs view.
   *
   * Returns the count of terminals revealed so the caller can surface a
   * "0 terminals" hint when nothing's running.
   */
  revealAll(): number {
    let count = 0;
    for (const entry of this.terminals.values()) {
      // show(true) = preserveFocus, so we don't yank focus to whichever
      // terminal happens to be last in the iteration order.
      entry.terminal.show(true);
      count++;
    }
    return count;
  }

  dispose(): void {
    this.disposeListener.dispose();
    this._onDidChange.dispose();
    // Don't dispose terminals here — they belong to the user
  }
}
