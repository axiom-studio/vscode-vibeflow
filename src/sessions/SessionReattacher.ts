import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TerminalRegistry, type TerminalMode } from './TerminalRegistry.js';
import { personaDisplayName } from './personas.js';
import { lookupLaunchMode, recordLaunchMode } from './launchModeStore.js';
import type { ContextProxy } from '../core/ContextProxy.js';
import { TmuxBacking, buildHeadlessTmuxName } from './tmuxBacking.js';

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
    liveSessionIds?: Set<string>,
  ): Promise<PhantomSession[]> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) { return []; }

    const rootPath = workspaceFolder.uri.fsPath;
    const phantoms: PhantomSession[] = [];
    const prefix = '.vibeflow-session-';
    // Cache one TmuxBacking instance for the whole sweep — stateless
    // verb dispatcher, cheap to construct but pointless to recreate.
    const tmuxBacking = new TmuxBacking();

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
          if (!sessionId || !sessionId.startsWith('session-')) { continue; }

          // Defensive: if we know the live session list and this id
          // isn't in it, the agent was killed/deleted but the sidecar
          // wasn't swept (older builds, manual `rm` of the terminal,
          // or a backend-side cleanup that bypassed our killSession
          // path). Quietly delete the file rather than offering a
          // reattach the backend will reject.
          if (liveSessionIds && !liveSessionIds.has(sessionId)) {
            try { await fs.promises.rm(filePath, { force: true }); } catch { /* ignore */ }
            continue;
          }

          // Skip phantoms whose tmux pane is still alive — the agent
          // is still running there (tmux's whole point per #1615), so
          // reattaching would spawn a DUPLICATE process polling against
          // the same session_id. The existing `killSession` path
          // already uses this same hasSession + buildHeadlessTmuxName
          // pair (post-#2324) to avoid duplicate spawns; the reattach
          // path now honors it too. User-reported via agent-prompt
          // 317f7014 (2026-05-24): "if tmux sessions are running — is
          // this required?"
          //
          // Naming: buildHeadlessTmuxName is deterministic across IDE
          // restarts as long as (persona, branch, workDir) match, so a
          // tmux pane launched in the previous window resolves to the
          // same name we'd compute now. Best-effort — hasSession
          // returning false (tmux unavailable, no pane) just falls
          // through to the existing "is a phantom" treatment.
          try {
            const headlessName = buildHeadlessTmuxName(persona, gitBranch, rootPath);
            const alive = await tmuxBacking.hasSession(headlessName);
            if (alive) { continue; }
          } catch {
            // hasSession throws on tmux-not-installed / Windows / etc.
            // Treat as "not alive" — preserve pre-#317f7014 behavior.
          }

          phantoms.push({ persona, sessionId, filePath });
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
    context: ContextProxy,
    projectName?: string,
  ): Promise<PhantomSession[]> {
    if (phantoms.length === 0) { return []; }

    // Resolve mode per phantom up front so we can tell the user which ones
    // are sticky-on-record vs which need a choice.
    const recordedModeByPersona = new Map<string, string>();
    let needsChoice = 0;
    for (const phantom of phantoms) {
      const recorded = lookupLaunchMode(context, phantom.persona, gitBranch, workDir);
      if (recorded) {
        recordedModeByPersona.set(phantom.persona, recorded);
      } else {
        needsChoice++;
      }
    }

    const names = phantoms.map(p => personaDisplayName(p.persona)).join(', ');
    // Single inline prompt — three options when at least one phantom has no
    // recorded mode (so the user picks how to handle the unknown ones), or
    // a simple confirm-only when every phantom is sticky-on-record.
    let userChoice: 'vanilla' | 'vibeflow' | undefined;
    if (needsChoice > 0) {
      const detail = recordedModeByPersona.size > 0
        ? ` (${recordedModeByPersona.size} sticky on recorded mode, ${needsChoice} needs a choice)`
        : '';
      const action = await vscode.window.showInformationMessage(
        `VibeFlow: ${phantoms.length} session(s) from previous window detected (${names})${detail}. Reattach?`,
        'Reattach in vanilla',
        'Reattach in vibeflow (YOLO)',
        'Dismiss',
      );
      if (action === 'Reattach in vanilla') { userChoice = 'vanilla'; }
      else if (action === 'Reattach in vibeflow (YOLO)') { userChoice = 'vibeflow'; }
      else { return []; }
    } else {
      const action = await vscode.window.showInformationMessage(
        `VibeFlow: ${phantoms.length} session(s) from previous window detected (${names}). Reattach in their original modes?`,
        'Reattach All',
        'Dismiss',
      );
      if (action !== 'Reattach All') { return []; }
    }

    // Per-phantom terminalMode resolution. Visible-mode reattach is the
    // historical default — user explicitly asked to reattach, so show all
    // terminals regardless of hybrid setting. Chat-First (todo #1611)
    // breaks the rule: a recorded `chat_first` mode means the user opted
    // into a hidden agent + chat-only surface, and that consent persists
    // across IDE restart. Only an explicit vanilla/vibeflow override at
    // the reattach prompt downgrades the headless behavior.
    const reattached: PhantomSession[] = [];
    for (const phantom of phantoms) {
      try {
        // Recorded mode wins (sticky from original launch). Otherwise the
        // user's button choice applies. The config-driven `sessionMode`
        // remains the floor of last resort if for some reason the user's
        // answer is missing — defensive only, the prompt above guarantees
        // userChoice is set whenever needsChoice > 0.
        const recordedMode = recordedModeByPersona.get(phantom.persona);
        const phantomMode = recordedMode ?? userChoice ?? sessionMode;
        const phantomTerminalMode: TerminalMode = phantomMode === 'chat_first' ? 'none' : 'all';

        const command = buildReattachCommand(provider, phantomMode);

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
          terminalMode: phantomTerminalMode,
          initPrompt,
        });

        // Record the resolved mode so the next reattach (or right-click
        // Restart) on this persona+branch+workDir doesn't have to ask
        // again. Idempotent for already-recorded phantoms; meaningful for
        // ones that were unrecorded and just got the user's choice.
        void recordLaunchMode(context, phantom.persona, gitBranch, workDir, phantomMode);

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

  // YOLO modes: vibeflow (visible terminal) and chat_first (hidden
  // terminal + chat-only — see todo #1611). Both apply
  // --dangerously-skip-permissions / --yolo flags. Anything else (e.g.
  // legacy 'auto' written by older builds, or 'vanilla') falls through
  // to a flag-free binary so we never reattach with an unexpected flag.
  const isYolo = sessionMode === 'vibeflow' || sessionMode === 'chat_first';
  if (!isYolo) { return binary; }
  if (provider === 'claude') { return `${binary} --dangerously-skip-permissions`; }
  if (provider === 'codex' || provider === 'gemini') { return `${binary} --yolo`; }
  if (provider === 'cursor') { return `${binary} --yolo --approve-mcps`; }
  return binary;
}
