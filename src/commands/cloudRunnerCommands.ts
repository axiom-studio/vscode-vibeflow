import * as vscode from 'vscode';
import type { VibeFlowClient } from '../api/client.js';
import type { CreateRunnerRequest } from '../api/types.js';
import { validateCreateRunner, parseRepoUrls, runnerPollState } from '../api/cloudRunners.js';
import { CloudRunnersPanel } from '../views/cloudRunners/CloudRunnersPanel.js';

const AGENT_TYPES = [
  { label: '$(sparkle) Claude', value: 'claude' as const },
  { label: '$(sparkle) Codex', value: 'codex' as const },
];

const AUTH_MODES = [
  { label: 'API key', description: 'Provide a provider API key now', value: 'api_key' as const },
  { label: 'OAuth', description: 'Sign in on the runner after it starts', value: 'oauth' as const },
];

const POLL_INTERVAL_MS = 3000;
const POLL_DEADLINE_MS = 120_000;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Multi-step flow for provisioning a Cloud Runner (feature #603), invoked from
 * the Work Items "+" action when the org has the capability. Collects the
 * runner config, POSTs it, then polls to `active` inside a progress
 * notification. The API key is entered via a masked input and never logged or
 * stored locally; only local ids are sent to the server.
 */
export async function createCloudRunner(
  client: VibeFlowClient,
  projectId: number,
): Promise<void> {
  const name = await vscode.window.showInputBox({
    prompt: 'Cloud runner name',
    placeHolder: 'vscode-dev',
    ignoreFocusOut: true,
  });
  if (!name?.trim()) { return; }

  const agentType = await vscode.window.showQuickPick(AGENT_TYPES, {
    placeHolder: 'Agent type',
    title: 'Create Cloud Runner',
  });
  if (!agentType) { return; }

  const authMode = await vscode.window.showQuickPick(AUTH_MODES, {
    placeHolder: 'Authentication',
    title: 'Create Cloud Runner',
  });
  if (!authMode) { return; }

  const body: CreateRunnerRequest = {
    name: name.trim(),
    agentType: agentType.value,
    authMode: authMode.value,
    cloudAgentType: 'vibeflow',
  };

  if (authMode.value === 'api_key') {
    const apiKey = await vscode.window.showInputBox({
      prompt: `Provider API key for ${agentType.value}`,
      password: true,
      ignoreFocusOut: true,
    });
    if (!apiKey) { return; } // cancelled or empty — abort
    body.apiKey = apiKey;
  }

  // Optional git provider + repos. A runner may only request repos when it has
  // a provider (validated below and server-side).
  const providers = await client.listGitProviders().catch(() => []);
  if (providers.length > 0) {
    const none = { label: '$(circle-slash) No git provider', providerId: undefined as number | undefined };
    const pick = await vscode.window.showQuickPick(
      [
        none,
        ...providers.map(p => ({
          label: `$(key) ${p.name}`,
          description: `${p.gitUrl} · ${p.authMode}`,
          providerId: p.id as number | undefined,
        })),
      ],
      { placeHolder: 'Git provider for cloning repos (optional)', title: 'Create Cloud Runner' },
    );
    if (pick === undefined) { return; }
    if (pick.providerId !== undefined) {
      body.gitProviderId = pick.providerId;
      const reposInput = await vscode.window.showInputBox({
        prompt: 'Repos to clone (comma-separated URLs, optional)',
        placeHolder: 'https://github.com/acme/app, https://github.com/acme/lib',
        ignoreFocusOut: true,
      });
      if (reposInput === undefined) { return; }
      const repos = parseRepoUrls(reposInput);
      if (repos.length > 0) { body.gitRepos = repos; }
    }
  }

  const validationError = validateCreateRunner(body);
  if (validationError) {
    vscode.window.showErrorMessage(`VibeFlow: ${validationError}`);
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Creating cloud runner "${body.name}"…`, cancellable: true },
    async (progress, token) => {
      let runnerId: number;
      try {
        const created = await client.createCloudRunner(projectId, body);
        runnerId = created.id;
      } catch (err) {
        vscode.window.showErrorMessage(`VibeFlow: could not create cloud runner — ${errText(err)}`);
        return;
      }
      CloudRunnersPanel.refresh();
      progress.report({ message: 'provisioning…' });

      const deadline = Date.now() + POLL_DEADLINE_MS;
      while (Date.now() < deadline) {
        if (token.isCancellationRequested) { return; }
        await delay(POLL_INTERVAL_MS);
        let status: string;
        try {
          const runner = await client.getCloudRunner(projectId, runnerId);
          status = runner.status;
        } catch {
          continue; // transient (e.g. 409 not-provisioned-yet) — keep polling
        }
        progress.report({ message: status });
        const state = runnerPollState(status);
        if (state === 'active') {
          CloudRunnersPanel.refresh();
          vscode.window.showInformationMessage(`VibeFlow: cloud runner "${body.name}" is active.`);
          return;
        }
        if (state === 'failed') {
          vscode.window.showErrorMessage(`VibeFlow: cloud runner "${body.name}" failed to provision.`);
          return;
        }
      }
      vscode.window.showWarningMessage(
        `VibeFlow: cloud runner "${body.name}" is still provisioning — check the Cloud Runners panel.`,
      );
    },
  );
}
