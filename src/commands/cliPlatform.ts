import * as vscode from 'vscode';

/**
 * Whether the VibeFlow CLI cannot run where this extension host runs (#4035).
 * vibeflow-cli runs every agent in tmux, which native Windows does not have
 * (vibeflow-cli `pidlock_windows.go`: "vibeflow-cli requires tmux which is
 * not available on Windows"). Under a remote such as WSL the CLI runs on the
 * Linux side, so only a local Windows window is unsupported.
 */
export function cliNeedsWsl(platform: NodeJS.Platform, remoteName: string | undefined): boolean {
  return platform === 'win32' && !remoteName;
}

export const WSL_SETUP_URL = 'https://learn.microsoft.com/windows/wsl/install';
const REOPEN_IN_WSL_COMMAND = 'remote-wsl.reopenInWSL';

/** Explain why the CLI cannot start here and offer the way forward. */
export async function showCliNeedsWsl(): Promise<void> {
  const reopen = 'Reopen Folder in WSL';
  const guide = 'How to Set Up WSL';
  const canReopen = (await vscode.commands.getCommands(true)).includes(REOPEN_IN_WSL_COMMAND);
  const choice = await vscode.window.showWarningMessage(
    'VibeFlow CLI needs WSL on Windows.',
    {
      modal: true,
      detail: 'The VibeFlow CLI runs agents in tmux, which Windows does not provide. '
        + 'Install WSL and the WSL extension, reopen this folder in WSL, then install the CLI there.',
    },
    ...(canReopen ? [reopen] : []),
    guide,
  );
  if (choice === reopen) {
    await vscode.commands.executeCommand(REOPEN_IN_WSL_COMMAND);
  } else if (choice === guide) {
    await vscode.env.openExternal(vscode.Uri.parse(WSL_SETUP_URL));
  }
}
