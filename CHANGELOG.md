# Changelog

## 0.1.0 (2026-04-16)

### Phase 1 — Foundation MVP
- Extension scaffold with 4 sidebar views (Agent Fleet, Work Items, Activity Feed, Documents)
- OAuth removed, API key authentication via Secrets API
- Auto-detect project from git remote URL
- CLI config integration (`~/.vibeflow-cli/config.yaml`)
- Activity Feed with react-virtuoso (500+ entry support)
- Basic @vibeflow Chat Participant (/status, /create)
- Status bar with 6 connection states

### Phase 2 — Real-Time & Rich UX
- Session lifecycle: 8-step launch wizard with persona selection
- Work Item CRUD: create/status/priority from TreeView
- Agent Session Focus Panel (per-persona editor tab)
- Work Item Detail Panel with execution logs and QA/Security actions
- Document Explorer with React markdown viewer
- Chat Participant expanded: /review, /summary, /launch, /respond
- QA Verify/Reject and Security Review workflows
- Branch review status check (pre-PR gate)
- Create PR command

### Phase 3 — Terminal-First Multi-Persona Execution
- Session visibility fix (correct API endpoint)
- Terminal-first architecture with hybrid mode (code agents visible, advisory hidden)
- Session reattachment on VSCode reload
- Settings as dedicated editor panel
- Per-persona sticky models (Architect→Opus, Dev→Sonnet, QA→Haiku)
- Document comments with section-based inline UI
- Save All & Notify with persona picker
- Typed message protocol foundation
- Comment paragraph spacing polish
- 5-step onboarding walkthrough
