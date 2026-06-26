# VibeFlow — build & publish
#
# Publishing targets push the extension to two registries:
#   - Open VSX Registry      (Cursor, VS Codium, Gitpod, Theia, …)
#   - VS Code Marketplace    (Microsoft, for VS Code proper)
# See docs/publishing.md for the full walkthrough (accounts, tokens, publishers).
#
# Tokens are read from the environment so they never appear on the command line
# or in shell history:
#
#     export OVSX_PAT=<token from https://open-vsx.org/user-settings/tokens>
#     export VSCE_PAT=<Azure DevOps PAT, Marketplace > Manage scope>
#     make publish-all

PUBLISHER := AxiomStudio     
NAME      := vscode-vibeflow
VERSION   := $(shell node -p "require('./package.json').version")
VSIX      := $(NAME)-$(VERSION).vsix

.DEFAULT_GOAL := help

.PHONY: help install build check package \
        openvsx-namespace openvsx-publish publish \
        vscode-publish publish-all release clean

help:
	@echo "VibeFlow — make targets"
	@echo ""
	@echo "  make install            Install dependencies (yarn install)"
	@echo "  make build              Build webview + extension"
	@echo "  make check              Typecheck, lint, test, security guards"
	@echo "  make package            Build and produce $(VSIX)"
	@echo ""
	@echo "  Open VSX (needs OVSX_PAT in the environment):"
	@echo "  make openvsx-namespace  Create the '$(PUBLISHER)' namespace (one-time)"
	@echo "  make openvsx-publish    Package and publish $(VSIX) to Open VSX"
	@echo "  make publish            Open VSX full flow: namespace + package + publish"
	@echo ""
	@echo "  VS Code Marketplace (needs VSCE_PAT in the environment):"
	@echo "  make vscode-publish     Package and publish $(VSIX) to the VS Code Marketplace"
	@echo ""
	@echo "  make publish-all        Publish the same $(VSIX) to BOTH registries"
	@echo ""
	@echo "  Release (one command — needs OVSX_PAT and VSCE_PAT in the environment):"
	@echo "  make release            Bump version, build, commit, tag, push, publish to both"
	@echo "                          BUMP=patch|minor|major (default patch)"
	@echo ""
	@echo "  make clean              Remove built .vsix files"
	@echo ""
	@echo "  Current version: $(VERSION)"

install:
	yarn install

build:
	yarn build

check:
	yarn check

# `vsce package` runs the `vscode:prepublish` script (yarn build) automatically,
# so this single command builds and packages.
package:
	npx vsce package

# ovsx reads the token from $OVSX_PAT, so it is never passed on the command line.
# One-time. Tolerant: a namespace that already exists is not an error here.
openvsx-namespace:
	@test -n "$(OVSX_PAT)" || { echo "ERROR: OVSX_PAT not set. export OVSX_PAT=<token from https://open-vsx.org/user-settings/tokens>"; exit 1; }
	@npx ovsx create-namespace $(PUBLISHER) || echo ">> namespace '$(PUBLISHER)' may already exist — continuing"

openvsx-publish: package
	@test -n "$(OVSX_PAT)" || { echo "ERROR: OVSX_PAT not set. export OVSX_PAT=<token from https://open-vsx.org/user-settings/tokens>"; exit 1; }
	npx ovsx publish $(VSIX)

# Full first-time flow. After the namespace exists, `make openvsx-publish` is enough.
publish: openvsx-namespace openvsx-publish

# vsce reads the token from $VSCE_PAT, so it is never passed on the command line.
# Requires a publisher named '$(PUBLISHER)' to exist at
# https://marketplace.visualstudio.com/manage (one-time, done in the browser).
# --packagePath publishes the already-built $(VSIX) instead of repackaging, so
# the exact same artifact goes to both registries.
vscode-publish: package
	@test -n "$(VSCE_PAT)" || { echo "ERROR: VSCE_PAT not set. export VSCE_PAT=<Azure DevOps PAT, Marketplace > Manage scope>"; exit 1; }
	npx vsce publish --packagePath $(VSIX)

# Publish the SAME built $(VSIX) to both registries. `package` runs once.
publish-all: openvsx-publish vscode-publish

# One-command release. Cuts a release end to end:
#   bump package.json version -> build + package -> commit -> tag -> push -> publish to both registries.
# Pick the bump (default patch):
#   make release BUMP=patch    # 1.1.0 -> 1.1.1
#   make release BUMP=minor    # 1.1.0 -> 1.2.0
#   make release BUMP=major    # 1.1.0 -> 2.0.0
# Publishing needs OVSX_PAT and VSCE_PAT in the environment (see publish-all).
# Aborts unless the tree is clean, you are on `main`, and you are in sync with
# origin/main — git stays the source of truth, so a publish failure leaves a
# tagged+pushed commit you can re-publish with `make publish-all`.
#
# `$(MAKE) package` / `$(MAKE) publish-all` are sub-makes on purpose: VERSION/VSIX
# are `:=` (parse-time), so the freshly bumped version is only picked up by a
# re-parsed make. npm is used only to rewrite the version string (no git side
# effects, no dependency install) — yarn 1's `version` is interactive-prone.
BUMP ?= patch
release:
	@case "$(BUMP)" in patch|minor|major) ;; *) echo "ERROR: BUMP must be patch|minor|major (got '$(BUMP)')"; exit 1 ;; esac
	@test "$$(git rev-parse --abbrev-ref HEAD)" = "main" || { echo "ERROR: releases must be cut from 'main' (currently on $$(git rev-parse --abbrev-ref HEAD))"; exit 1; }
	@git diff --quiet && git diff --cached --quiet || { echo "ERROR: working tree is dirty — commit or stash before releasing"; exit 1; }
	@git fetch --quiet origin main
	@test "$$(git rev-list --count HEAD..origin/main)" = "0" || { echo "ERROR: behind origin/main — run 'git pull' first"; exit 1; }
	@test "$$(git rev-list --count origin/main..HEAD)" = "0" || { echo "ERROR: ahead of origin/main — push your commits before releasing"; exit 1; }
	npm version $(BUMP) --no-git-tag-version
	@$(MAKE) package
	@v=$$(node -p "require('./package.json').version") && \
	  git add package.json && \
	  git commit -m "chore(release): v$$v" && \
	  git tag "v$$v" && \
	  git push origin main && \
	  git push origin "v$$v" && \
	  echo ">> released v$$v (tagged + pushed) — publishing to registries"
	@$(MAKE) publish-all
	@echo ">> done: published to Open VSX + VS Code Marketplace"

clean:
	rm -f $(NAME)-*.vsix
