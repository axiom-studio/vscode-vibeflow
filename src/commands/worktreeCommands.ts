import * as vscode from 'vscode';
import { execSync } from 'child_process';

interface Worktree {
  path: string;
  branch: string;
  isCurrent: boolean;
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
    ...worktrees.map(wt => ({
      label: `${wt.isCurrent ? '$(check) ' : ''}${wt.branch}`,
      description: wt.path,
      detail: wt.isCurrent ? 'Current worktree' : undefined,
      action: 'select' as const,
      wt,
    })),
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
  });
  if (!branch) { return; }

  const baseDir = vscode.workspace.getConfiguration('vibeflow')
    .get<string>('worktree.baseDir', '.claude/worktrees');

  const wtPath = `${workDir}/${baseDir}/${branch.replace(/\//g, '-')}`;

  try {
    execSync(`git worktree add "${wtPath}" -b "${branch}" 2>&1`, {
      cwd: workDir,
      encoding: 'utf-8',
    });
    vscode.window.showInformationMessage(`VibeFlow: Worktree created at ${wtPath}`);

    const open = await vscode.window.showInformationMessage(
      'Open worktree in new window?',
      'Open',
      'Later',
    );
    if (open === 'Open') {
      vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wtPath), true);
    }
  } catch (err) {
    vscode.window.showErrorMessage(`VibeFlow: Failed to create worktree — ${err}`);
  }
}

async function deleteWorktree(workDir: string, wt: Worktree): Promise<void> {
  if (wt.isCurrent) {
    vscode.window.showWarningMessage('VibeFlow: Cannot delete the current worktree');
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Delete worktree "${wt.branch}" at ${wt.path}?`,
    { modal: true },
    'Delete',
  );
  if (confirm !== 'Delete') { return; }

  try {
    execSync(`git worktree remove "${wt.path}" --force 2>&1`, {
      cwd: workDir,
      encoding: 'utf-8',
    });
    vscode.window.showInformationMessage(`VibeFlow: Worktree "${wt.branch}" deleted`);
  } catch (err) {
    vscode.window.showErrorMessage(`VibeFlow: Failed to delete worktree — ${err}`);
  }
}

function listWorktrees(workDir: string): Worktree[] {
  try {
    const output = execSync('git worktree list --porcelain', {
      cwd: workDir,
      encoding: 'utf-8',
    });

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
