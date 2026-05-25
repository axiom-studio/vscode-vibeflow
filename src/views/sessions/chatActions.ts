import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { isValidCommitHash, parsePathReference } from './chatRenderer.js';

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
 * The hash is re-validated via `isValidCommitHash` even though the
 * webview tokenizer is supposed to emit only valid hashes — defense
 * in depth in case a future caller forgets.
 */
export async function openCommitDiff(hash: string): Promise<void> {
  if (!isValidCommitHash(hash)) {
    vscode.window.showWarningMessage(`Chat link rejected (invalid commit hash): ${hash}`);
    return;
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showWarningMessage('Open a folder to view commit diffs.');
    return;
  }
  const gitExt = vscode.extensions.getExtension('vscode.git');
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
      const repos = api?.repositories ?? [];
      const workspaceFs = folder.uri.fsPath;
      let repo = repos.find((r: { rootUri: { fsPath: string } }) => r.rootUri.fsPath === workspaceFs);
      if (!repo) {
        // Case 2: workspace is under the repo (workspaceFs starts with rootUri/).
        repo = repos.find((r: { rootUri: { fsPath: string } }) => {
          const rootFs = r.rootUri.fsPath;
          return workspaceFs === rootFs || workspaceFs.startsWith(rootFs + '/') || workspaceFs.startsWith(rootFs + '\\');
        });
      }
      if (!repo) {
        // Case 3: repo is under the workspace.
        repo = repos.find((r: { rootUri: { fsPath: string } }) => {
          const rootFs = r.rootUri.fsPath;
          return rootFs.startsWith(workspaceFs + '/') || rootFs.startsWith(workspaceFs + '\\');
        });
      }
      if (!repo && repos.length === 1) {
        // Case 4: single registered repo, no path overlap — trust it.
        repo = repos[0];
      }
      if (repo) {
        await vscode.commands.executeCommand('git.viewCommit', repo, hash);
        return;
      }
    } catch {
      // Fall through to the terminal fallback.
    }
  }
  const pick = await vscode.window.showInformationMessage(
    `Show diff for commit ${hash.slice(0, 8)}?`,
    'Open in terminal',
    'Cancel',
  );
  if (pick === 'Open in terminal') {
    const term = vscode.window.createTerminal({
      name: `git show ${hash.slice(0, 8)}`,
      cwd: folder.uri.fsPath,
    });
    term.sendText(`git show --stat ${hash}`, true);
    term.show();
  }
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

/**
 * Result shape returned by validateHashes / validatePaths — partitions
 * the input list into confirmed-valid and confirmed-invalid. The
 * webview store relies on this partition: any token not echoed back
 * stays in `pending` forever, so on error paths we treat unknowns as
 * invalid rather than dropping them. #2341.
 */
export interface ValidationPartition { valid: string[]; invalid: string[] }

function emptyPartition(input: string[]): ValidationPartition {
  return { valid: [], invalid: [...new Set(input)] };
}

/**
 * Candidate repo roots to check. Mirrors `openCommitDiff`'s 4-rule
 * cascade so validation accepts the same set of repos that opening
 * will. A bare hash is repo-relative; "valid" means "resolves in ANY
 * candidate repo".
 */
function candidateRepoRoots(): string[] {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) { return []; }
  const fsRoots = new Set<string>();
  for (const f of folders) { fsRoots.add(f.uri.fsPath); }
  // Also consult the git extension's repo list — handles the
  // workspace-is-subfolder-of-repo and repo-is-subfolder-of-workspace
  // cases (rules 2 + 3 from openCommitDiff).
  try {
    const gitExt = vscode.extensions.getExtension('vscode.git');
    const api = gitExt?.isActive ? gitExt.exports?.getAPI?.(1) : undefined;
    const repos: { rootUri: { fsPath: string } }[] = api?.repositories ?? [];
    for (const r of repos) { fsRoots.add(r.rootUri.fsPath); }
  } catch { /* git ext not ready — workspace folders alone are fine */ }
  return [...fsRoots];
}

/**
 * Spawn `git cat-file --batch-check` once per candidate repo, feeding
 * the full hash list on stdin. Each line of output is `<hash> <type>
 * <size>` or `<input> missing`. A token is valid iff at least one
 * repo answers `type === 'commit'`. Batching avoids the per-hash
 * process-spawn overhead that a naive `git cat-file -e` loop incurs.
 *
 * On any error (git not installed, no repos, etc.) every hash is
 * reported as invalid — the webview falls back to plain text rather
 * than hanging tokens in `pending`.
 */
export async function validateHashes(
  hashes: ReadonlyArray<string>,
): Promise<ValidationPartition> {
  const unique = [...new Set(hashes.filter(isValidCommitHash))];
  if (unique.length === 0) {
    // Everything was rejected by shape — return them as invalid so the
    // webview doesn't leave them pending.
    return emptyPartition([...hashes]);
  }
  const roots = candidateRepoRoots();
  if (roots.length === 0) { return emptyPartition([...unique]); }

  const validSet = new Set<string>();
  await Promise.all(roots.map(root => new Promise<void>((resolve) => {
    const child = execFile(
      'git', ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
      { cwd: root, timeout: 5_000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) { resolve(); return; } // treat this repo as having no commits
        // Each line: `<full-or-short-input> <type>` OR `<input> missing`.
        // We match validity by INPUT (column 1), because the webview's
        // cache key is the original-cased short hash the agent typed.
        for (const line of String(stdout).split('\n')) {
          const parts = line.trim().split(/\s+/);
          if (parts.length < 2) { continue; }
          const input = parts[0];
          const type = parts[1];
          if (type === 'commit') { validSet.add(input); }
        }
        resolve();
      },
    );
    child.stdin?.write(unique.join('\n') + '\n');
    child.stdin?.end();
  })));

  const valid: string[] = [];
  const invalid: string[] = [];
  for (const h of hashes) {
    if (validSet.has(h)) { valid.push(h); } else { invalid.push(h); }
  }
  return { valid, invalid };
}

/**
 * Validate a path candidate against the filesystem. Tries:
 *   1. As-is (absolute or workspace-folder-relative resolution).
 *   2. Resolved against each candidate repo root (handles agents
 *      referring to a path by its repo-root-relative form when the
 *      workspace folder is a subdir, e.g. workspace=`src/` and the
 *      agent writes `webview-ui/foo.ts`).
 * A path is valid iff ANY candidate exists. Path strings echoed back
 * unchanged — they're the webview cache keys.
 */
export async function validatePaths(
  paths: ReadonlyArray<string>,
): Promise<ValidationPartition> {
  const unique = [...new Set(paths)];
  if (unique.length === 0) { return { valid: [], invalid: [] }; }
  const folders = vscode.workspace.workspaceFolders ?? [];
  const folderRoots = folders.map(f => f.uri.fsPath);
  const repoRoots = candidateRepoRoots();
  const allRoots = [...new Set([...folderRoots, ...repoRoots])];

  async function existsAt(absFs: string): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(absFs));
      return true;
    } catch {
      return false;
    }
  }

  const validSet = new Set<string>();
  await Promise.all(unique.map(async (raw) => {
    // Strip any `:line[:col]` suffix mistakenly included by the caller —
    // the webview already strips it before queueing, but defensive.
    const bare = raw.replace(/:\d+(:\d+)?$/, '');
    if (path.isAbsolute(bare)) {
      if (await existsAt(bare)) { validSet.add(raw); }
      return;
    }
    // Strip a leading `./` so `path.resolve(root, './foo')` works the
    // same as `path.resolve(root, 'foo')` — semantically identical.
    const rel = bare.replace(/^\.\//, '');
    for (const root of allRoots) {
      if (await existsAt(path.resolve(root, rel))) {
        validSet.add(raw);
        return;
      }
    }
  }));

  const valid: string[] = [];
  const invalid: string[] = [];
  for (const p of paths) {
    if (validSet.has(p)) { valid.push(p); } else { invalid.push(p); }
  }
  return { valid, invalid };
}
