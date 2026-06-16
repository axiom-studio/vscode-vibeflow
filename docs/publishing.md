# Publishing VibeFlow

How to publish **VibeFlow** to the two extension registries:

- **[Open VSX](https://open-vsx.org)** — the vendor-neutral registry used by
  Cursor, VS Codium, Gitpod, Theia, and other non-Microsoft editors.
- **[VS Code Marketplace](https://marketplace.visualstudio.com/)** — Microsoft's
  registry, used by VS Code proper.

The same `.vsix` artifact is published to both. Publishing is encoded as `make`
targets (see [Makefile](../Makefile)). The sections below cover the one-time
setup for each registry and the repeatable publish flow.

| Field | Value |
|-------|-------|
| Publisher (both registries) | `AxiomStudio` |
| Extension id | `AxiomStudio.vscode-vibeflow` |
| Open VSX listing | https://open-vsx.org/extension/AxiomStudio/vscode-vibeflow |
| VS Code Marketplace listing | https://marketplace.visualstudio.com/items?itemName=AxiomStudio.vscode-vibeflow |

> The `publisher` field in `package.json` is `AxiomStudio`. The Open VSX
> **namespace** and the VS Code Marketplace **publisher** must both be named
> exactly `AxiomStudio` for publishing to succeed.

---

## Open VSX: one-time setup

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

## VS Code Marketplace: one-time setup

Microsoft's Marketplace authenticates through Azure DevOps. Do this once.

1. **Create an Azure DevOps organization.** Sign in at
   [dev.azure.com](https://dev.azure.com/) (any Microsoft account) and create an
   organization if you don't have one.
2. **Generate a Personal Access Token (PAT).** In Azure DevOps → *User Settings →
   Personal Access Tokens → New Token*:
   - **Organization**: *All accessible organizations* (required — Marketplace is
     cross-org).
   - **Scopes**: *Marketplace → **Manage*** (custom-defined scopes).
   - Copy the token — it is shown only once.
3. **Create the `AxiomStudio` publisher.** Go to the
   [Marketplace publisher management page](https://marketplace.visualstudio.com/manage),
   sign in with the same Microsoft account, and create a publisher whose **ID is
   exactly `AxiomStudio`** (it must match the `publisher` field in
   `package.json`). Accept the Marketplace Publisher Agreement.

That's it. The PAT is what `vsce` uses to publish; it's read from `$VSCE_PAT`.

---

## Publishing a release

### Prerequisites each time

- Export both tokens so neither CLI sees a secret on the command line:

  ```bash
  export OVSX_PAT=<token from https://open-vsx.org/user-settings/tokens>
  export VSCE_PAT=<Azure DevOps PAT, Marketplace > Manage scope>
  ```

- The `version` in `package.json` must be **higher than the last published
  version** — both registries reject re-publishing an existing version. Bump it
  first (e.g. `yarn version --no-git-tag-version --patch`).

### The commands

Publish the same artifact to **both** registries:

```bash
make publish-all
```

`make publish-all` builds one `.vsix` at the current `package.json` version and
uploads that exact file to Open VSX and the VS Code Marketplace. Both go live
within seconds (the Marketplace may take a minute to finish its background scan).

To publish to just one registry:

```bash
make openvsx-publish     # Open VSX only
make vscode-publish      # VS Code Marketplace only
make publish             # Open VSX, creating the namespace first (first release)
```

### Doing it by hand

The targets wrap these commands — useful if you need to run a step in isolation:

```bash
npx ovsx create-namespace AxiomStudio              # one-time; reads $OVSX_PAT
npx vsce package                                   # builds via vscode:prepublish, emits the .vsix
npx ovsx publish vscode-vibeflow-<version>.vsix    # Open VSX; reads $OVSX_PAT
npx vsce publish --packagePath vscode-vibeflow-<version>.vsix   # Marketplace; reads $VSCE_PAT
```

`--packagePath` publishes the already-built `.vsix` rather than repackaging, so
the *same* artifact lands in both registries. `vsce` and `ovsx` run via `npx`, so
no global install is required.

---

## Make targets

| Target | What it does |
|--------|--------------|
| `make package` | Build and produce `vscode-vibeflow-<version>.vsix` |
| `make openvsx-namespace` | Create the `AxiomStudio` Open VSX namespace (one-time, tolerant if it exists) |
| `make openvsx-publish` | Package and publish the current version to Open VSX |
| `make publish` | Open VSX first-time flow: namespace + package + publish |
| `make vscode-publish` | Package and publish the current version to the VS Code Marketplace |
| `make publish-all` | Build once, publish the same `.vsix` to **both** registries |
| `make clean` | Remove built `.vsix` files |

Open VSX targets require `OVSX_PAT`; VS Code Marketplace targets require
`VSCE_PAT`. Each fails fast with a clear message if its token is missing.

---

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `ERROR: OVSX_PAT not set` / `ERROR: VSCE_PAT not set` | `export` the named token before running that publish target. |
| `namespace '...' may already exist — continuing` | Expected on re-runs; the namespace is created once. Not an error. |
| `Extension version X.Y.Z is already published` | Bump `version` in `package.json`; neither registry lets you overwrite a published version. |
| `vsce` complains about a missing `repository`, `LICENSE`, or icon | Fix the flagged `package.json` field or add the file, then re-run. |
| `vsce` error: *Failed request: (401)* | The `VSCE_PAT` is wrong/expired, or its scope isn't *Marketplace → Manage* with *All accessible organizations*. Regenerate it. |
| `vsce` error: publisher `AxiomStudio` not found / no access | Create the `AxiomStudio` publisher at [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage), or the PAT belongs to an account without rights to it. |
| Open VSX publish succeeds but the listing shows *unverified* | Expected — see [Namespace verification is optional](#namespace-verification-is-optional). |

## References

- Open VSX — [Publishing Extensions](https://github.com/EclipseFdn/open-vsx.org/wiki/Publishing-Extensions)
- Open VSX — [Managing Namespaces](https://github.com/EclipseFdn/open-vsx.org/wiki/Managing-Namespaces)
- VS Code — [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [`ovsx` CLI](https://github.com/eclipse/openvsx/blob/master/cli/README.md)
- [`vsce` CLI](https://github.com/microsoft/vscode-vsce)
