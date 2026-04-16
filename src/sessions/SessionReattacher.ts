import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TerminalRegistry, type TerminalMode } from './TerminalRegistry.js';
import { personaDisplayName } from './personas.js';

export interface PhantomSession {
  persona: string;
  sessionId: string;
  filePath: string;
}

/**
 * Detects session files left over from a previous VSCode window and
 * offers to reattach terminals for them. "Phantom" sessions are ones
 * where a .vibeflow-session-{persona} file exists but no local terminal
 * is running — either because VSCode restarted or because the session
 * is running on another machine.
 */
export class SessionReattacher {
  /**
   * Scan the workspace root for .vibeflow-session-* files.
   * Returns PhantomSession[] for each file found that doesn't already
   * have a terminal in the TerminalRegistry.
   */
  static async detectPhantoms(
    terminalRegistry: TerminalRegistry,
    gitBranch: string,
  ): Promise<PhantomSession[]> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) { return []; }

    const rootPath = workspaceFolder.uri.fsPath;
    const phantoms: PhantomSession[] = [];
    const prefix = '.vibeflow-session-';

    try {
      const files = await fs.promises.readdir(rootPath);
      for (const file of files) {
        if (!file.startsWith(prefix)) { continue; }
        const persona = file.slice(prefix.length);
        if (!persona) { continue; }

        // Skip if a terminal already exists for this persona+branch
        if (terminalRegistry.has(persona, gitBranch)) { continue; }

        // Read session_id from the file
        const filePath = path.join(rootPath, file);
        try {
          const content = await fs.promises.readFile(filePath, 'utf-8');
          const sessionId = content.trim();
          if (sessionId && sessionId.startsWith('session-')) {
            phantoms.push({ persona, sessionId, filePath });
          }
        } catch {
          // Unreadable file — skip
        }
      }
    } catch {
      // Directory read failed — not critical
    }

    return phantoms;
  }

  /**
   * Show a notification offering to reattach phantom sessions.
   * Returns the list of phantoms that were reattached (empty if dismissed).
   */
  static async promptReattach(
    phantoms: PhantomSession[],
    terminalRegistry: TerminalRegistry,
    provider: string,
    sessionMode: string,
    gitBranch: string,
    workDir: string,
    serverUrl: string,
    projectName?: string,
  ): Promise<PhantomSession[]> {
    if (phantoms.length === 0) { return []; }

    const names = phantoms.map(p => personaDisplayName(p.persona)).join(', ');
    const action = await vscode.window.showInformationMessage(
      `VibeFlow: ${phantoms.length} session(s) from previous window detected (${names}). Reattach?`,
      'Reattach All',
      'Dismiss',
    );

    if (action !== 'Reattach All') { return []; }

    // Reattach always uses 'all' mode — user explicitly asked to reattach,
    // so show all terminals regardless of hybrid setting.
    const terminalMode: TerminalMode = 'all';

    const reattached: PhantomSession[] = [];
    for (const phantom of phantoms) {
      try {
        const command = buildReattachCommand(provider, sessionMode);

        const initPrompt = projectName
          ? `Initialize a vibeflow session for project ${projectName} with persona ${phantom.persona} and follow the agent prompt. Call session_init with project_name: ${projectName}, persona: ${phantom.persona}, git_branch: ${gitBranch} and begin Phase 1 immediately.`
          : undefined;

        terminalRegistry.create({
          persona: phantom.persona,
          branch: gitBranch,
          provider,
          workDir,
          command,
          env: {
            VIBEFLOW_SERVER_URL: serverUrl,
            VIBEFLOW_PERSONA: phantom.persona,
            VIBEFLOW_BRANCH: gitBranch,
          },
          terminalMode,
          initPrompt,
        });

        reattached.push(phantom);
      } catch {
        // Skip this phantom — next ones may succeed
      }
    }

    if (reattached.length > 0) {
      const names = reattached.map(p => personaDisplayName(p.persona)).join(', ');
      vscode.window.showInformationMessage(
        `VibeFlow: Reattached ${reattached.length} session(s): ${names}`,
      );
    }

    return reattached;
  }
}

/**
 * Build the command for reattaching — same as a fresh launch.
 * The agent binary reads the existing .vibeflow-session-{persona} file
 * and resumes the previous session via session_init(session_id: existing_id).
 */
function buildReattachCommand(provider: string, sessionMode: string): string {
  const binaries: Record<string, string> = {
    claude: 'claude',
    codex: 'codex',
    gemini: 'gemini',
    cursor: 'agent',
  };
  const binary = binaries[provider] ?? 'claude';

  if (sessionMode === 'vanilla') { return binary; }
  if (sessionMode === 'auto' && provider === 'claude') {
    return `${binary} --enable-auto-mode`;
  }
  // vibeflow mode
  if (provider === 'claude') { return `${binary} --dangerously-skip-permissions`; }
  if (provider === 'codex' || provider === 'gemini') { return `${binary} --yolo`; }
  if (provider === 'cursor') { return `${binary} --yolo --approve-mcps`; }
  return binary;
}
