# Git Configuration

Cloud Runners clone and push your repositories from the cloud, so they need git credentials of their own — separate from whatever credentials Cursor or your local git setup uses. The **Git Configuration** tab in VibeFlow Settings is where you add and manage those credentials, called *git providers*.

> **Same extension, different host.** This page mirrors the [VS Code edition](../../vscode-vibeflow/docs/git-configuration.md); everything works identically inside Cursor.

> **Availability.** Git Configuration and Cloud Runners are enabled per organization. If you don't see the Git Configuration tab or the Browse entries described here, the capability isn't enabled for your org yet — ask your VibeFlow administrator.

## Where credentials live

Tokens and SSH keys are stored **on the VibeFlow server**, never on your machine and never in Cursor's settings. After you save a provider, the credential is write-only: no screen in the extension ever displays it again. Lists and detail views show only the provider's name, git host, and authentication type.

## Adding a provider

Open **VibeFlow Settings → Git Configuration** (run `VibeFlow: Setup` first if you're not signed in). The **Add a provider** form takes:

| Field | Notes |
|-------|-------|
| **Name** | A label to identify this provider later, e.g. `my-github`. |
| **Git host** | Defaults to `https://github.com` when left blank. Must be an `https://` URL. |
| **Authentication** | `Personal Access Token` or `SSH Key`. |
| **Access token** *(PAT)* | Entered in a masked field, cleared the moment you submit. Needs repository read/write scope. |
| **Username** *(PAT, optional)* | Your git username, if your host requires it. |
| **SSH private key** *(SSH)* | Paste the private key in PEM format. |

Click **Add provider**. The result shows inline — a green confirmation on success, or the server's error message in red (the form keeps your name/host/username on failure so you only re-enter the secret). The list above the form updates immediately.

## Managing providers

Each provider row in the Git Configuration tab offers:

- **Rename** — edit the label inline.
- **Delete** — removes the provider *and its stored credentials* from the server, behind a confirmation dialog.

You can also browse and delete providers from the **Git Providers** page: open the **Browse** view in the VibeFlow sidebar and click **Git Providers** (it appears right below Cloud Runners). The page lists every provider — name, git host, authentication badge — with a per-row **Delete**. No credential is ever shown; the page has no input fields at all.

## Using a provider

When you [create a Cloud Runner](cloud-runners.md#creating-a-runner), you can pick one of your git providers so the runner can clone your repositories and push the agents' commits. In the runner's **Manage** wizard you can also inject a provider's credentials on demand before cloning a repository onto a running pod.

## Diagnostics

If a provider list looks wrong or an add keeps failing, turn on the trace log:

1. In **VibeFlow Settings → Git Configuration**, tick the **Diagnostics** checkbox ("Log Cloud Runners API calls…").
2. Open **View → Output** and pick **VibeFlow Cloud Runners** in the dropdown.
3. Reproduce the action. Each API call logs its method, path, status, and response *shape*.

Use the output panel's gear to raise the log level to **Trace** for full request/response detail. Credential values are always masked in the log — the trace shows structure and non-secret fields only.

## Good to know

- A provider is account-level: it belongs to you, not to a single project, and works across all your projects.
- Deleting a provider does not stop runners that already cloned with it — but relaunching a session on a pod requires re-injecting valid credentials.
- The extension only ever talks to your VibeFlow server over HTTPS; it refuses to send credentials over an insecure connection.
