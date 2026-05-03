import * as vscode from 'vscode';

export interface PendingPrompt {
  /** Stable string id from the backend (e.g. "agent-abc123de"). */
  id: string;
  text: string;
  personaName: string;
  createdAt: string;
  workItemType?: string;
  workItemId?: number;
}

/**
 * Manages agent prompt notifications.
 *
 * Owns the in-memory list of pending prompts so callers (status bar, chat
 * participant, command palette) don't need to thread the list through. The
 * poller calls `handlePrompts(prompts)` each cycle with the latest snapshot
 * from the backend; this class diffs it against `seenPromptIds` to decide
 * which prompts deserve a fresh toast, and against the previous `pending`
 * list to clear out prompts the backend has dropped (e.g. responded
 * elsewhere).
 *
 * Sending a response is delegated to the host via `setRespondHandler` —
 * keeps PromptNotifier free of any HTTP/MCP knowledge.
 */
export class PromptNotifier implements vscode.Disposable {
  private readonly _onDidChangeCount = new vscode.EventEmitter<number>();
  readonly onDidChangeCount = this._onDidChangeCount.event;

  /** Snapshot of currently-pending prompts; refreshed by `handlePrompts`. */
  private pending: PendingPrompt[] = [];
  /** Prompt ids we've already shown a toast for (avoids duplicate notifications). */
  private seenPromptIds = new Set<string>();
  private respondFn: ((promptId: string, response: string) => Promise<void>) | undefined;

  /**
   * Set the function that sends the response back to the API. Wired in
   * `connectToProject` once a `VibeFlowClient` is available.
   */
  setRespondHandler(fn: (promptId: string, response: string) => Promise<void>): void {
    this.respondFn = fn;
  }

  /**
   * Refresh the pending list from a fresh backend snapshot. Shows a toast
   * for any prompt id we haven't seen before. Drops `seenPromptIds` entries
   * for prompts the backend no longer reports — keeps the set bounded over
   * long sessions and lets a re-issued prompt re-toast.
   */
  handlePrompts(prompts: PendingPrompt[]): void {
    const config = vscode.workspace.getConfiguration('vibeflow');
    const notificationsEnabled = config.get<boolean>('notifications.agentPrompts', true);

    const previousCount = this.pending.length;
    this.pending = prompts;

    const currentIds = new Set(prompts.map(p => p.id));
    for (const seen of this.seenPromptIds) {
      if (!currentIds.has(seen)) { this.seenPromptIds.delete(seen); }
    }

    for (const prompt of prompts) {
      if (this.seenPromptIds.has(prompt.id)) { continue; }
      this.seenPromptIds.add(prompt.id);
      if (notificationsEnabled) {
        this.showPromptNotification(prompt);
      }
    }

    if (this.pending.length !== previousCount) {
      this._onDidChangeCount.fire(this.pending.length);
    }
  }

  /**
   * Mark a prompt as resolved locally (e.g. user dismissed). Removes from
   * `pending` so subsequent quick-picks don't list it. The backend snapshot
   * will eventually catch up; until then, optimistic local removal keeps
   * the UI honest.
   */
  markResolved(promptId: string): void {
    const before = this.pending.length;
    this.pending = this.pending.filter(p => p.id !== promptId);
    if (this.pending.length !== before) {
      this._onDidChangeCount.fire(this.pending.length);
    }
  }

  getPendingCount(): number {
    return this.pending.length;
  }

  /** Look up a pending prompt by its backend id (used by webview round-trip). */
  findById(promptId: string): PendingPrompt | undefined {
    return this.pending.find(p => p.id === promptId);
  }

  /**
   * Read-only snapshot of currently-pending prompts. Returned array is
   * a copy so callers can iterate or filter without observing later
   * mutations from handlePrompts.
   */
  getPending(): readonly PendingPrompt[] {
    return [...this.pending];
  }

  /**
   * Send a response without prompting via input box. Used by callers
   * that already have the response text in hand (chat participant,
   * future webview-form flows). Throws if not yet connected — callers
   * decide how to surface the failure.
   */
  async respondTo(promptId: string, response: string): Promise<void> {
    if (!this.respondFn) {
      throw new Error('VibeFlow: not connected — cannot send response');
    }
    await this.respondFn(promptId, response);
    this.markResolved(promptId);
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
   * Collect response via Input Box and send it. Surfaces an error toast if
   * no respond handler is wired (defensive — the only way this happens is
   * a misconfigured activation).
   */
  async collectAndSendResponse(prompt: PendingPrompt): Promise<void> {
    const response = await vscode.window.showInputBox({
      prompt: `Reply to ${prompt.personaName}: "${prompt.text}"`,
      placeHolder: 'Type your response...',
      ignoreFocusOut: true,
    });

    if (response === undefined) { return; } // Cancelled

    if (!this.respondFn) {
      vscode.window.showErrorMessage('VibeFlow: not connected — cannot send response');
      return;
    }

    try {
      await this.respondFn(prompt.id, response);
      this.markResolved(prompt.id);
      vscode.window.showInformationMessage(`Response sent to ${prompt.personaName}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to send response: ${msg}`);
    }
  }

  /**
   * Show Quick Pick of all currently-pending prompts. Used by status bar,
   * chat participant, and command palette — they all funnel through here
   * rather than maintaining their own copy of the list.
   */
  async showPendingPromptsQuickPick(): Promise<void> {
    if (this.pending.length === 0) {
      vscode.window.showInformationMessage('VibeFlow: No pending prompts');
      return;
    }

    const selected = await vscode.window.showQuickPick(
      this.pending.map(p => ({
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
