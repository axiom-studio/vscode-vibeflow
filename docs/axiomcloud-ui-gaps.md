# axiomcloud UI parity gaps

This document tracks features the vscode-vibeflow extension intentionally
does NOT mirror from axiomcloud, with the underlying backend constraint.
Updated as of 2026-05-03 against axiomcloud `main` (the
`/Users/dev/Projects/axiom/axiomcloud` working tree).

## Work-item detail panel

### Comments are not supported on todos / issues

axiomcloud `studio/src/Pages/Vibeflow/TodoDetail.jsx` and `IssueDetail.jsx`
render a `+ Comment` button for some statuses. Backing tool is
`mcp/vibeflow_tools.go::create_comment`, which delegates to
`database.VibeflowCommentEntityType.IsValid()`:

```go
type VibeflowCommentEntityType string
const (
    VibeflowCommentEntityDocument VibeflowCommentEntityType = "document"
    VibeflowCommentEntityContext  VibeflowCommentEntityType = "context"
)
func (e VibeflowCommentEntityType) IsValid() bool {
    return e == VibeflowCommentEntityDocument || e == VibeflowCommentEntityContext
}
```

Source: `axiomcloud/database/vibeflow_models.go:696-707`. The handler at
`mcp/vibeflow_tools.go::vibeflowCreateCommentHandler` rejects any
`entity_type` outside that pair with `"entity_type must be 'document' or
'context'"`.

**Effect:** The web `+ Comment` button on a todo/issue cannot reach the
backend either — it must be rendering against a different surface (or
silently failing). Re-investigate when axiomcloud extends the enum.

**Extension behavior:** No `+ Comment` button on the work-item panel.
Comments will appear on documents/contexts when those panels exist
(future work).

### No standalone Compliance Finding detail page

Compliance findings render only inline within the Logs → Security
Review sub-tab of a todo or issue. axiomcloud does not have a
`FindingDetail.jsx` or equivalent route. We mirror the inline-list
pattern.

### Security Verify / Security Reject buttons

The canonical web UI does NOT expose buttons for these — backend
handlers `verify_*_security` / `reject_*_security` exist but are only
triggered programmatically by agents. The extension keeps these
buttons as an "extension-only convenience action" for IDE-context
users who routinely want to approve security inline.

When `security_reviewed === true` we hide both buttons (the
verification has already been recorded — re-running adds no new state).

### Todos cannot Archive (web parity), but Delete works on both

axiomcloud's `IssueDetail.jsx` shows Archive + Delete in its toolbar;
`TodoDetail.jsx` shows neither. Backend supports both:

- `DELETE /rest/v1/vibeflow/todos/{id}` and `DELETE
  /rest/v1/vibeflow/issues/{id}` — both hard-delete (no soft-delete).
- "Archive" is a status transition to `archived` via
  `PATCH /rest/v1/vibeflow/{type}s/{id}/status`, available for both.

The extension surfaces Archive on issues only (web parity) and Delete
on both (technical capability + IDE-context users frequently want to
clean up stale todos without leaving the editor).

### Push to Jira / Retry Publish

axiomcloud surfaces these buttons gated on `jira_sync` state +
`jiraProjectLink` config. Out of scope until the extension acquires
its own Jira-sync UX.

## Backend dependencies needed for full parity

- Comments on todos/issues: extend `VibeflowCommentEntityType` to
  include `todo` and `issue` and update the IsValid()/handler logic.
- Compliance Finding standalone detail page: requires a dedicated
  axiomcloud frontend route first; not a pure backend gap.
- Session-scoped log endpoint: a `GET /sessions/{id}/logs` would let
  the Session focus panel skip the client-side claimed_by correlation
  in `SessionPanelManager.collectSessionLogs`.
