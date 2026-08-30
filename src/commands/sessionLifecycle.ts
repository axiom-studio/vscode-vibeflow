import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { VibeFlowClient } from '../api/client.js';
import type { ProjectDetector } from '../project/ProjectDetector.js';
import type { SessionsTreeProvider } from '../views/sessions/SessionsTreeProvider.js';
import type { VibeFlowSession } from '../api/types.js';
import { TerminalRegistry, type TerminalMode } from '../sessions/TerminalRegistry.js';
import { removeWorktreeAt } from './worktreeCommands.js';
import { recordLaunchMode, lookupLaunchMode } from '../sessions/launchModeStore.js';
import { killTmuxSession } from '../sessions/tmuxState.js';
import type { ContextProxy } from '../core/ContextProxy.js';
import { TmuxBacking, buildHeadlessTmuxName } from '../sessions/tmuxBacking.js';
import { buildLaunchArgs, AGENT_BINARIES } from './sessionCommands.js';

/**
 * Best-effort delete of `.vibeflow-session-{persona}` from the session's
 * working directory (or worktree path if set). Used by:
 *   - killAndForgetSession — explicit user request to wipe resume state
 *   - SessionReattacher's stale-sweep path — when liveSessionIds confirms
 *     the file points at a session_id the backend no longer knows
 *
 * No-op when the file is missing, so safe to call from any teardown.
 * Default kill paths intentionally do NOT call this — the file is the
 * session's resume hint and matches CLI semantics
 * (vibeflow-cli/internal/vibeflowcli/tui.go:619).
 */
export function removeSessionFile(persona: string, workDir: string): void {
  if (!workDir || !persona) { return; }
  const filePath = path.join(workDir, `.vibeflow-session-${persona}`);
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Permissions / already gone — nothing actionable from a kill path.
  }
}

/**
 * Focus the terminal for a session. Opens hidden terminals.
 */
export function focusTerminal(
  terminalRegistry: TerminalRegistry,
  session: VibeFlowSession,
): void {
  const found = terminalRegistry.focus(session.persona_key, session.git_branch);
  if (!found) {
    vscode.window.showInformationMessage(
      `VibeFlow: No local terminal for ${session.persona_name ?? session.persona_key}. This session may be running on another machine.`,
    );
  }
}

/**
 * Kill a session with confirmation. Disposes the local terminal AND
 * deletes the backend record — anything less leaves the user looking
 * at a "killed" status badge while the agent process is still running
 * locally, which is confusing and can also cause stale write attempts
 * against the backend (the agent's next heartbeat 404s).
 *
 * Sidecar file is preserved by default for session-ID resume on next
 * launch (matches CLI semantics — see vibeflow-cli/internal/vibeflowcli/
 * tui.go:619). Use killAndForgetSession when the user explicitly wants
 * to wipe the resume hint.
 */
export async function killSession(
  client: VibeFlowClient,
  session: VibeFlowSession,
  sessionsProvider: SessionsTreeProvider,
  terminalRegistry: TerminalRegistry,
): Promise<void> {
  return killSessionInternal(client, session, sessionsProvider, terminalRegistry, { forget: false });
}

/**
 * Kill a session AND wipe its `.vibeflow-session-{persona}` sidecar so
 * the next launch starts fresh. Matches the CLI's `CleanupStaleSession`
 * concept but invoked explicitly by the user. The default Kill action
 * preserves the sidecar to enable session_id resume; this one is the
 * "forget everything, start over" variant.
 */
export async function killAndForgetSession(
  client: VibeFlowClient,
  session: VibeFlowSession,
  sessionsProvider: SessionsTreeProvider,
  terminalRegistry: TerminalRegistry,
): Promise<void> {
  return killSessionInternal(client, session, sessionsProvider, terminalRegistry, { forget: true });
}

interface KillOptions {
  /** When true, also delete the .vibeflow-session-{persona} sidecar. */
  forget: boolean;
}

async function killSessionInternal(
  client: VibeFlowClient,
  session: VibeFlowSession,
  sessionsProvider: SessionsTreeProvider,
  terminalRegistry: TerminalRegistry,
  opts: KillOptions,
): Promise<void> {
  const personaLabel = session.persona_name ?? session.persona_key;
  const prompt = opts.forget
    ? `Kill ${personaLabel} session on ${session.git_branch} AND forget its resume state? Next launch will start a fresh session.`
    : `Kill ${personaLabel} session on ${session.git_branch}? The session id stays on disk so the next launch can resume.`;
  const button = opts.forget ? 'Kill & Forget' : 'Kill Session';
  const confirm = await vscode.window.showWarningMessage(
    prompt,
    { modal: true },
    button,
  );
  if (confirm !== button) { return; }

  // Tear down the agent's local resources first — even if the backend
  // kill fails, we don't want to leave the agent process alive after
  // the user explicitly asked to kill it.
  //
  // Two custody models to handle:
  //   - Extension-launched terminals live in TerminalRegistry. Disposing
  //     the registered terminal sends Ctrl-C-then-close to the shell.
  //   - CLI-launched agents live under tmux on the `-L vibeflow` socket;
  //     TerminalRegistry has no record of them. Without an explicit
  //     tmux kill-session, the pane keeps running with an orphan claude
  //     process inside that 404s against the now-deleted backend record.
  //     This is exactly the "vibeflow-cli shows a disconnected entry
  //     after extension-side kill" bug.
  //
  // Both calls are no-ops when nothing's there, so it's safe to run
  // both unconditionally — cheaper than threading a "which mode launched
  // this session" flag through the call site.
  terminalRegistry.kill(session.persona_key, session.git_branch);
  killTmuxSession(session.agent_type ?? '', session.session_id);
  // Headless tmux-backing (todo #1615) lives on a different socket
  // (`vibeflow-headless`). Names follow `buildHeadlessTmuxName` —
  // we recompute here from (persona, branch, workDir) so we don't
  // need to thread another parameter through every kill call site.
  // TmuxBacking is stateless (verb dispatcher only); local instance.
  // Best-effort; no-op when the session was launched any other way.
  const workDir = session.git_worktree_path
    || session.working_directory
    || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    || '';
  if (workDir) {
    const headlessName = buildHeadlessTmuxName(session.persona_key, session.git_branch, workDir);
    void new TmuxBacking().kill(headlessName);
  }

  // Sidecar handling depends on whether the user picked "Kill" or
  // "Kill & Forget". Default Kill preserves the sidecar to enable
  // session_id resume on next launch — matches CLI semantics
  // (vibeflow-cli/internal/vibeflowcli/tui.go:619 — "Session file is
  // intentionally kept so the session ID can be reused on next
  // launch.") Kill & Forget wipes the sidecar so the next launch
  // starts a fresh session_id, mirroring the CLI's
  // CleanupStaleSession path.
  //
  // Stale sidecars (kept by Kill, but whose session_id the backend
  // doesn't know about anymore) are swept on the next window load by
  // SessionReattacher.detectPhantoms via the liveSessionIds cross-check.
  if (opts.forget) {
    const sidecarDir = session.git_worktree_path || session.working_directory;
    removeSessionFile(session.persona_key, sidecarDir);
  }

  let backendKillSucceeded = false;
  try {
    await client.killSession(session.session_id);
    backendKillSucceeded = true;
    const msg = opts.forget
      ? 'VibeFlow: Session killed and forgotten'
      : 'VibeFlow: Session killed';
    vscode.window.showInformationMessage(msg);
  } catch (err) {
    // Local terminal is already gone; surface the backend error so the
    // user knows the server record may need manual cleanup, but don't
    // pretend the kill failed entirely.
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`VibeFlow: Local terminal killed but backend record cleanup failed — ${msg}`);
  }

  // Cleanup-on-kill: remove the session's worktree iff backend kill
  // succeeded, the session was running in a worktree, and the user opted
  // in via `vibeflow.worktree.cleanupOnKill`. Skipped on backend failure
  // because we'd be removing the worktree of a still-active session
  // record, which is worse than leaving the worktree in place.
  if (backendKillSucceeded && session.git_worktree_path) {
    await maybeCleanupWorktree(session);
  }

  sessionsProvider.refresh();
}

/**
 * Honor `vibeflow.worktree.cleanupOnKill` after a successful kill:
 *   - `always` → unconditional `git worktree remove --force`
 *   - `ask`    → modal prompt, only removes on confirm
 *   - `never`  → noop
 *
 * Run from the session's launch workspace folder, not the worktree
 * itself — `git worktree remove` cannot remove the cwd it's running in.
 */
async function maybeCleanupWorktree(session: VibeFlowSession): Promise<void> {
  const cleanup = vscode.workspace.getConfiguration('vibeflow')
    .get<'ask' | 'always' | 'never'>('worktree.cleanupOnKill', 'ask');
  if (cleanup === 'never') { return; }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) { return; }
  // If the user happens to have opened the worktree itself as their
  // workspace, fall back to the working_directory the session recorded.
  const cwd = workspaceRoot === session.git_worktree_path
    ? (session.working_directory || workspaceRoot)
    : workspaceRoot;

  if (cleanup === 'ask') {
    const confirm = await vscode.window.showWarningMessage(
      `Delete the worktree this session ran in?\n\n${session.git_worktree_path}`,
      { modal: true },
      'Delete Worktree',
    );
    if (confirm !== 'Delete Worktree') { return; }
  }

  try {
    removeWorktreeAt(cwd, session.git_worktree_path!);
    vscode.window.showInformationMessage(`VibeFlow: Worktree ${session.git_worktree_path} removed`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`VibeFlow: Failed to remove worktree — ${msg}`);
  }
}

/**
 * Remove an inactive session record from the project. The active path is
 * killSession (which both kills the local terminal and deletes the server
 * record); this is the lighter-weight cleanup for sessions whose terminals
 * are already gone but whose server records linger.
 */
export async function deleteSession(
  client: VibeFlowClient,
  session: VibeFlowSession,
  sessionsProvider: SessionsTreeProvider,
): Promise<void> {
  const persona = session.persona_name ?? session.persona_key;
  const confirm = await vscode.window.showWarningMessage(
    `Delete the ${persona} session record on ${session.git_branch}? This removes it from the Agent Fleet permanently.`,
    { modal: true },
    'Delete',
  );
  if (confirm !== 'Delete') { return; }

  try {
    // killSession already calls DELETE /sessions/{id} on the backend; we
    // just give it a different prompt so the wording matches the user's
    // intent ("delete the record" vs "kill the running agent").
    await client.killSession(session.session_id);
    // Defensive tmux kill — this command is gated on inactiveSession in
    // the menu, so the pane SHOULD already be dead. But "ghost" state
    // (backend active + tmux dead) and similar edge cases mean we run
    // it anyway. No-op when nothing matches.
    killTmuxSession(session.agent_type ?? '', session.session_id);
    // Sidecar is intentionally preserved — same reasoning as
    // killSession: it's session-ID memory for resume, not process state.
    vscode.window.showInformationMessage(`VibeFlow: ${persona} session removed`);
    sessionsProvider.refresh();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`VibeFlow: Failed to delete session — ${msg}`);
  }
}

/**
 * Copy a session id to the clipboard. Useful for filing bug reports,
 * pasting into Cloud UI's session detail view, or the agent's
 * `session_init(session_id: ...)` recovery path.
 */
export async function copySessionId(session: VibeFlowSession): Promise<void> {
  await vscode.env.clipboard.writeText(session.session_id);
  vscode.window.showInformationMessage(`VibeFlow: Copied session id ${session.session_id}`);
}

/**
 * Restart a session — kill the existing record + terminal, then spawn a
 * fresh terminal for the same persona / provider / branch / workdir so
 * the agent re-enters its polling loop without the user having to walk
 * the wizard again.
 *
 * The agent itself calls `session_init` from inside the new terminal
 * (via the standard init prompt that launchSession also uses), so the
 * extension still doesn't touch session_init directly — same constraint
 * documented in the P3-B notes, just executed via the agent binary
 * instead of bouncing the user back to "Launch Session" manually.
 */
export async function restartSession(
  client: VibeFlowClient,
  session: VibeFlowSession,
  detector: ProjectDetector,
  sessionsProvider: SessionsTreeProvider,
  terminalRegistry: TerminalRegistry,
  context: ContextProxy,
): Promise<void> {
  const personaLabel = session.persona_name ?? session.persona_key;
  const confirm = await vscode.window.showWarningMessage(
    `Restart ${personaLabel} session on ${session.git_branch}?`,
    { modal: true },
    'Restart',
  );
  if (confirm !== 'Restart') { return; }

  const project = detector.getCachedProject();
  if (!project) {
    vscode.window.showErrorMessage('VibeFlow: No project cached. Run "VibeFlow: Setup" first.');
    return;
  }

  try {
    await client.killSession(session.session_id);
  } catch (err) {
    // Backend kill failure shouldn't block the respawn — the local
    // terminal might already be gone and the user just wants the agent
    // back. Log and continue; the new session_init will reconcile.
    console.warn('[VibeFlow] killSession failed during restart, continuing:', err);
  }

  // Resolve respawn parameters from the session record + config.
  // Prefer the session's worktree path so a worktree-launched agent
  // restarts inside the worktree, not the main workspace.
  const config = vscode.workspace.getConfiguration('vibeflow');
  const provider = session.agent_type || config.get<string>('defaultProvider', 'claude');
  const persona = session.persona_key;
  const branch = session.git_branch;
  const workDir = session.git_worktree_path
    || session.working_directory
    || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    || '';
  if (!workDir) {
    vscode.window.showErrorMessage('VibeFlow: cannot resolve a working directory for restart.');
    return;
  }

  // Resolution order for sessionMode:
  //   1. The mode we recorded when this persona was originally launched
  //      on this branch+workDir (so YOLO stays YOLO and vanilla stays
  //      vanilla — no surprise downgrade or upgrade).
  //   2. vibeflow.session.reattachMode config — applies when the launch
  //      record is missing (e.g. session created before this tracking
  //      shipped, or workspace state was wiped).
  //   3. 'vanilla' as the safety floor.
  const recordedMode = lookupLaunchMode(context, persona, branch, workDir);
  const sessionMode = recordedMode
    ?? config.get<string>('session.reattachMode', 'vanilla');
  // Chat-First sessions force `'none'` (hidden terminal) regardless of the
  // workspace `session.terminalMode` setting — chat is the only surface.
  const workspaceTerminalMode = config.get<TerminalMode>('session.terminalMode', 'hybrid');
  const terminalMode: TerminalMode = sessionMode === 'chat_first' ? 'none' : workspaceTerminalMode;
  const serverUrl = config.get<string>('serverUrl', 'https://cloud.axiomstudio.ai');

  const binary = AGENT_BINARIES[provider] ?? 'claude';
  const initPrompt = `Initialize a vibeflow session for project ${project.projectName} with persona ${persona} and follow the agent prompt. Call session_init with project_name: ${project.projectName}, persona: ${persona}, git_branch: ${branch} and begin Phase 1 immediately.`;

  try {
    terminalRegistry.create({
      persona,
      branch,
      provider,
      workDir,
      binary,
      args: buildLaunchArgs(provider, sessionMode),
      env: {
        VIBEFLOW_SERVER_URL: serverUrl,
        VIBEFLOW_PERSONA: persona,
        VIBEFLOW_BRANCH: branch,
      },
      terminalMode,
      initPrompt,
    });
    // Refresh the launch-mode record. Usually it's already there from
    // the original launch; this keeps it accurate when a config-driven
    // fallback resolved the mode (e.g. when the original launch
    // pre-dates this tracking).
    void recordLaunchMode(context, persona, branch, workDir, sessionMode);
    vscode.window.showInformationMessage(
      `VibeFlow: Restarted ${personaLabel} on ${branch}.`,
    );
    sessionsProvider.refresh();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`VibeFlow: Failed to respawn terminal — ${msg}`);
  }
}
