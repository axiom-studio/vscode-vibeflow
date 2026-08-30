import * as vscode from 'vscode';
import * as path from 'path';
import { isValidCommitHash, parsePathReference } from './chatRenderer.js';
import { commitWebUrl, sameRepo } from './commitWebUrl.js';

/**
 * Shared host-side handlers for the two chat click-to-open affordances
 * (commit hash + workspace path). Extracted from
 * SessionPanelManager so both the Session Chat webview AND the Activity
 * Feed webview can dispatch into the same code path without
 * duplicating workspace-containment + validation logic.
 *
 * Both handlers re-validate their inputs before doing anything — the
 * webview side is treated as untrusted (a chat message rendered into
 * the webview could carry a payload an attacker injected upstream).
 */

/**
 * Open a commit in VSCode's native Commit Details editor tab. Prefers
 * the built-in `git.viewCommit` command from the bundled
 * `vscode.git` extension; falls back to a `git show --stat` terminal
 * spawn if the extension isn't available.
 *
 * `sessionRemoteUrl` (#3355) is the remote of the repository the CHAT's
 * session works on — a session chat can belong to a different repo than
 * the open workspace, in which case the local repo can never show the
 * commit and the session repo's commit web page is opened directly.
 *
 * The hash is re-validated via `isValidCommitHash` even though the
 * webview tokenizer is supposed to emit only valid hashes — defense
 * in depth in case a future caller forgets.
 */
/**
 * Open an external commit URL derived from a session remote, but ONLY after
 * the user confirms the destination host (#3386, CWE-601). A session's
 * `git_remote_url` is a free-form, cross-user-controllable string on a shared
 * project, so `commitWebUrl` can resolve to an attacker-chosen host
 * (`https://evil.com/…/commit/<hash>`). Surfacing the host and requiring a
 * click prevents a peer's session from auto-redirecting the victim's browser.
 */
export async function confirmAndOpenExternal(url: string): Promise<void> {
  let host: string;
  try { host = new URL(url).host; } catch { host = url; }
  const pick = await vscode.window.showInformationMessage(
    `Open this commit on ${host} in your browser?`,
    'Open',
  );
  if (pick === 'Open') {
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }
}

export async function openCommitDiff(hash: string, sessionRemoteUrl?: string): Promise<void> {
  if (!isValidCommitHash(hash)) {
    vscode.window.showWarningMessage(`Chat link rejected (invalid commit hash): ${hash}`);
    return;
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    // No workspace repo to resolve against — the session repo's web
    // page is still reachable when the chat supplied its remote.
    const noFolderUrl = sessionRemoteUrl ? commitWebUrl(sessionRemoteUrl, hash) : undefined;
    if (noFolderUrl) {
      // #3386: confirm the (cross-user-controllable) destination host first.
      await confirmAndOpenExternal(noFolderUrl);
      return;
    }
    vscode.window.showWarningMessage('Open a folder to view commit diffs.');
    return;
  }
  const gitExt = vscode.extensions.getExtension('vscode.git');
  type RepoLike = {
    rootUri: { fsPath: string };
    state?: { remotes?: Array<{ name?: string; fetchUrl?: string; pushUrl?: string }> };
    getCommit?: (ref: string) => Promise<unknown>;
  };
  let repo: RepoLike | undefined;
  if (gitExt) {
    try {
      const api = (gitExt.isActive ? gitExt.exports : await gitExt.activate())?.getAPI?.(1);
      // Repo match: previous strict `r.rootUri.fsPath === folder.uri.fsPath`
      // failed silently for monorepos / subfolder-open setups (e.g.
      // user opens `src/` of a parent repo; workspace folder fsPath
      // doesn't equal the repo rootUri fsPath). Then the path fell
      // through to the terminal fallback prompt, which the user
      // experiences as "click did nothing useful". User-reported via
      // agent-prompt e8f02fd4 (2026-05-24).
      //
      // Tolerant match:
      //   1. Exact match (was the original behavior).
      //   2. Workspace folder is a subdir of the repo (user opened a
      //      subfolder). Most common monorepo case.
      //   3. The repo is a subdir of the workspace (multi-root workspaces).
      //   4. If there's exactly ONE repo registered, use it regardless.
      const repos: RepoLike[] = api?.repositories ?? [];
      const workspaceFs = folder.uri.fsPath;
      repo = repos.find(r => r.rootUri.fsPath === workspaceFs);
      if (!repo) {
        // Case 2: workspace is under the repo (workspaceFs starts with rootUri/).
        repo = repos.find(r => {
          const rootFs = r.rootUri.fsPath;
          return workspaceFs === rootFs || workspaceFs.startsWith(rootFs + '/') || workspaceFs.startsWith(rootFs + '\\');
        });
      }
      if (!repo) {
        // Case 3: repo is under the workspace.
        repo = repos.find(r => {
          const rootFs = r.rootUri.fsPath;
          return rootFs.startsWith(workspaceFs + '/') || rootFs.startsWith(workspaceFs + '\\');
        });
      }
      if (!repo && repos.length === 1) {
        // Case 4: single registered repo, no path overlap — trust it.
        repo = repos[0];
      }
    } catch {
      // Git extension unavailable/broken — fall through to the fallbacks.
    }
  }

  const remotes = repo?.state?.remotes ?? [];
  const remote = remotes.find(r => r.name === 'origin') ?? remotes[0];
  const workspaceRemoteUrl = remote?.fetchUrl ?? remote?.pushUrl;

  // Foreign-repo shortcut (#3355): when the chat's session works on a
  // DIFFERENT repository than the open workspace, the local repo can
  // never contain the commit — skip the doomed local attempt and give
  // the link click link behavior: open the session repo's commit page.
  const foreign = !!sessionRemoteUrl && !!workspaceRemoteUrl
    && !sameRepo(sessionRemoteUrl, workspaceRemoteUrl);

  if (repo && !foreign) {
    try {
      // Probe existence SILENTLY first (#3357): a rejecting API call
      // shows nothing, whereas a failing `git.viewCommit` command lets
      // the git extension toast its raw `fatal: bad revision` error at
      // the user before our fallback can run. Missing commit (unfetched,
      // checkout behind, committed elsewhere) → straight to the web
      // fallback below (#3350). Older git APIs without getCommit keep
      // the direct-invoke behavior.
      await repo.getCommit?.(hash);
      await vscode.commands.executeCommand('git.viewCommit', repo, hash);
      return;
    } catch {
      // Fall through to the fallbacks — the remote web page can still
      // serve the source (#3350).
    }
  }

  // Remote-web fallback (#3350): agents push after every commit, so the
  // commit page shows the source even when the local clone doesn't have
  // the object. The session's own remote wins over the workspace origin.
  const webUrl = (sessionRemoteUrl ? commitWebUrl(sessionRemoteUrl, hash) : undefined)
    ?? (workspaceRemoteUrl ? commitWebUrl(workspaceRemoteUrl, hash) : undefined);

  if (foreign && webUrl) {
    // #3386: the session repo is foreign; confirm the destination host before
    // opening (session.git_remote_url is cross-user-controllable).
    await confirmAndOpenExternal(webUrl);
    return;
  }

  const actions = [
    ...(webUrl ? ['Open on remote'] : []),
    'Open in terminal',
    'Cancel',
  ];
  const pick = await vscode.window.showInformationMessage(
    `Commit ${hash.slice(0, 8)} could not be opened from the local repository.`,
    ...actions,
  );
  if (pick === 'Open on remote' && webUrl) {
    await vscode.env.openExternal(vscode.Uri.parse(webUrl));
    return;
  }
  if (pick === 'Open in terminal') {
    // Deliberately NOT converted to createProcessTerminal (#4995): the
    // command is sub-second and display-only (worst case under the PTY
    // race is one garbled output line), and keeping a live shell afterward
    // is the point — the user lands in a prompt to keep poking at git.
    const term = vscode.window.createTerminal({
      name: `git show ${hash.slice(0, 8)}`,
      cwd: folder.uri.fsPath,
    });
    term.sendText(`git show --stat ${hash}`, true);
    term.show();
  }
}

/**
 * Open an `issue #N` / `todo #N` chat reference in a new editor tab
 * (#3350). Inputs come from the webview, so both are re-validated
 * before reaching the command — same untrusted-webview posture as the
 * commit/path handlers above.
 */
export function openWorkItemFromChat(kind: unknown, id: unknown): void {
  if (kind !== 'issue' && kind !== 'todo') { return; }
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0 || id > 9_999_999_999) { return; }
  void vscode.commands.executeCommand(
    'vibeflow.openWorkItemPanel',
    `${kind}-${id}`,
    `${kind} #${id}`,
  );
}

/**
 * Open a workspace-relative file at the given 1-indexed line/column.
 * Rejects absolute paths + paths that escape the workspace. Used by
 * Session Chat and Activity Feed click handlers; the path is also
 * re-parsed via `parsePathReference` so the webview-side regex
 * doesn't get to dictate the host-side parse.
 */
export async function openWorkspaceRelativePath(rel: string, line?: number, column?: number): Promise<void> {
  // Re-parse via the canonical pattern. Allows the caller to pass either
  // a pre-split (path, line, col) OR a single string like `foo.ts:42:7` —
  // the latter happens when the webview reconstructs the raw label.
  const parsed = parsePathReference(line ? `${rel}:${line}${column ? `:${column}` : ''}` : rel);
  const resolved = parsed ?? { path: rel, line, column };

  if (resolved.path.startsWith('/') || /^[A-Za-z]:/.test(resolved.path)) {
    vscode.window.showWarningMessage(`Chat link rejected (absolute path): ${resolved.path}`);
    return;
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showWarningMessage('Open a folder to follow chat links.');
    return;
  }
  const absolute = path.join(folder.uri.fsPath, resolved.path);
  const relCheck = path.relative(folder.uri.fsPath, absolute);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    vscode.window.showWarningMessage(`Chat link rejected (escapes workspace): ${resolved.path}`);
    return;
  }
  const uri = vscode.Uri.file(absolute);
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);
    if (resolved.line && resolved.line > 0) {
      const zeroLine = Math.max(0, resolved.line - 1);
      const zeroCol = resolved.column && resolved.column > 0 ? Math.max(0, resolved.column - 1) : 0;
      const pos = new vscode.Position(zeroLine, zeroCol);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
  } catch (err) {
    // File not found at workspace-root-relative path. The agent often
    // refers to a deeply-nested file by its bare basename in chat (e.g.
    // "SessionPanelManager.ts" intending `src/views/sessions/SessionPanelManager.ts`).
    // Fall back to Quick Open prefilled with the basename so the user
    // can fuzzy-pick in 1-2 keystrokes instead of seeing an error toast.
    // User-reported via agent-prompt e8f02fd4 (2026-05-24).
    const basename = resolved.path.replace(/^.*[/\\]/, '');
    if (basename && basename !== resolved.path) {
      // The chat link was a non-trivial path (had slashes) but the
      // file genuinely wasn't there. Surface the error — fuzzy-fallback
      // would be confusing when the user typed a specific path.
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showWarningMessage(`Could not open ${resolved.path}: ${msg}`);
      return;
    }
    // Bare basename — fall back to Quick Open. `query` is set via the
    // command's second arg (a string). VS Code prefills the picker with
    // it; user hits Enter to open the top match or types to narrow.
    try {
      await vscode.commands.executeCommand('workbench.action.quickOpen', basename);
    } catch {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showWarningMessage(`Could not open ${resolved.path}: ${msg}`);
    }
  }
}
