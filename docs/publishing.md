# Publishing to the Open VSX Registry

How to publish **VibeFlow for VS Code** to [Open VSX](https://open-vsx.org) — the
vendor-neutral registry used by VS Codium, Cursor, Gitpod, Theia, and other
non-Microsoft editors.

Publishing is encoded as `make` targets (see [Makefile](../Makefile)). The
sections below cover the one-time account setup and the repeatable publish flow.

| Field | Value |
|-------|-------|
| Publisher / namespace | `AxiomStudio` |
| Extension id | `AxiomStudio.vscode-vibeflow` |
| Registry | https://open-vsx.org |
| Listing (once published) | https://open-vsx.org/extension/AxiomStudio/vscode-vibeflow |

---

## One-time account setup

Do this once per publishing account. None of it is repeated for later releases.

1. **Eclipse account + agreements.** Register at
   [Eclipse Accounts](https://accounts.eclipse.org/), sign the **Eclipse
   Contributor Agreement (ECA)**, and in your
   [Eclipse profile](https://accounts.eclipse.org/user/edit) link your **GitHub**
   account and sign the **Open VSX Publisher Agreement**.
2. **Log into Open VSX** at https://open-vsx.org with that GitHub account.
3. **Generate an access token** at
   https://open-vsx.org/user-settings/tokens. Copy it — it is shown only once.
4. **Create the namespace** `AxiomStudio` (must exactly match the `publisher`
   field in `package.json`). Either run `make openvsx-namespace`, or do it on the
   web at https://open-vsx.org/user-settings/namespaces.

### Namespace verification is optional

Creating the namespace lets you publish immediately. Open VSX's docs are
explicit that verifying namespace *ownership* (the "Claim namespace ownership"
GitHub issue) is **optional** — it only adds a *verified owner* badge to the
listing and does not gate publishing.

The standard claim requires the requesting GitHub account to have **12+ months of
public history**. If your account does not, you can still publish to the
unverified namespace. To earn the badge later without that history, the cleanest
path is **domain verification**: if you own a domain matching the namespace
(e.g. `axiomstudio.com`), prove it via a DNS `TXT` record or an email from a
matching address — this route ignores GitHub account age.

---

## Publishing a release

### Prerequisites each time

- The access token, exported so the CLI never sees it on the command line:

  ```bash
  export OVSX_PAT=<token from https://open-vsx.org/user-settings/tokens>
  ```

- The `version` in `package.json` must be **higher than the last published
  version** — Open VSX rejects re-publishing an existing version. Bump it first
  (e.g. `yarn version --no-git-tag-version --patch`).

### The commands

First release (creates the namespace, then publishes):

```bash
make publish
```

Every release after the namespace exists:

```bash
make openvsx-publish
```

`make openvsx-publish` packages a fresh `.vsix` at the current `package.json`
version and uploads it. The extension goes live within a few seconds.

### Doing it by hand

The targets wrap these commands — useful if you need to run a step in isolation:

```bash
npx ovsx create-namespace AxiomStudio        # one-time; reads $OVSX_PAT
npx vsce package                              # builds via vscode:prepublish, emits the .vsix
npx ovsx publish vscode-vibeflow-<version>.vsix   # reads $OVSX_PAT
```

`vsce` and `ovsx` are run via `npx`, so no global install is required.

---

## Make targets

| Target | What it does |
|--------|--------------|
| `make package` | Build and produce `vscode-vibeflow-<version>.vsix` |
| `make openvsx-namespace` | Create the `AxiomStudio` namespace (one-time, tolerant if it exists) |
| `make openvsx-publish` | Package and publish the current version to Open VSX |
| `make publish` | Full first-time flow: namespace + package + publish |
| `make clean` | Remove built `.vsix` files |

All Open VSX targets require `OVSX_PAT` to be set and fail fast with a clear
message if it is missing.

---

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `ERROR: OVSX_PAT not set` | `export OVSX_PAT=<token>` before running a publish target. |
| `namespace '...' may already exist — continuing` | Expected on re-runs; the namespace is created once. Not an error. |
| `Extension version X.Y.Z is already published` | Bump `version` in `package.json`; you cannot overwrite a published version. |
| `vsce` complains about a missing `repository`, `LICENSE`, or icon | Fix the flagged `package.json` field or add the file, then re-run. |
| Publish succeeds but the listing shows *unverified* | Expected — see [Namespace verification is optional](#namespace-verification-is-optional). |

## References

- Open VSX — [Publishing Extensions](https://github.com/EclipseFdn/open-vsx.org/wiki/Publishing-Extensions)
- Open VSX — [Managing Namespaces](https://github.com/EclipseFdn/open-vsx.org/wiki/Managing-Namespaces)
- [`ovsx` CLI](https://github.com/eclipse/openvsx/blob/master/cli/README.md)
- [`vsce` CLI](https://github.com/microsoft/vscode-vsce)
