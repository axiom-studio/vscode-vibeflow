import * as vscode from 'vscode';
import type { VibeFlowClient } from '../api/client.js';
import type { CreateRunnerRequest } from '../api/types.js';
import { validateCreateRunner, validateRunnerName, RUNNER_NAME_RULES, LOGIN_METHODS, parseRepoUrls, gitRepoUrlAuthError, runnerPollState, createRunnerErrorMessage, suggestRunnerName } from '../api/cloudRunners.js';
import { CloudRunnersPanel } from '../views/cloudRunners/CloudRunnersPanel.js';

const AGENT_TYPES = [
  { label: '$(sparkle) Claude', value: 'claude' as const },
  { label: '$(sparkle) Codex', value: 'codex' as const },
  { label: '$(sparkle) Cursor', value: 'cursor' as const },
];

const AUTH_MODES = [
  { label: 'API key', description: 'Provide a provider API key now', value: 'api_key' as const },
  { label: 'OAuth', description: 'Sign in on the runner after it starts', value: 'oauth' as const },
];

const POLL_INTERVAL_MS = 3000;
const POLL_DEADLINE_MS = 120_000;
// Stop the name-conflict retry after this many 409s so a server that reserves
// many deleted names (the #3394 tombstone) can't trap the user in a loop.
const MAX_NAME_CONFLICTS = 5;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Short random token for a fresh runner-name suggestion (display only). */
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
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
    prompt: `Cloud runner name — ${RUNNER_NAME_RULES}`,
    placeHolder: 'vscode-dev',
    ignoreFocusOut: true,
    // Live inline validation (#2827): the pod's network name derives from
    // this, so enforce the naming rules before anything is sent.
    validateInput: value => validateRunnerName(value),
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
  } else {
    // OAuth: pick the per-agent login method (spec #433 §7.3). Codex and Cursor
    // have exactly one method, so it is applied without an extra prompt; Claude
    // offers subscription vs Console vs third-party billing.
    const methods = LOGIN_METHODS[agentType.value];
    let loginMethod = methods[0].value;
    if (methods.length > 1) {
      const pick = await vscode.window.showQuickPick(
        methods.map(m => ({ label: m.label, value: m.value })),
        { placeHolder: 'How will this agent sign in?', title: 'Create Cloud Runner' },
      );
      if (!pick) { return; }
      loginMethod = pick.value;
    }
    body.loginMethod = loginMethod;
  }

  // Optional git provider + repos. A runner may only request repos when it has
  // a provider (validated below and server-side).
  const providers = await client.listGitProviders().catch(() => []);
  if (providers.length > 0) {
    const none = { label: '$(circle-slash) No git provider', providerId: undefined as number | undefined, authMode: undefined as string | undefined };
    const pick = await vscode.window.showQuickPick(
      [
        none,
        ...providers.map(p => ({
          label: `$(key) ${p.name}`,
          description: `${p.gitUrl} · ${p.authMode}`,
          providerId: p.id as number | undefined,
          authMode: p.authMode as string | undefined,
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
      if (parseRepoUrls(reposInput).length > 0) {
        // Explicit branch (#2883): the pod clones `--branch <branch|main>`
        // and swallows failures, so a repo whose default branch is not main
        // would silently end up missing from /workspace/repos.
        const branch = await vscode.window.showInputBox({
          prompt: 'Git branch to clone (applies to the listed repos)',
          value: 'main',
          ignoreFocusOut: true,
        });
        if (branch === undefined) { return; }
        body.gitRepos = parseRepoUrls(reposInput, branch.trim() || 'main');
        // Scheme-vs-provider check (#2888): the server rejects mismatches one
        // step later with a raw error — catch it here with the web's message.
        for (const repo of body.gitRepos) {
          const schemeErr = gitRepoUrlAuthError(repo.url, pick.authMode);
          if (schemeErr) {
            vscode.window.showErrorMessage(`VibeFlow: ${schemeErr}`);
            return;
          }
        }
      }
    }
  }

  const validationError = validateCreateRunner(body);
  if (validationError) {
    vscode.window.showErrorMessage(`VibeFlow: ${validationError}`);
    return;
  }

  // Create OUTSIDE the progress notification so a 409 name-retry prompt
  // doesn't fight it (#3388). 403/502/503 map to specific messages.
  const baseName = body.name; // suggest fresh suffixes off the ORIGINAL name
  let runnerId: number;
  let conflicts = 0;
  for (;;) {
    try {
      const created = await client.createCloudRunner(projectId, body);
      runnerId = created.id;
      break;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 409) {
        conflicts += 1;
        if (conflicts > MAX_NAME_CONFLICTS) {
          vscode.window.showErrorMessage(
            'VibeFlow: the server rejected several names as already in use. Deleted runner names can stay reserved server-side — try a distinctly different name, or check the Cloud Runners panel.',
          );
          return;
        }
        // A RANDOM suffix off the original name (not a -N walk through
        // reserved deleted names) so the suggestion is very likely fresh (#3395).
        const newName = await vscode.window.showInputBox({
          prompt: `A cloud runner named "${body.name}" already exists on the server — a recently-deleted name can stay reserved. Choose a different name.`,
          value: suggestRunnerName(baseName, randomSuffix()),
          ignoreFocusOut: true,
        });
        if (!newName?.trim()) { return; }
        body.name = newName.trim();
        continue;
      }
      vscode.window.showErrorMessage(`VibeFlow: ${createRunnerErrorMessage(status, errText(err))}`);
      return;
    }
  }
  CloudRunnersPanel.refresh();

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Provisioning cloud runner "${body.name}"…`, cancellable: true },
    async (progress, token) => {
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
