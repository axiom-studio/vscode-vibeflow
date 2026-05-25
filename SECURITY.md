# Security Policy

We take the security of the VibeFlow VSCode extension and the surrounding platform seriously. If you believe you've found a vulnerability, please follow the process below — **do not file a public GitHub issue.**

## Reporting

Email **security@axiomstudio.ai** with:

- A description of the vulnerability
- Step-by-step reproduction (proof of concept if you have one)
- The version(s) affected (extension version, VSCode version, OS)
- Your assessment of impact (data exposure, RCE, privilege escalation, etc.)

We acknowledge reports within **2 business days** and aim to ship a fix or mitigation within **30 days** for high-severity issues.

## Scope

In scope:

- The VibeFlow VSCode extension (this listing)
- The vibeflow-cli binary distributed alongside it
- The host-side IPC + storage paths used by the extension

Out of scope (report to those projects directly):

- The VSCode application itself
- Third-party agent CLIs (Claude Code, Codex, Gemini, Cursor)
- The axiomcloud server (see [axiomstudio.ai/security](https://axiomstudio.ai) for that scope)

## Safe harbor

If you act in good faith — make a reasonable effort to avoid privacy violations, data destruction, or service interruption, and give us reasonable time to address the issue before disclosure — we won't pursue legal action against you for the research that uncovered the vulnerability.

## Coordinated disclosure

We prefer coordinated disclosure. Once a fix ships:

- We'll credit you (with your permission) in the release notes
- We'll work with you on a disclosure timeline that gives users time to update

Thanks for keeping our users safe.
