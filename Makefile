# VibeFlow for VS Code — build & publish
#
# Publishing targets push the extension to the Open VSX Registry.
# See docs/publishing.md for the full walkthrough (accounts, tokens, namespaces).
#
# Token: targets read the access token from the OVSX_PAT environment variable
# so it never appears on the command line or in shell history:
#
#     export OVSX_PAT=<token from https://open-vsx.org/user-settings/tokens>
#     make publish

PUBLISHER := AxiomStudio
NAME      := vscode-vibeflow
VERSION   := $(shell node -p "require('./package.json').version")
VSIX      := $(NAME)-$(VERSION).vsix

.DEFAULT_GOAL := help

.PHONY: help install build check package \
        openvsx-namespace openvsx-publish publish clean

help:
	@echo "VibeFlow for VS Code — make targets"
	@echo ""
	@echo "  make install            Install dependencies (yarn install)"
	@echo "  make build              Build webview + extension"
	@echo "  make check              Typecheck, lint, test, security guards"
	@echo "  make package            Build and produce $(VSIX)"
	@echo ""
	@echo "  Open VSX (needs OVSX_PAT in the environment):"
	@echo "  make openvsx-namespace  Create the '$(PUBLISHER)' namespace (one-time)"
	@echo "  make openvsx-publish    Package and publish $(VSIX) to Open VSX"
	@echo "  make publish            Full flow: namespace + package + publish"
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

clean:
	rm -f $(NAME)-*.vsix
