import * as vscode from 'vscode';
import { personaDisplayName } from '../../sessions/personas.js';

interface FileActivity {
  persona: string;
  type: 'active' | 'committed' | 'commented';
}

/**
 * Shows colored badges on files in the Explorer indicating which
 * agent persona is modifying them.
 *
 * D = Developer (green), A = Architect (blue), P = Principal Engineer (yellow),
 * S = Security Lead (red), Q = QA Lead (teal), M = Product Manager (orange).
 */
export class AgentFileDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  // file path → latest activity
  private activities = new Map<string, FileActivity>();

  private static PERSONA_BADGES: Record<string, { letter: string; color: string }> = {
    developer: { letter: 'D', color: 'charts.green' },
    architect: { letter: 'A', color: 'charts.blue' },
    principal_engineer: { letter: 'P', color: 'charts.yellow' },
    security_lead: { letter: 'S', color: 'charts.red' },
    qa_lead: { letter: 'Q', color: 'terminal.ansiCyan' },
    product_manager: { letter: 'M', color: 'charts.orange' },
    project_manager: { letter: 'J', color: 'charts.purple' },
    ux_designer: { letter: 'U', color: 'terminal.ansiMagenta' },
    customer: { letter: 'C', color: 'disabledForeground' },
  };

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const activity = this.activities.get(uri.fsPath);
    if (!activity) { return undefined; }

    const badge = AgentFileDecorationProvider.PERSONA_BADGES[activity.persona];
    if (!badge) { return undefined; }

    const name = personaDisplayName(activity.persona);

    if (activity.type === 'active') {
      return new vscode.FileDecoration(
        badge.letter,
        `Being modified by ${name}`,
        new vscode.ThemeColor(badge.color),
      );
    }

    if (activity.type === 'committed') {
      return new vscode.FileDecoration(
        '\u2022', // bullet dot
        `Modified by ${name} (committed)`,
        new vscode.ThemeColor('disabledForeground'),
      );
    }

    if (activity.type === 'commented') {
      return new vscode.FileDecoration(
        '\u2022',
        'Has unresolved comments',
        new vscode.ThemeColor('terminal.ansiMagenta'),
      );
    }

    return undefined;
  }

  /**
   * Mark a file as being actively modified by a persona.
   */
  markActive(filePath: string, persona: string): void {
    this.activities.set(filePath, { persona, type: 'active' });
    this._onDidChangeFileDecorations.fire(vscode.Uri.file(filePath));
  }

  /**
   * Mark a file as committed by a persona (subtler decoration).
   */
  markCommitted(filePath: string, persona: string): void {
    this.activities.set(filePath, { persona, type: 'committed' });
    this._onDidChangeFileDecorations.fire(vscode.Uri.file(filePath));
  }

  /**
   * Mark a file as having unresolved comments.
   */
  markCommented(filePath: string): void {
    this.activities.set(filePath, { persona: '', type: 'commented' });
    this._onDidChangeFileDecorations.fire(vscode.Uri.file(filePath));
  }

  /**
   * Clear decoration for a file.
   */
  clear(filePath: string): void {
    if (this.activities.delete(filePath)) {
      this._onDidChangeFileDecorations.fire(vscode.Uri.file(filePath));
    }
  }

  /**
   * Clear all decorations.
   */
  clearAll(): void {
    this.activities.clear();
    this._onDidChangeFileDecorations.fire(undefined);
  }

  dispose(): void {
    this._onDidChangeFileDecorations.dispose();
  }
}
