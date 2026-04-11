import * as vscode from 'vscode';

export interface PendingPrompt {
  id: string;
  text: string;
  personaName: string;
  createdAt: string;
  workItemType?: string;
  workItemId?: number;
}

/**
 * Manages agent prompt notifications.
 * Shows VSCode toast notifications for pending prompts,
 * collects user responses via Quick Pick, and tracks pending count
 * for status bar badge.
 */
export class PromptNotifier implements vscode.Disposable {
  private readonly _onDidChangeCount = new vscode.EventEmitter<number>();
  readonly onDidChangeCount = this._onDidChangeCount.event;

  private seenPromptIds = new Set<string>();
  private pendingCount = 0;
  private respondFn: ((promptId: string, response: string) => Promise<void>) | undefined;

  /**
   * Set the function that sends the response back to the API.
   */
  setRespondHandler(fn: (promptId: string, response: string) => Promise<void>): void {
    this.respondFn = fn;
  }

  /**
   * Process prompts from a poll cycle.
   * Shows notifications for new prompts not seen before.
   */
  handlePrompts(prompts: PendingPrompt[]): void {
    const config = vscode.workspace.getConfiguration('vibeflow');
    const notificationsEnabled = config.get<boolean>('notifications.agentPrompts', true);

    let countChanged = false;

    for (const prompt of prompts) {
      if (this.seenPromptIds.has(prompt.id)) {
        continue;
      }
      this.seenPromptIds.add(prompt.id);
      this.pendingCount++;
      countChanged = true;

      if (notificationsEnabled) {
        this.showPromptNotification(prompt);
      }
    }

    if (countChanged) {
      this._onDidChangeCount.fire(this.pendingCount);
    }
  }

  /**
   * Mark a prompt as resolved (responded or dismissed).
   */
  markResolved(promptId: string): void {
    if (this.seenPromptIds.has(promptId)) {
      this.pendingCount = Math.max(0, this.pendingCount - 1);
      this._onDidChangeCount.fire(this.pendingCount);
    }
  }

  getPendingCount(): number {
    return this.pendingCount;
  }

  private async showPromptNotification(prompt: PendingPrompt): Promise<void> {
    const truncated = prompt.text.length > 100
      ? prompt.text.slice(0, 97) + '...'
      : prompt.text;

    const result = await vscode.window.showInformationMessage(
      `${prompt.personaName} asks: ${truncated}`,
      { modal: false },
      'Respond',
      'Dismiss',
    );

    if (result === 'Respond') {
      await this.collectAndSendResponse(prompt);
    } else {
      this.markResolved(prompt.id);
    }
  }

  /**
   * Collect response via Input Box and send it.
   * Also used by the vibeflow.respondToPrompt command.
   */
  async collectAndSendResponse(prompt: PendingPrompt): Promise<void> {
    const response = await vscode.window.showInputBox({
      prompt: `Reply to ${prompt.personaName}: "${prompt.text}"`,
      placeHolder: 'Type your response...',
      ignoreFocusOut: true,
    });

    if (response === undefined) {
      return; // Cancelled
    }

    if (this.respondFn) {
      try {
        await this.respondFn(prompt.id, response);
        this.markResolved(prompt.id);
        vscode.window.showInformationMessage(`Response sent to ${prompt.personaName}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to send response: ${err}`);
      }
    }
  }

  /**
   * Show Quick Pick of all pending prompts for manual response.
   */
  async showPendingPromptsQuickPick(prompts: PendingPrompt[]): Promise<void> {
    if (prompts.length === 0) {
      vscode.window.showInformationMessage('VibeFlow: No pending prompts');
      return;
    }

    const selected = await vscode.window.showQuickPick(
      prompts.map(p => ({
        label: `$(comment-discussion) ${p.personaName}`,
        description: p.text.slice(0, 80),
        prompt: p,
      })),
      { placeHolder: 'Select a prompt to respond to' },
    );

    if (selected) {
      await this.collectAndSendResponse(selected.prompt);
    }
  }

  dispose(): void {
    this._onDidChangeCount.dispose();
  }
}
