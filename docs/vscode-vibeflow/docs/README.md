# VibeFlow for VS Code User Guide

The complete user-facing guide for the VibeFlow VS Code extension. Eight documents covering install through deep architectural understanding.

> These docs ship in the repository, not in the published `.vsix`. `.vscodeignore` excludes `docs/user-guide/**` so the extension package stays lean (the marketplace tile, README, and walkthrough cover the essentials there).

## Start here

| # | Doc | When to read it |
|---|---|---|
| 1 | [Getting Started](01-getting-started.md) | First install. Install, sign in, first session in ~5 minutes. |
| 2 | [Feature Tour](02-feature-tour.md) | Once you're set up. A guided lap of every view, panel, and command. |
| 3 | [Workflows and Flow Diagrams](03-workflows-and-flows.md) | When you want to understand *how the pieces fit together*. Sequence + state diagrams in Mermaid. |
| 4 | [Chat-First Mode](04-chat-first-mode.md) | When you've heard "chat-first" and want the deep dive. What it is, when to use it, and why it differs from vanilla. |
| 5 | [Settings Reference](05-settings-reference.md) | When you want to know exactly what a setting does. Every key, type, default, and gotcha. |
| 6 | [Troubleshooting](06-troubleshooting.md) | When something broke. Symptom, cause, and fix for the ~16 most common problems. |
| 7 | [Glossary](07-glossary.md) | When a term confuses you. Every VibeFlow-specific word defined for non-technical readers. |
| 8 | [FAQ](08-faq.md) | When you have a question that didn't fit the other docs. ~27 questions across 8 sections. |

## Recommended reading order

**Brand new to VibeFlow?** Read 1, then 7, then 2, then 8 (Getting Started, then Glossary as reference, then Feature Tour, then FAQ for follow-ups).

**Trying to debug something?** Jump to 6 (Troubleshooting). If the symptom isn't listed, check 8 (FAQ).

**Just want to understand how things work?** Read 3 (Workflows and Flow Diagrams). This is the architectural overview, with sequence diagrams for every common scenario.

**Configuring the extension?** Read 5 (Settings Reference).

## Conventions used across the docs

- **`VibeFlow:` prefix**: every command name is prefixed (e.g. `VibeFlow: Launch Session`). Run any of them via the Command Palette (`Cmd/Ctrl+Shift+P`).
- **`vibeflow.` prefix**: every setting key (e.g. `vibeflow.serverUrl`). Find them via the Settings panel or `settings.json`.
- **View names**: capitalized. Agent Fleet, Work Items, Project Items, Documents, Activity Feed.
- **Persona names**: capitalized, with the character name in parentheses on first mention. Developer (Kai), Architect (Morgan), etc.
- **Issue references**: `#NNNN` for VibeFlow Cloud issue IDs. The most-cited issues (#1947, #2174, #2305, etc.) come up in Troubleshooting where their root cause explains a current behavior.

## Found a mistake?

Open an issue at the [VibeFlow extension repository](https://bitbucket.org/axiom-studio/vscode-vibeflow) or use **VibeFlow: Report an Issue…** from the Command Palette. The report includes a pre-populated link with version + diagnostic info.

## Authoring notes (for maintainers)

- The 8 docs are designed to be read in any order. Each opens with "Who this is for" plus a TL;DR and cross-links to siblings where relevant.
- Word counts hover around 1500-2500 each. Total suite is ~17,000 words.
- The Mermaid diagrams in doc 3 render natively in GitHub, VS Code's markdown preview, and Bitbucket. Don't replace them with images. Text-based diagrams stay accurate as the code evolves.
- When the extension ships new commands, settings, or views, the relevant doc (usually 02 Feature Tour or 05 Settings Reference) must be updated in the same PR. The release-readiness checklist enforces this.

---

*Last updated: 2026-05-24. Generated as part of VibeFlow Phase 6, User Documentation Suite (feature #418, todo #1982).*
