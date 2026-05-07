import * as vscode from 'vscode';
import { execFileSync } from 'child_process';
import * as path from 'path';

export interface Worktree {
  path: string;
  branch: string;
  isCurrent: boolean;
  /** True iff `git status --porcelain` returned any output for the worktree. */
  dirty: boolean;
}

/**
 * Validate a string against git's ref-format rules conservatively.
 * Allowed: ASCII letters, digits, slash, hyphen, underscore, period.
 * Rejected: leading dash (would be parsed as a CLI flag), `..`, `@{`, trailing `.lock`,
 * any control or whitespace, and empty input.
 *
 * This is intentionally stricter than `git check-ref-format` — we'd rather refuse
 * an exotic-but-valid name than miss a path that could be parsed as a flag or shell
 * metacharacter when piped through any future code path.
 */
export function isSafeBranchName(name: string): boolean {
  if (!name || name.length > 250) { return false; }
  if (name.startsWith('-')) { return false; }
  if (name.includes('..')) { return false; }
  if (name.includes('@{')) { return false; }
  if (name.endsWith('.lock')) { return false; }
  return /^[A-Za-z0-9._/\-]+$/.test(name);
}

/**
 * Run `git` with the given argv, never via a shell.
 * Returns stdout on success; throws with a useful message on failure.
 */
function runGit(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Resolve the path where a worktree for the given branch would live, then
 * create it via `git worktree add`. Returns the absolute path on success,
 * undefined when the branch name fails safety checks or path traversal
 * would escape the configured base directory.
 *
 * Reuses the same path-confinement logic as `manageWorktrees` so the
 * Launch-Session wizard can't be tricked into writing outside the
 * configured worktree base directory.
 *
 * If `branch` already exists locally, omits `-b` and just attaches the
 * worktree to the existing branch.
 */
export function createOrAttachWorktree(
  workDir: string,
  branch: string,
): string | undefined {
  if (!isSafeBranchName(branch)) { return undefined; }

  const baseDirSetting = vscode.workspace.getConfiguration('vibeflow')
    .get<string>('worktree.baseDir', '.claude/worktrees');
  const folderName = branch.replace(/\//g, '-');
  const baseDirAbs = path.isAbsolute(baseDirSetting)
    ? path.normalize(baseDirSetting)
    : path.normalize(path.join(workDir, baseDirSetting));
  const wtPath = path.normalize(path.join(baseDirAbs, folderName));

  if (!wtPath.startsWith(baseDirAbs + path.sep) && wtPath !== baseDirAbs) {
    return undefined;
  }

  // If the branch exists locally, `git worktree add <path> <branch>`
  // attaches without creating a new ref. Otherwise we need `-b`.
  let branchExists = false;
  try {
    runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], workDir);
    branchExists = true;
  } catch {
    branchExists = false;
  }

  try {
    if (branchExists) {
      runGit(['worktree', 'add', wtPath, branch], workDir);
    } else {
      runGit(['worktree', 'add', wtPath, '-b', branch], workDir);
    }
    return wtPath;
  } catch {
    return undefined;
  }
}

/**
 * Manage git worktrees via Quick Pick.
 * Mirrors vibeflow-cli's worktree management.
 */
export async function manageWorktrees(): Promise<void> {
  const workDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workDir) {
    vscode.window.showErrorMessage('VibeFlow: No workspace folder open');
    return;
  }

  const worktrees = listWorktrees(workDir);

  const items: (vscode.QuickPickItem & { action: string; wt?: Worktree })[] = [
    { label: '$(add) Create New Worktree', action: 'create' },
    { label: '', kind: vscode.QuickPickItemKind.Separator, action: '' },
    ...worktrees.map(wt => {
      const dirtyTag = wt.dirty ? '$(diff-modified) ' : '';
      const detailParts: string[] = [];
      if (wt.isCurrent) { detailParts.push('Current worktree'); }
      detailParts.push(wt.dirty ? 'Modified' : 'Clean');
      return {
        label: `${wt.isCurrent ? '$(check) ' : ''}${dirtyTag}${wt.branch}`,
        description: wt.path,
        detail: detailParts.join(' · '),
        action: 'select' as const,
        wt,
      };
    }),
  ];

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `${worktrees.length} worktree(s) found`,
    title: 'VibeFlow: Manage Worktrees',
  });

  if (!picked) { return; }

  if (picked.action === 'create') {
    await createWorktree(workDir);
  } else if (picked.action === 'select' && picked.wt) {
    const action = await vscode.window.showQuickPick(
      [
        { label: '$(folder-opened) Open in New Window', value: 'open' },
        { label: '$(trash) Delete Worktree', value: 'delete' },
      ],
      { placeHolder: `${picked.wt.branch} — ${picked.wt.path}` },
    );

    if (action?.value === 'open') {
      vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(picked.wt.path), true);
    } else if (action?.value === 'delete') {
      await deleteWorktree(workDir, picked.wt);
    }
  }
}

async function createWorktree(workDir: string): Promise<void> {
  const branch = await vscode.window.showInputBox({
    prompt: 'Branch name for the new worktree',
    placeHolder: 'feature/my-feature',
    validateInput: v => isSafeBranchName(v.trim())
      ? null
      : 'Branch must match [A-Za-z0-9._/-], not start with "-", and not contain ".." or "@{".',
  });
  if (!branch) { return; }
  const safeBranch = branch.trim();
  if (!isSafeBranchName(safeBranch)) {
    vscode.window.showErrorMessage('VibeFlow: Refusing to create worktree — branch name is unsafe.');
    return;
  }

  const baseDirSetting = vscode.workspace.getConfiguration('vibeflow')
    .get<string>('worktree.baseDir', '.claude/worktrees');

  // Resolve the worktree path explicitly and confine it inside the workspace.
  const folderName = safeBranch.replace(/\//g, '-');
  const baseDirAbs = path.isAbsolute(baseDirSetting)
    ? path.normalize(baseDirSetting)
    : path.normalize(path.join(workDir, baseDirSetting));
  const wtPath = path.join(baseDirAbs, folderName);
  const wtPathNormalized = path.normalize(wtPath);

  // Defense in depth: reject any traversal that escapes the configured base dir.
  if (!wtPathNormalized.startsWith(baseDirAbs + path.sep) && wtPathNormalized !== baseDirAbs) {
    vscode.window.showErrorMessage('VibeFlow: Refusing to create worktree — resolved path escapes the worktree base directory.');
    return;
  }

  try {
    // argv form — branch and path are positional arguments, never expanded by a shell.
    runGit(['worktree', 'add', wtPathNormalized, '-b', safeBranch], workDir);
    vscode.window.showInformationMessage(`VibeFlow: Worktree created at ${wtPathNormalized}`);

    const open = await vscode.window.showInformationMessage(
      'Open worktree in new window?',
      'Open',
      'Later',
    );
    if (open === 'Open') {
      vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wtPathNormalized), true);
    }
  } catch (err) {
    vscode.window.showErrorMessage(`VibeFlow: Failed to create worktree — ${err}`);
  }
}

export async function deleteWorktree(workDir: string, wt: Worktree): Promise<void> {
  if (wt.isCurrent) {
    vscode.window.showWarningMessage('VibeFlow: Cannot delete the current worktree');
    return;
  }

  // The path came from `git worktree list --porcelain`, but we still defend
  // against an attacker-controlled `wt.path` (e.g. branch name shaped like
  // `--exec=...`) by using argv form and rejecting leading dashes.
  if (!wt.path || wt.path.startsWith('-')) {
    vscode.window.showErrorMessage('VibeFlow: Refusing to delete worktree — path is unsafe.');
    return;
  }

  // Recompute dirty at decision time so a stale flag from listWorktrees
  // can't lie about uncommitted work that landed since the menu opened.
  const dirty = hasDirtyChanges(wt.path);
  const promptMessage = dirty
    ? `Worktree "${wt.branch}" has uncommitted changes — delete anyway?\n\nPath: ${wt.path}`
    : `Delete worktree "${wt.branch}" at ${wt.path}?`;
  const actionLabel = dirty ? 'Delete (force)' : 'Delete';

  const confirm = await vscode.window.showWarningMessage(
    promptMessage,
    { modal: true },
    actionLabel,
  );
  if (confirm !== actionLabel) { return; }

  try {
    removeWorktreeAt(workDir, wt.path);
    vscode.window.showInformationMessage(`VibeFlow: Worktree "${wt.branch}" deleted`);
  } catch (err) {
    vscode.window.showErrorMessage(`VibeFlow: Failed to delete worktree — ${err}`);
  }
}

export function listWorktrees(workDir: string): Worktree[] {
  try {
    const output = runGit(['worktree', 'list', '--porcelain'], workDir);

    const worktrees: Worktree[] = [];
    let currentPath = '';
    let currentBranch = '';

    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        currentPath = line.slice(9);
      } else if (line.startsWith('branch ')) {
        currentBranch = line.slice(7).replace('refs/heads/', '');
      } else if (line === '') {
        if (currentPath && currentBranch) {
          worktrees.push({
            path: currentPath,
            branch: currentBranch,
            isCurrent: currentPath === workDir,
            dirty: hasDirtyChanges(currentPath),
          });
        }
        currentPath = '';
        currentBranch = '';
      }
    }

    return worktrees;
  } catch {
    return [];
  }
}

/**
 * Cheap dirty check — `git status --porcelain` returns any output iff the
 * worktree has untracked, modified, or staged changes. Returns false on
 * any error so a transient git failure doesn't paint every worktree dirty.
 */
function hasDirtyChanges(worktreePath: string): boolean {
  try {
    return runGit(['status', '--porcelain'], worktreePath).length > 0;
  } catch {
    return false;
  }
}

/**
 * Remove a worktree by absolute path, run from any checkout of the same
 * repo. Used by the Agent Fleet TreeView's right-click delete and by the
 * cleanup-on-kill hook in `killSession`. Path is passed positionally after
 * `--` so a hostile-looking path can't be parsed as a flag.
 *
 * Throws on git failure — callers surface the error to the user.
 */
export function removeWorktreeAt(workDir: string, worktreePath: string, force = true): void {
  if (!worktreePath) { throw new Error('worktree path required'); }
  if (worktreePath.startsWith('-')) { throw new Error('Refusing to remove worktree — path starts with "-"'); }
  const args = ['worktree', 'remove'];
  if (force) { args.push('--force'); }
  args.push('--', worktreePath);
  runGit(args, workDir);
}
