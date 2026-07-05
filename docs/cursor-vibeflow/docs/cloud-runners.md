# Cloud Runners

Cloud Runners are cloud-hosted agent machines. Instead of running a VibeFlow session in a terminal on your laptop, a runner provisions a dedicated pod in your organization's VibeFlow Cloud, clones your repositories there, and runs the agent (Claude, Codex, or Cursor) around the clock — surviving laptop sleep, network drops, and IDE restarts. The extension is the cockpit: you create, monitor, manage, and retire runners without leaving Cursor.

> **Same extension, different host.** This page mirrors the [VS Code edition](../../vscode-vibeflow/docs/cloud-runners.md); everything works identically inside Cursor.

> **Name collision, again.** "Cursor" appears twice in this story: the IDE you're reading this in, and the **Cursor agent** — one of the three agent types a runner can host. Picking the Cursor *agent* for a runner is unrelated to running the extension *inside* Cursor; any agent type works from any IDE.

> **Availability.** Cloud Runners are enabled per organization. If you don't see **Cloud Runners** in the Browse view or the **Cloud Runner** option when creating a work item, the capability isn't enabled for your org yet — ask your VibeFlow administrator.

Before creating your first runner, add a git credential in [Git Configuration](git-configuration.md) so the runner can clone and push your repositories.

## The Cloud Runners page

Open the **Browse** view in the VibeFlow sidebar and click **Cloud Runners**. The page lists every runner you can see across your projects:

| Column | Meaning |
|--------|---------|
| **Name** | The runner's name. |
| **Status** | Lifecycle status with a color dot: `pending` → `starting` → `active`, `stopping` → `stopped`, or `failed`. |
| **Pod Status** | The health of the underlying cloud pod, as last observed. |
| **Project** | Which VibeFlow project the runner belongs to. |
| **Created** | When it was provisioned. |

Use **Refresh** to reload; the page also refreshes itself when you switch back to its tab.

### Row actions

- **Manage** — opens the [Manage wizard](#the-manage-wizard). Only available while the runner has a live pod (not while stopped, stopping, or starting).
- **Start / Stop** — one button, chosen by status. A stopped runner shows **Start**; a running one shows **Stop**. While the change settles (typically 15–30 seconds) the row shows *Starting…* or *Stopping…* and its actions are disabled.
- **Delete** — permanently removes the runner and its pod, behind a confirmation dialog. Deleting is irreversible.

Start, Stop, and Delete are owner-only actions (the runner's creator or an org admin). If you're neither, the server declines with a clear permission message.

## Creating a runner

Open the **Work Items** view, click the **+** button, and choose **Cloud Runner**. The guided flow asks for:

1. **Name** — if the name is already taken, you'll be prompted with a fresh suggestion. Note that recently *deleted* names can remain reserved on the server for a while, so when in doubt pick a distinctly new name.
2. **Agent** — **Claude**, **Codex**, or **Cursor**.
3. **Authentication** — *API key* (enter the provider key now, in a masked prompt; it is sent straight to the server and never stored locally) or *OAuth* (sign in on the runner later, from the Manage wizard).
4. **Git provider** *(optional)* — pick one of your [git providers](git-configuration.md) and list repository URLs to clone onto the pod.

The extension then provisions the runner and follows its progress until the pod is active. You can watch it appear on the Cloud Runners page immediately.

## The Manage wizard

**Manage** authenticates, configures, and launches a VibeFlow session on the runner's pod. It walks up to three steps:

### 1. Authenticate *(OAuth runners only)*

Once the pod is up, click **Start authentication** to get a sign-in URL and a device code.

- **Claude** — open the URL, sign in, then paste the verification code back into the wizard.
- **Codex / Cursor** — sign in at the URL and wait; these providers confirm automatically, no paste-back needed.

The wizard advances to Configure as soon as the runner reports it's authenticated.

### 2. Configure

Choose what the session will work on:

- **Working directory** — one of the repositories cloned on the pod. If the pod has none yet, select a git provider and clone one right here.
- **Project** — the VibeFlow project the session reports to.
- **Personas** — one or more of the nine VibeFlow personas to run.
- **Session type, branch, worktree options, permission mode, gateway routing** — the same session defaults you know from local launches.

**Launch** enables once a working directory, a project, and at least one persona are set.

### 3. Launch

The wizard writes the session configuration to the pod and waits for the session to come up, reporting *running* on success. From here you can go back and reconfigure (which relaunches), or open the terminal.

### The pod terminal

**Open terminal** (available throughout the wizard) attaches a native terminal tab directly to the runner's pod — the same session the agent runs in. Type, scroll, and resize as usual; close the terminal tab to disconnect. Terminal access follows the same owner-only rule as Start/Stop/Delete.

## Troubleshooting

| Symptom | What's happening |
|---------|-----------------|
| "A cloud runner named X already exists" right after deleting X | Deleted names can stay reserved server-side for a while. Accept the suggested fresh name or pick a different one. |
| "Runner is still starting. Try again in a moment." | The pod isn't fully up yet. Wait a few seconds and retry. |
| Manage is not offered for a runner | The runner is stopped, stopping, or starting — a manageable pod isn't available. Start it first. |
| "You don't have permission to manage this runner" | Start/Stop/Delete/terminal are limited to the runner's owner and org admins. |
| Need to see what the extension is sending | Turn on the Diagnostics toggle in [Git Configuration](git-configuration.md#diagnostics) and watch the **VibeFlow Cloud Runners** output channel. |
