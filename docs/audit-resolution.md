# Audit Resolution — Major Functional Gaps

Each section below maps to one audit item, lists the commit that closed it,
files touched, a one-paragraph summary of what the fix does, and a manual
test plan. Items appear in the same order as the audit.

For most tests you need:
- A workspace whose `.git` config points at a project linked in VibeFlow
- `VibeFlow: Setup` run successfully and an active session for at least one
  persona (Architect, Developer, etc.) so polling has something to find
- The `vibeflow.polling.interval` setting at 5–10s during testing so you
  don't have to wait 30s between cycles

---

## 1. Kanban drag-and-drop is dead

**Status:** fixed
**Commit:** `41395be` — *Wire Kanban panel to live swimlane data*
**Files:** `src/views/kanban/KanbanPanel.ts`, `webview-ui/src/components/kanban/KanbanView.tsx`, typed messages in `src/core/webviewMessages.ts`

**What changed.** `KanbanPanel.ts` now has a full `onDidReceiveMessage` handler
covering `kanbanLoad` / `kanbanRefresh` / `kanbanMove` / `kanbanOpenItem`. Load
calls `client.listSwimlane(projectId)`, push `kanbanData` to the webview;
move calls `update_todo_status` / `update_issue_status` via the MCP client and
re-fetches the swimlane to reconcile. The optimistic UI in
`KanbanView.tsx` rolls back when the host reports failure.

**How to test.**
1. `Ctrl/Cmd+Shift+V K` — Kanban opens with 8 swimlane columns populated.
2. Drag a todo card from "Implementing" to "Done". The card snaps to the
   target column immediately (optimistic) and the column count updates.
3. Reload (`Ctrl/Cmd+Shift+V K` again or click Refresh in the webview header)
   — the card is still in "Done", confirming the server accepted it.
4. Open the same project on `cloud.axiomstudio.ai` and confirm the status
   matches.
5. Negative test: drag from `rejected` to anything other than `in_review`
   (the only allowed transition for rejected, per
   `axiomcloud/database/vibeflow_models.go`). The card should rubber-band
   back and a toast surfaces the backend error.

---

## 2. Dashboard is static art

**Status:** fixed
**Commit:** `8123c1e` — *Wire Dashboard to live persona / governance / sessions data*
**Files:** `src/views/dashboard/DashboardPanel.ts`, `webview-ui/src/components/dashboard/DashboardView.tsx`, supporting types

**What changed.** `DashboardPanel` now builds the snapshot from three live
sources: `client.listSessions(projectId)` for active personas,
`client.getWorkSummary(projectId)` for metric cards (commits, lines added/
deleted, total session seconds), and `client.listComplianceFindings(...)`
for the compliance lane. The React Flow nodes are generated from the
session list instead of hardcoded; clicking a persona node fires
`dashboardFocusPersona` which the host turns into the appropriate Session
panel open call.

**How to test.**
1. `Ctrl/Cmd+Shift+V D` — Dashboard opens.
2. Verify metric cards show non-zero values for commits / lines / time once
   you've published at least one log via `publish_todo_log` from any active
   session.
3. Each active persona renders as a node with avatar + label. Click a node →
   the Session focus panel opens for that persona.
4. Compliance lane shows any rows from `list_compliance_findings`. Create
   one in the Cloud UI; refresh — it appears.
5. Disconnect (logout) and re-open: panel renders the empty state, no
   stale nodes/edges.

---

## 3. File Decorations are inert

**Status:** fixed
**Commit:** `39d2dff` — *Persona-aware activity poller and live file decorations*
**Files:** `src/views/decorations/AgentFileDecorationProvider.ts`, `src/views/activity/ActivityPoller.ts`

### What File Decorations are

In VS Code, the Explorer (file tree) lets extensions paint per-file badges
and tooltips through the `FileDecorationProvider` API. We use this so the
user can see at a glance which files an agent is currently editing, with a
hover tooltip that says "Developer is modifying X" / "Architect is reading
Y" / "Marked as committed by Principal Engineer". The decoration fades when
the agent moves on or commits.

### What changed

`ActivityPoller.fetchAndPushLogs` now scans each new log line with a
verb-aware regex (`Modified | Created | Read | Wrote | Updated | Deleted`)
and resolves any path-like tokens to absolute fsPaths (refusing tokens
outside the workspace). Verbs map to `FileAction = read|write|edit|delete`.
The poller calls `markActiveBatch(...)` for in-progress edits and
`markCommitted(abs, persona)` for commit-style log lines (those starting
with 📝) or explicit deletes. The provider implements `provideFileDecoration`
to return a 1-character persona badge + colored tooltip.

**How to test.**
1. Start a Developer session that touches a file under your workspace —
   easiest: ask it to `publish_todo_log` with content like `⚡ Modified:
   src/foo.ts (added validation)`.
2. Within one poll cycle (5–30s), open the Explorer view. The
   `src/foo.ts` row shows a `D` badge with a colored hover tooltip
   "Developer is editing src/foo.ts".
3. Have the agent emit `📝 Committed src/foo.ts in abc1234`. The badge
   moves to `✓` and the tooltip says committed.
4. After ~2 minutes of no further activity on that file, the badge fades
   (provider expires stale entries).
5. Negative test: emit a log mentioning `auth.go` that doesn't exist in
   the workspace. No badge appears (path resolution rejects phantom
   files).

---

## 4. `vibeflow.respondToPrompt` does nothing useful

**Status:** fixed
**Commits:** `58e4e3b`, `0d75899`
**Files:** `src/extension.ts`, `src/notifications/PromptNotifier.ts`

**What changed.** `extension.ts` now wires `promptNotifier.setRespondHandler`
during activation so the response actually goes to the backend.
`vibeflow.respondToPrompt` builds the QuickPick from
`client.listPendingPrompts(projectId)` instead of an empty array;
selecting an item opens an InputBox, then calls the REST endpoint
`PUT /rest/v1/vibeflow/prompts/{id}/respond` (the MCP `respond_to_prompt`
tool is for the inverse user→agent direction; verified against
`axiomcloud/handlers/vibeflow_prompts.go`).

**How to test.**
1. From an agent session, call `prompt_user` with a question.
2. A toast pops up ("Architect asks: ..."). Status bar shows the prompt
   counter.
3. `Ctrl/Cmd+Shift+V R` opens a QuickPick listing the pending prompt(s).
4. Pick one → an InputBox opens with the question as placeholder. Type
   a response, press Enter.
5. The agent's `wait_for_work` returns the response within one cycle.
6. Negative test: respond to an already-responded prompt — the
   QuickPick re-fetches and the stale entry is gone.

---

## 5. Activity Feed `respondToPrompt` was mocked

**Status:** fixed
**Commit:** `58e4e3b` (same change as #4)
**File:** `src/views/activity/ActivityFeedProvider.ts`

`handlePromptResponse` no longer just shows "Response sent: ..." — it
delegates to `promptNotifier.collectAndSendResponse` which is the same
path used by the toast and `vibeflow.respondToPrompt` command.

**How to test.** Same as #4, but trigger the response from the Activity
Feed itself: a prompt entry renders with a "Respond" button; click it
and the InputBox flow runs.

---

## 6. `SessionPanelManager.sendPrompt` was mocked

**Status:** fixed
**Commit:** `09e04cc` — *Real Progress Ledger and live sendPrompt in Session focus panels*
**File:** `src/views/sessions/SessionPanelManager.ts`

**What changed.** `sendPrompt` now POSTs `/rest/v1/vibeflow/prompts` with
`source: 'user'` so the agent's next `wait_for_work` returns it as a
user→agent prompt. `refreshPanel` builds the Progress Ledger by listing
the session's claimed todos/issues, fetching their logs, merging by
timestamp, and capping at the newest 100 lines (no `GET /sessions/{id}/logs`
endpoint exists per axiomcloud — confirmed 2026-05-02).

**How to test.**
1. Open the Agent Fleet, click an active session → Session panel opens.
2. Progress Ledger populates within one cycle (no "Loading logs..."
   forever).
3. Type a prompt in the bottom box, click Send.
4. The agent receives it on the next `wait_for_work` and acknowledges in
   its log stream.

---

## 7. Work Item panel — QA/Security mocked, tabs missing

**Status:** fixed (4 phases)
**Commits:** `616e3ba` (A), `009312e` (B), `cafb894` (C), `c3ccaad` (D)
**Files:** `src/views/workItems/WorkItemPanelManager.ts`, `webview-ui/src/components/workitems/*`, supporting client methods

**What changed.**
- **Phase A:** `qaAction` / `securityAction` import the real implementations
  from `governanceCommands.ts` and call `client.qaVerify` / `client.qaReject`
  / `client.securityVerify` / `client.securityReject` — same wire calls the
  command palette uses.
- **Phase B:** restructured panel into Details / Attachments / Logs tabs
  matching the PRD.
- **Phase C:** header actions wired (Edit description, Archive issues,
  Delete with confirmation modal).
- **Phase D:** Attachments tab upload (multipart POST `/attachments`) +
  delete with optimistic UI.

**How to test.**
1. Open the Work Items tree, click any todo/issue → panel opens with
   3 tabs: Details, Attachments, Logs.
2. **Details:** edit description, save → toast confirms, tree refreshes.
3. **QA buttons:** for a `done` item, click Verify QA → status updates
   the verification row (visible in cloud UI).
4. **Security buttons:** Approve/Reject — same loop.
5. **Attachments:** drop a file → uploads, appears in list. Delete →
   optimistic remove, server confirms.
6. **Logs:** /qa/review and /security/review responses surface in
   collapsible sections (commit `9ad3f27`).
7. **Archive (issues only):** demoted to archived status; confirm in
   Cloud UI.
8. **Delete:** modal warns; delete → row gone in tree on next poll.

---

## 8. SettingsPanel could not change project / refresh projects

**Status:** fixed
**Commit:** `0e194c3` — *Wire Settings selectProject + refreshProjects + populate the dropdown*
**File:** `src/views/settings/SettingsPanel.ts`

**What changed.** Switch in `onDidReceiveMessage` now handles
`selectProject` (calls `detector.cacheProject(...)` + `onProjectSwitched`
callback) and `refreshProjects` (re-runs `buildSettingsPayload` which
pulls the live list from `client.listProjects()`). The dropdown actually
populates because the payload now embeds `projects: [{id, name}, ...]`.

**How to test.**
1. `Ctrl/Cmd+Shift+V S` → Settings panel.
2. Connection tab → "Project" dropdown shows all projects you have
   access to.
3. Pick a different project → toast confirms, all trees rebind to the
   new project id without a window reload.
4. Click the refresh icon next to the dropdown → list re-fetches.

---

## 9. `setProviderToken` message contract was misleading

**Status:** fixed
**Commit:** `542ed70` — *Fix setProviderToken message contract — drop unused token field*
**Files:** `src/core/webviewMessages.ts`, `webview-ui/src/components/settings/ProvidersTab.tsx`, `src/views/settings/SettingsPanel.ts`

**What changed.** The webview cannot open a password-masked input on its
own, so the host owns the InputBox. The message now carries only
`{ provider: string }` — no fake `token: ''` field that the host had to
ignore.

**How to test.**
1. Settings → Providers tab → click "Set token" on Codex / Gemini.
2. The host opens a password-masked InputBox.
3. Submit → toast says "VibeFlow: MCP_TOKEN saved".

---

## 10. Sticky Models had no UI

**Status:** fixed
**Commit:** `575ba9d` — *Add Sticky Models tab to Settings*
**Files:** `webview-ui/src/components/settings/ModelsTab.tsx`, `src/sessions/stickyModels.ts`, `src/views/settings/SettingsPanel.ts`

**What changed.** New "Sticky Models" tab lists all 9 personas with a model
dropdown per row + Reset button. Reads/writes go through `StickyModels`
(backed by ContextProxy, persisted in `globalState`).

**How to test.**
1. Settings → Sticky Models.
2. For "Architect", change model from default to a different option.
3. Launch a new Architect session — it boots with the picked model.
4. Click Reset on the row → returns to hardcoded default.

---

## 11. Settings only had 3 of the 7 PRD tabs

**Status:** fixed
**Commit:** `086694b` — *Split Settings into the 8 PRD-specified tabs*
**Files:** `webview-ui/src/components/settings/*` (5 new tab files + `_shared.tsx`)

**What changed.** Tab row is now: Connection, Providers, Session Defaults,
Sticky Models, Worktrees, Notifications, Advanced, About. Tab strip wraps
when narrow. Shared `Card` / `Toggle` / `RadioGroup` extracted to
`_shared.tsx` so each tab file stays small.

**How to test.** `Ctrl/Cmd+Shift+V S` → all 8 tabs render; clicking each
shows the right content; toggling settings persists across panel reopens.

---

## 12. ActivityPoller hardcoded `developer` for every entry

**Status:** fixed
**Commit:** `541b64f` — *Attribute Activity Feed log entries to the persona that wrote them*
**Files:** `src/api/client.ts` (`parseLogString`), `src/views/activity/ActivityPoller.ts`

**What changed.** Backend embeds the writer's session id in every log
marker (`*[ts | session-id]*` per `annotateLogEntry` in
`axiomcloud/mcp/vibeflow_tools.go:561`) plus a `security_review` pseudo-source.
The parser was throwing both away. `parseLogString` now returns
`{ ..., source?: string }`. `ActivityPoller.resolvePersonaForLog` maps
`session-...` via `sessionPersonaMap`, `security_review` → `security_lead`,
falling back to the work item's `claimed_by`. The map is no longer cleared
each cycle — once a session→persona mapping is known it's immutable.

**How to test.**
1. Trigger a multi-persona workflow: Architect creates plan, Developer
   implements, Security rejects.
2. Activity Feed shows three differently-colored entries with the right
   persona names — not all "Developer".
3. End the Architect session; the feed entries it wrote keep their
   "Architect" attribution (map accumulates).

---

## 13. Pinned Plan was brittle text-pattern scraping

**Status:** fixed
**Commit:** `cc5c922` — *Drive Pinned Plan from structured progress, not log-text scraping*
**Files:** `src/api/types.ts` (`VibeFlowProgressSnapshot`), `src/core/webviewMessages.ts` (`progressIndicator`), `src/views/activity/ActivityFeedProvider.ts`, `src/views/activity/ActivityPoller.ts`, `webview-ui/src/components/PinnedPlan.tsx`, `webview-ui/src/components/ActivityFeed.tsx`

**What changed.** The previous implementation scanned for `messageType ===
'summary' && content.includes('PLAN')` — a format the agent docs never
specify. Replaced with the structured `ProgressSnapshot` already on the
wire (`milestone_index/total/name`, `current_action`, `eta_seconds`,
`progress_pct` — see `axiomcloud/database/vibeflow_models.go:759`).
Poller picks the freshest snapshot per cycle and pushes a typed
`progressIndicator` host message; widget renders progress bar + milestone
counter + current action + ETA, auto-hiding when no item has progress.
`parsePlanFromLog` deleted.

**How to test.**
1. From an agent session, call `publish_todo_log` with
   `{ progress_pct: 40, milestone_index: 2, milestone_total: 5,
   milestone_name: "tests_green", current_action: "running unit tests",
   eta_seconds: 120 }`.
2. Within one cycle, the Activity Feed pins a "Progress · Architect"
   header showing `3/5 · tests_green`, a 40% bar, the action text, and
   "ETA 2m".
3. Publish another log with `progress_pct: 100` → bar fills.
4. Stop publishing progress; on the next cycle the bar disappears.

---

## 14. Phase 4 P4-1a — `vibeflowMonitor` Secondary Sidebar container

**Status:** fixed
**Commit:** `c1d6df6` — *Move Activity Feed to a Monitor container in the secondary sidebar (P4-1a)*
**File:** `package.json`

**What changed.** Added a second `viewsContainers.auxiliarybar` entry
`vibeflowMonitor` titled "VibeFlow Monitor" and moved
`vibeflow.activityFeed` into `views.vibeflowMonitor`. The primary
`vibeflow` container now only holds Agent Fleet, Work Items, Documents.

**How to test.**
1. Reload window. View → Open Secondary Side Bar (`Ctrl/Cmd+Alt+B`).
2. The "VibeFlow Monitor" container appears in the right sidebar with
   Activity Feed inside it.
3. The left sidebar's "VibeFlow" container shows Agent Fleet, Work
   Items, Documents — no Activity Feed.

---

## 15. Documents — no Create command, no polling, no buttons

**Status:** fixed
**Commits:**
- `d412ab2` — *Wire Documents tree with create + polling parity* (polling + create command + create/refresh title buttons)
- `546fc3f` — *Add view/title buttons to Activity Feed* (the partner item — see #16)

**Files:** `src/views/documents/DocumentsTreeProvider.ts`, `src/commands/documentCommands.ts` (new), `src/api/client.ts`, `src/extension.ts`, `package.json`

**What changed.**
- Polling: `DocumentsTreeProvider` now starts a `setInterval` on
  `connect()` using the same `vibeflow.polling.interval` as Work Items.
- Create command: new `vibeflow.createDocument` runs a 2-step Quick Pick
  (type → title), calls the `create_document` MCP tool.
- Title bar buttons: `view/title` entries (`createDocument` + `refresh`)
  on `vibeflow.documents`.

**How to test.**
1. View → VibeFlow → Documents tree.
2. "New File" icon in the title bar → Quick Pick lists 5 doc types →
   pick "PRD" → enter title → toast confirms → row appears.
3. From another session/cloud UI, create a document for the same project.
   Within one poll cycle the row appears in the tree without manual
   refresh.

---

## 16. Activity Feed had no `view/title` buttons

**Status:** fixed
**Commit:** `546fc3f` — *Add view/title buttons to Activity Feed*
**Files:** `src/views/activity/ActivityFeedProvider.ts`, `src/extension.ts`, `package.json`

**What changed.** Two buttons:
- **Clear Feed** (`$(clear-all)`): new `vibeflow.clearActivityFeed`
  command → `ActivityFeedProvider.clearFeed()` posts `clearActivity` to
  the webview. The poller's `seenEventIds` is intentionally not reset so
  only NEW activity surfaces afterward.
- **Settings** (gear): shortcut to `vibeflow.openSettings`.

**How to test.**
1. View Activity Feed in the secondary sidebar.
2. Clear button → entries disappear; new agent activity in the next
   poll appears.
3. Settings button → editor-area Settings panel opens.

---

## 17. Branch review status not surfaced as a status bar

**Status:** fixed
**Commit:** `ca39a51` — *Surface branch review readiness as a right-aligned status bar*
**Files:** `src/statusBar/branchReview.ts` (new), `src/extension.ts`

**What changed.** Right-aligned status bar item, priority 99 (just left of
the work-summary bar). Polls
`client.checkBranchReviewStatus(projectId, branch)` on
`vibeflow.polling.interval`. Five render states map to the wire shape:

| Wire | Render | Background |
|---|---|---|
| `total_items === 0` | `$(git-branch) <branch>` | default |
| `overall_security && overall_qa === PASS` | `$(check) <branch>` | default |
| `open_findings > 0` | `$(error) <branch> · N findings` | error |
| pending review | `$(warning) <branch> · N to review` | warning |
| poll error | `$(question) <branch>` | default |

Click → fires the existing `vibeflow.checkBranchStatus` for the fuller
popup. Lifecycle: `start()` in `connectToProject`, `stop()` in
`disconnect`, `refresh()` from the global `vibeflow.refresh` command.

**How to test.**
1. After login the bar appears.
2. On a branch with no work items: shows `$(git-branch) <branch>`.
3. Mark a todo as `done` → bar shows `$(warning) <branch> · 1 to review`
   within a cycle.
4. QA-verify and security-approve it → bar transitions to
   `$(check) <branch>`.
5. Click the bar → existing popup with `total_lines` + qa/security
   split appears.
6. Disconnect (`vibeflow.logout`) → bar hides.

---

## 18. `vibeflow.respondToPrompt` keybinding (and 6 others) missing

**Status:** fixed
**Commit:** `6b5a705` — *Add the 7-keybinding set including the missing respondToPrompt chord*
**File:** `package.json`

**What changed.** Chord vocabulary `Ctrl/Cmd+Shift+V <letter>`:

| Key | Command |
|---|---|
| K | Open Kanban (existing) |
| D | Open Dashboard (existing) |
| R | Respond to Prompt (was missing) |
| L | Launch Session |
| N | Create Work Item ("New") |
| S | Open Settings |
| F | Refresh |

**How to test.** Press each chord with a project connected:
1. K → Kanban opens.
2. D → Dashboard opens.
3. R → Respond-to-Prompt QuickPick opens.
4. L → Launch Session flow starts.
5. N → Create Work Item Quick Pick.
6. S → Settings panel opens.
7. F → all trees + branch bar refresh.

If any chord conflicts with a user-installed extension, VS Code shows
the conflict in the Keyboard Shortcuts editor — none of these are
defaults so collisions are unlikely.

---

## 19. `workSummary.ts` was dead duplicate code

**Status:** fixed
**Commit:** `7d182f5` — *Remove dead duplicate src/statusBar/workSummary.ts*

**What changed.** `extension.ts:12` has been importing
`createWorkSummaryStatusBar` from `./statusBar/sessionStatus.js` since the
bar grew `updateCounts` / `setDisconnected` methods. The old
`workSummary.ts` was a 10-line stub with no methods and zero imports.
Deleted.

**How to test.**
1. `yarn typecheck && yarn build` — both green (no broken imports).
2. Status bar still works: Right side shows `N agents · M ready` when
   connected, `Not connected` otherwise.

---

## Cross-cutting smoke test

Five-minute end-to-end run that exercises most fixes:

1. `VibeFlow: Setup` → log in.
2. Detect project / pick from Settings dropdown (#8).
3. Verify all 8 Settings tabs render (#11), Sticky Models has all 9
   personas (#10).
4. `Ctrl+Shift+V K` → Kanban; drag a card across columns (#1).
5. `Ctrl+Shift+V D` → Dashboard renders live nodes + metric cards (#2).
6. Launch a Developer session (#18 keybinding `L`); have it
   `publish_todo_log` with progress fields → Pinned Plan widget
   populates (#13), Activity Feed shows the right persona color (#12),
   File Decorations badge a workspace file (#3).
7. From the agent, call `prompt_user` → toast → `Ctrl+Shift+V R` →
   respond → agent receives the response (#4, #5).
8. From the Work Items tree, open the todo → 3 tabs render → upload an
   attachment → QA-verify (#7).
9. Branch review status bar shows ready/pending/findings as you transition
   the item (#17).
10. Add a Document via the Documents title button (#15); the Documents
    tree polls and shows it without manual refresh.
11. Click "Clear Feed" in the Activity Feed title bar (#16); only new
    entries should appear afterward.

If all eleven steps work, every audit item is functionally closed.

---

## Deferred — bundle size / no code-split

**Status:** accepted, revisit at scale
**Audit text:** *Webview UI is single-bundle, no code-split.
`webview-ui/vite.config.ts` forces `inlineDynamicImports: true` and one
chunk for all 5 modes (activity/settings/document/dashboard/kanban).
Every panel loads the full React Flow + react-virtuoso + remark-gfm +
highlight.js — that's 811KB confirmed by today's build.*

**Why deferred.** The complaint frames this as a network or activation
cost, but neither applies:

- **Webviews load from disk, not network.** 257 KB gzip read off SSD
  is ~5 ms — there is nothing to download.
- **Activation isn't affected.** Webviews don't load until the user
  opens a panel, so the bundle has zero impact on
  `vscode-vibeflow.activationEvents` startup time.
- **Subsequent opens are free.** Every panel manager sets
  `retainContextWhenHidden: true`, so each panel pays its first-mount
  cost once per session.

The user-perceived cost is **first-panel-open**: ~16 ms parse
(M-series V8) + ~100–200 ms React mount = ~250 ms total. Per-mode
splitting would shave 100–150 ms off Settings and Kanban — exactly the
panels users open deliberately, where 100 ms is invisible against the
mouse-click intent. Dashboard (where 100 ms could matter on a hotkey)
gets the smallest shrink because `@xyflow/react` is unavoidable there.

**What the bundle contains today:**

| Slice | Size | Used by |
|---|---|---|
| `react` + `react-dom` | ~140 KB | every panel |
| `@xyflow/react` | ~250 KB | Dashboard only |
| `highlight.js` (~30 langs) | ~150 KB | Document Viewer only |
| `react-markdown` + `remark-gfm` + `rehype-highlight` | ~80 KB | Activity Feed, Document Viewer |
| `react-virtuoso` | ~50 KB | Activity Feed only |
| App code + Tailwind in JS | ~140 KB | every panel |

**Two cheap wins to revisit when this bites:**

1. **Trim `highlight.js` languages.** `rehype-highlight` defaults to
   ~30 languages via its `common` bundle. Restrict to {bash, ts, tsx,
   js, jsx, py, go, json, yaml, md}. Saves ~80 KB everywhere. ~30 min.
2. **Lazy-load `@xyflow/react`.** VS Code webviews have supported
   `<script type="module">` since 1.71+ and our CSP already permits
   it. Switch the script tag and do
   `const { ReactFlow, Background } = await import('@xyflow/react')`
   inside `DashboardView`. Saves ~250 KB from Settings, Kanban,
   Activity Feed, and Document Viewer — ~70% of what a full per-mode
   split would buy. ~30 min.

**Trigger to revisit:** if first-panel-open ever crosses ~500 ms on a
mid-tier laptop, or if we add a heavier dep (e.g. a charting library
to Dashboard), do W1 + W2 first. Per-mode splitting only makes sense
if both fall short.

**What we won't do:** full per-mode entry-point split. N Vite entries,
N HTML templates, N maintenance surfaces forever. Maintenance cost
outweighs the benefit at this scale.

---

## Deferred — no shared state library / ExtensionStateContext

**Status:** intentional, not deferred to a date
**Audit text:** *No state library. Each React component manages its own
state and message listener; no ExtensionStateContext like Roo-Code.
Cross-component sync (e.g. comments updated → activity feed reacts) is
impossible today.*

**Why we don't need it.** The Roo-Code analogy doesn't fit. Roo-Code is
one webview that owns the entire UI — a context provider lets every
nested component subscribe. We have **6 separate webviews**, each in
its own iframe. They cannot share React state directly even with a
context. Cross-webview reactivity has to flow through the host
anyway — and we already do that (poller → `feedProvider.pushEntry` →
Activity Feed), which is the right shape for VS Code's webview model.

Inside any single webview, the components are small and pass props
top-down (Settings has 8 tabs, all driven by one `data` prop;
ActivityFeed has Virtuoso + PinnedPlan, fed by one entries array).
None has grown past the point where a context provider would help.

**When to revisit.** If a single webview grows three+ levels of
prop-drilling for the same shared shape, or if we adopt Zustand /
Jotai for unrelated reasons, then sweep this. Until then, props +
local hooks remain the simpler tool.

---

## API / MCP coverage holes

**Status:** triaged
**Audit text:** *PRD claims "100% MCP tool coverage". Today's client.ts
exposes ~26 tools.*

**Reality check first.** Today's `client.ts` exposes **44 methods**, not
26 (count: `grep -c "async [a-zA-Z]*(" src/api/client.ts`). The
"100% coverage" claim is still overreach — backend has 72 MCP tools —
but the gap is smaller than the audit suggests.

**Triaged below into three buckets.** The principle: a client method
costs nothing to maintain, but only matters if some UI calls it. We
wire when there's an obvious user surface; we leave the rest.

### Wire now (have natural UI homes)

| Tool | Status | Why |
|---|---|---|
| Priority update on todos/issues | **fixed in this change** | `changePriority` previously returned "coming soon"; now POSTs through existing `updateTodo`/`updateIssue`. Wired into a `vibeflow.changePriority` command + work-item right-click menu. |

The other "wire now" candidates and their gating UI:

- `update_feature_status` — needs Feature detail surface; not yet present
- `archive_project` / `unarchive_project` — could add to command palette + Settings, but no user has asked for project-level archival
- `acknowledge_prompt` — useful as one-tap dismiss for stale prompts, but the existing `respond` flow already clears them. Marginal win.

### Wire when there's a UI for it

These tools work but no current panel has a place to invoke them. Each
is a small client method + ~20 lines of UI when needed.

- `update_document` / `delete_document` — Documents tree currently
  read-only after create. Add when we add a Document detail panel.
- `create_security_review_link` — security_lead workflow surface
  doesn't exist in the extension yet.
- `create_github_pr` / `create_bitbucket_pr` — generic `createPR` covers
  the user need today; specific routing is a Settings preference.
- `record_commit` — agent-driven (called by CLI/MCP); would only matter
  if the extension auto-commits on a user action.
- `sync/link_github_issue` — workflow nice-to-have.
- `update_project_status` — narrower surface than feature/work-item;
  rare.
- `create/update/list_compliance_finding`, `tag/untag/list_compliance_tags`
  — all need a Compliance UI we haven't designed.
- All `create/get/update/list_contexts` — needs a Context tab/tree.
- `download_asset`, `get_asset`, `update_asset`, `list_assets`,
  `create_attachment` direct path — `uploadAttachment` +
  `listAttachments` + `deleteAttachment` already cover the user need
  via the Attachments tab.
- `get_feature` — only useful if we add a Feature detail panel.

### Won't expose (server / agent only)

- **`wait_for_work`** — agent-side polling tool. Agents call it from
  their MCP loop. The IDE's equivalent is `listPendingPrompts` +
  toast/QuickPick, which is already wired.
- **`respond_to_prompt`** MCP tool — for the user→agent direction. The
  extension uses REST `PUT /prompts/{id}/respond` for the agent→user
  reply path (verified against
  `axiomcloud/handlers/vibeflow_prompts.go`). The MCP tool is correctly
  not exposed.
- **`session_init`, `session_register`, `session_heartbeat`,
  `clear_session_lock`, `acquire_poll_lock`, `release_poll_lock`** —
  agent-lifecycle plumbing. Not for the IDE.
- **`prompt_user`** — agent emits this to ask the human. The IDE
  receives it via the prompt list, doesn't call it.

### What "100% coverage" should mean

The PRD wording was aspirational. Honest target: **every MCP tool that
has a sensible UI surface has a client method, and every client method
has at least one caller.** Today we satisfy that for ~95% of the user-
facing surface. The remaining 5% (compliance UI, context UI, document
mutation UI) are gated on building those UIs first — wiring the client
method without a caller would be dead code.
