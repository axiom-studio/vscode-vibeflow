#!/usr/bin/env node
// Regression guard for the cached-serverUrl HTTP leak (issue #1947).
//
// History: original fix commit 00c6041 ("v1.0.0: fix #1947 cached-serverUrl
// HTTPS gap") added three layers of defense. Commit e0ef3ad ("fix",
// 2026-05-08 06:24:32 — 17 min later) silently deleted two of them while
// bundling unrelated feature work. QA-rejected this issue on 2026-05-13.
// This script runs as part of `yarn build` and refuses to build if any of
// the three layers is missing again, so the next sloppy `fix` cannot land
// without CI noise.
//
// If you're modifying any of these files and this script trips, the right
// move is NOT to weaken the assertions — read the issue #1947 QA log first.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const failures = [];

function check(file, label, pattern) {
  const content = readFileSync(resolve(ROOT, file), 'utf8');
  if (!pattern.test(content)) {
    failures.push(`  ❌ ${file}: missing ${label}`);
  }
}

// Layer 1 — activation preflight in extension.ts. Must validate the cached
// serverUrl AND gate tryAutoConnect on the result. Anchor on the variable
// name `cachedServerUrl` to defend against a partial revert that keeps the
// import but drops the call site.
check(
  'src/extension.ts',
  'Layer 1 activation preflight (validateServerUrl(cachedServerUrl) + gated tryAutoConnect)',
  /validateServerUrl\(\s*cachedServerUrl\s*\)[\s\S]{0,1200}await\s+tryAutoConnect\s*\(\s*\)/,
);

// Layer 2 — live-read + validateServerUrl inside VibeFlowClient.request().
// Anchor on the validator call AND the live-read fetch (so a revert that
// imports the validator but keeps the cached this.baseUrl fetch still trips).
check(
  'src/api/client.ts',
  'Layer 2 validator import',
  /import\s*\{\s*validateServerUrl\s*\}\s*from\s*['"]\.\.\/auth\/serverUrl\.js['"]/,
);
check(
  'src/api/client.ts',
  'Layer 2 request-time validateServerUrl call',
  /private\s+async\s+request[\s\S]{0,1500}validateServerUrl\s*\(/,
);
check(
  'src/api/client.ts',
  'Layer 2 live-URL fetch (must not silently fall back to this.baseUrl)',
  /fetch\s*\(\s*`\$\{liveUrl\}/,
);

// Layer 3 — validateServerUrl call inside VibeFlowMcpClient.connect().
check(
  'src/api/mcpClient.ts',
  'Layer 3 MCP transport validation',
  /async\s+connect[\s\S]{0,1200}validateServerUrl\s*\(/,
);

// --- Issue #2084 Regression Guards (Clickable chat hashes/paths) ---

// Guard 4 — MessageBubble overrides markdown components to call the
// local `enhance` helper (which threads the host-validated `validity`
// lookup into enhanceLeafText). #2341 replaced the direct
// `enhanceLeafText(children, chatTokenDispatch)` call with `enhance(children)`
// so a single signature change can't desync the 13 override sites.
check(
  'webview-ui/src/components/sessionChat/MessageBubble.tsx',
  'Issue #2084 MessageBubble markdown component overrides (enhance helper)',
  /p\(\{ children, \.\.\.props \}\) \{\s*return <p \{\.\.\.props\}>\{enhance\(children\)\}<\/p>;\s*\}/,
);
// Guard 4b — and the helper itself routes through enhanceLeafText with
// the dispatch + validity, so a "rename enhance to noop" regression
// trips this assertion (the dispatch reference name is the load-bearing
// invariant for #2084 — without it, click handlers don't postMessage).
check(
  'webview-ui/src/components/sessionChat/MessageBubble.tsx',
  'Issue #2341 enhance helper threads dispatch + validity into enhanceLeafText',
  /const\s+enhance\s*=\s*\(children:\s*ReactNode\)\s*=>\s*enhanceLeafText\(children,\s*chatTokenDispatch,\s*validity\)/,
);

// Guard 5 — chatTokenDispatch emits postMessages to host.
check(
  'webview-ui/src/components/sessionChat/MessageBubble.tsx',
  'Issue #2084 chatTokenDispatch postMessage (chatOpenCommit)',
  /openCommit\(hash\) \{\s*getVsCodeApi\(\)\.postMessage\(\{ type: 'chatOpenCommit', payload: \{ hash \} \}\);\s*\}/,
);
check(
  'webview-ui/src/components/sessionChat/MessageBubble.tsx',
  'Issue #2084 chatTokenDispatch postMessage (chatOpenPath)',
  /openPath\(path, line, column\) \{\s*getVsCodeApi\(\)\.postMessage\(\{ type: 'chatOpenPath', payload: \{ path, line, column \} \}\);\s*\}/,
);

// --- Issue #2334 Regression Guards (Backticked hashes/paths) ---

// Guard 33 — MessageBubble code override tokenizes inline code via
// the same `enhance` helper used by the prose overrides (post-#2341).
check(
  'webview-ui/src/components/sessionChat/MessageBubble.tsx',
  'Issue #2334 MessageBubble code component override (enhance helper)',
  /if\s*\(\!lang\)\s*\{[\s\S]{0,100}return\s+<code[\s\S]{0,100}enhance\(children\)/
);

// Guard 6 — chatTokens exports enhanceLeafText and scanString.
check(
  'webview-ui/src/components/sessionChat/chatTokens.tsx',
  'Issue #2084 chatTokens export enhanceLeafText',
  /export\s+function\s+enhanceLeafText/,
);

// --- Issue #1701 Regression Guards (CLI auto-installer) ---

// Guard 47 — package.json registers vibeflow.installCli command.
check(
  'package.json',
  'Issue #1701 installCli command',
  /"command":\s*"vibeflow\.installCli"/
);

// Guard 48 — cliInstaller.ts uses HTTPS hostname allowlist for GitHub.
check(
  'src/commands/cliInstaller.ts',
  'Issue #1701 hostname allowlist',
  /githubusercontent\.com/
);

// Guard 49 — cliInstaller.ts enforces 100MB sanity cap.
check(
  'src/commands/cliInstaller.ts',
  'Issue #1701 MAX_DOWNLOAD_BYTES cap',
  /const\s+MAX_DOWNLOAD_BYTES\s*=\s*100\s*\*\s*1024\s*\*\s*1024;/
);

// --- Issue #1972 Regression Guard (Shared mentionParser) ---

// Guard 53 — webview mentionParser re-exports from host canonical.
check(
  'webview-ui/src/components/sessionChat/mentionParser.ts',
  'Issue #1972 webview mentionParser re-export',
  /export\s+\{[\s\S]{0,200}\}\s+from\s+'\.\.\/\.\.\/\.\.\/\.\.\/src\/views\/sessions\/mentionParser'/
);

// --- Issue #1971 Regression Guards (Test infrastructure) ---

// Guard 50 — vitest.config.ts uses vscode stub alias.
check(
  'vitest.config.ts',
  'Issue #1971 vitest vscode stub alias',
  /vscode:\s*path\.resolve\(__dirname,\s*'src\/__test_stubs__\/vscode\.ts'\)/
);

// Guard 51 — vitest.config.ts includes src/**/*.test.ts.
check(
  'vitest.config.ts',
  'Issue #1971 vitest include pattern',
  /include:\s*\[\s*'src\/\*\*\/\*\.test\.ts'\s*\]/
);

// Guard 52 — package.json has test and test:coverage scripts.
check(
  'package.json',
  'Issue #1971 test scripts',
  /"test":\s*"vitest\s+run"/
);
check(
  'package.json',
  'Issue #1971 test:coverage script',
  /"test:coverage":\s*"vitest\s+run\s+--coverage"/
);

// --- Issue #2174 Regression Guards (Launch wizard preflight) ---

// Guard 7 — launchSession clears binary cache and gates on provider availability.
check(
  'src/commands/sessionCommands.ts',
  'Issue #2174 launchSession clearWhichBinaryCache call',
  /clearWhichBinaryCache\(\)/,
);
check(
  'src/commands/sessionCommands.ts',
  'Issue #2174 launchSession provider availability gate',
  /if\s*\(\!provider\.available\)\s*\{[\s\S]{0,100}vscode\.window\.showErrorMessage/,
);

// Guard 8 — validateProviderKey trims characters and checks minLength.
check(
  'src/commands/launchWizard/providers.ts',
  'Issue #2174 validateProviderKey implementation',
  /const\s+trimmed\s*=\s*raw\.replace\(\/\^\[\\s\[\\\]'"\]\+\|\[\\s\[\\\]'"\]\+\$\/g,\s*''\)/,
);
check(
  'src/commands/launchWizard/providers.ts',
  'Issue #2174 PROVIDER_KEY_RULES thresholds',
  /GEMINI_API_KEY: \{ minLength: 20/,
);

// --- Issue #2175 Regression Guards (Agent Fleet stall detector) ---

// Guard 9 — SessionsTreeProvider defines PENDING_STALL_THRESHOLD_MS = 120s.
check(
  'src/views/sessions/SessionsTreeProvider.ts',
  'Issue #2175 PENDING_STALL_THRESHOLD_MS constant',
  /const\s+PENDING_STALL_THRESHOLD_MS\s*=\s*120_?000;/,
);

// Guard 10 — fetchAndRefresh runs the stall sweep.
check(
  'src/views/sessions/SessionsTreeProvider.ts',
  'Issue #2175 fetchAndRefresh stall sweep loop',
  /for\s*\(const\s+pending\s+of\s+this\.pendingSessions\.values\(\)\)\s*\{[\s\S]{0,100}if\s*\(pending\.state\s*!==\s*'starting'\)\s*\{/,
);
check(
  'src/views/sessions/SessionsTreeProvider.ts',
  'Issue #2175 stall threshold check',
  /if\s*\(now\s*-\s*pending\.startedAt\s*<=\s*PENDING_STALL_THRESHOLD_MS\)\s*\{\s*continue;\s*\}[\s\S]{0,100}state:\s*'failed'/,
);

// --- Issue #2178 Regression Guards (Cancel starting session) ---

// Guard 11 — SessionStreamRegistry implements killByHandleId.
check(
  'src/sessions/SessionStreamRegistry.ts',
  'Issue #2178 SessionStreamRegistry.killByHandleId',
  /killByHandleId\(handleId:\s*string\):/
);

// Guard 12 — extension.ts registers cancelStartingPending.
check(
  'src/extension.ts',
  'Issue #2178 extension.ts cancelStartingPending registration',
  /vscode\.commands\.registerCommand\(\s*'vibeflow\.cancelStartingPending'/
);

// Guard 13 — package.json menu entries for pendingSessionStarting.
check(
  'package.json',
  'Issue #2178 package.json pendingSessionStarting menu entry',
  /viewItem\s*==\s*pendingSessionStarting/
);

// --- Issue #2179 Regression Guards (External auth detection) ---

// Guard 14 — detectExternalAuth checks multiple credential paths for Gemini.
check(
  'src/commands/launchWizard/providers.ts',
  'Issue #2179 detectExternalAuth Gemini paths',
  /gcloud[\s\S]{0,100}application_default_credentials\.json/
);
check(
  'src/commands/launchWizard/providers.ts',
  'Issue #2179 detectExternalAuth gemini credentials path',
  /\.gemini[\s\S]{0,50}credentials/
);

// Guard 15 — launchSession calls detectExternalAuth.
check(
  'src/commands/sessionCommands.ts',
  'Issue #2179 launchSession detectExternalAuth usage',
  /const\s+external\s*=\s*detectExternalAuth\(/
);

// --- Issue #2181 Regression Guards (CLI PID lock) ---

// Guard 16 — getRunningCliPid checks ~/.vibeflow-cli/vibeflow.pid.
check(
  'src/commands/cliCommands.ts',
  'Issue #2181 getRunningCliPid path',
  /\.vibeflow-cli[\s\S]{0,20}vibeflow\.pid/
);

// Guard 17 — openCli uses getRunningCliPid to detect external instances.
check(
  'src/commands/cliCommands.ts',
  'Issue #2181 openCli external PID check',
  /const\s+externalPid\s*=\s*getRunningCliPid\(\)/
);

// --- Issue #2301 Regression Guards (Chat upload category) ---

// Guard 21 — SessionPanelManager uses 'general' category for chat uploads.
check(
  'src/views/sessions/SessionPanelManager.ts',
  'Issue #2301 handleChatUploadAsset category',
  /this\.client\.uploadAttachment\(\s*'project'[\s\S]{0,1200}'general',/
);

// Guard 22 — annotateChatTextForAgent uses accurate agent-facing instructions.
check(
  'src/views/sessions/SessionPanelManager.ts',
  'Issue #2301 annotateChatTextForAgent guide text',
  /Agents: fetch via the \\`list_attachments\\` MCP tool with entity_type='project'/
);

// --- Issue #2302 Regression Guards (Chat upload ID source) ---

// Guard 23 — SessionPanelManager reads attachment_id from upload response.
check(
  'src/views/sessions/SessionPanelManager.ts',
  'Issue #2302 handleChatUploadAsset assetId resolution',
  /const\s+assetId\s*=\s*attachment\.attachment_id\s*\?\?\s*attachment\.asset\?\.id;/
);

// --- Issue #2303 Regression Guards (Chat poll updates) ---

// Guard 24 — ChatCursor tracks pendingIds.
check(
  'src/views/sessions/SessionPanelManager.ts',
  'Issue #2303 ChatCursor pendingIds field',
  /pendingIds:\s*Set<number>/
);

// Guard 25 — pollChatUpdates re-fetches window if pendingIds is non-empty.
check(
  'src/views/sessions/SessionPanelManager.ts',
  'Issue #2303 pollChatUpdates pending re-fetch',
  /if\s*\(cursor\.pendingIds\.size\s*>\s*0\)\s*\{[\s\S]{0,100}this\.client\.listSessionPrompts\(/
);

// Guard 26 — SessionChatView.tsx upserts messages in mergeAppend.
check(
  'webview-ui/src/components/SessionChatView.tsx',
  'Issue #2303 mergeAppend upsert logic',
  /incoming\.map\(p\s*=>\s*\[p\.id,\s*p\]\)[\s\S]{0,100}prev\.map\(p\s*=>\s*\{[\s\S]{0,100}incomingById\.get\(p\.id\)/
);

// --- Issue #2329 Regression Guards (Mode-aware session rail) ---

// Guard 37 — SessionChatView.tsx adds no-rail class in chat-first mode.
check(
  'webview-ui/src/components/SessionChatView.tsx',
  'Issue #2329 no-rail class logic',
  /className=\{`session-chat-root\$\{railOpen\s*\?\s*''\s*:\s*'\s*rail-collapsed'\}\$\{[\s\S]{0,50}meta\.sessionMode\s*===\s*'chat_first'\s*\?\s*'\s*no-rail'\s*:\s*''\s*\}`\}/
);

// --- Issue #2330 Regression Guards (Chat input lag fixes) ---

// Guard 39 — MessageBubble.tsx memoizes the component.
check(
  'webview-ui/src/components/sessionChat/MessageBubble.tsx',
  'Issue #2330 MessageBubble memoization',
  /export\s+const\s+MessageBubble\s*=\s*memo\(MessageBubbleImpl\);/
);

// --- Issue #2333 Regression Guard (Hidden agent footer) ---

// Guard 42 — MessageBubble.tsx defines and uses stripAgentFooter.
check(
  'webview-ui/src/components/sessionChat/MessageBubble.tsx',
  'Issue #2333 stripAgentFooter implementation',
  /function\s+stripAgentFooter\(text:\s*string\):\s*string\s*\{\s*return\s+text\.replace\(\/\\n\\n_Agents:\s+\.\*_\\s\*\$\/,\s*''\);/
);

// Guard 40 — SessionChatView.tsx uses useDeferredValue for messages.
check(
  'webview-ui/src/components/SessionChatView.tsx',
  'Issue #2330 useDeferredValue usage',
  /const\s+deferredMessages\s*=\s*useDeferredValue\(messages\);/
);

// Guard 41 — SessionChatView.tsx debounces chatMentionQuery.
check(
  'webview-ui/src/components/SessionChatView.tsx',
  'Issue #2330 mention query debounce',
  /setTimeout\(\(\)\s*=>\s*\{[\s\S]{0,200}type:\s*'chatMentionQuery'/
);

// Guard 38 — sessionChat.css collapses grid when no-rail class is present.
check(
  'webview-ui/src/components/sessionChat/sessionChat.css',
  'Issue #2329 no-rail grid collapse',
  /\.session-chat-root\.no-rail\s*\{\s*grid-template-columns:\s*1fr;/
);

// --- Issue #1659 Regression Guards (Session Chat polish) ---

// Guard 59 — SessionChatView.tsx uses PaperPlaneIcon in send button.
check(
  'webview-ui/src/components/SessionChatView.tsx',
  'Issue #1659 PaperPlaneIcon usage',
  /<PaperPlaneIcon\s+size=\{13\}\s*\/>/
);

// Guard 60 — sessionChat.css defines .divider for header.
check(
  'webview-ui/src/components/sessionChat/sessionChat.css',
  'Issue #1659 header divider',
  /\.divider\s*\{[\s\S]{0,50}width:\s*1px;/
);

// --- Issue #2325 Regression Guards (Markdown table styling) ---

// Guard 31 — sessionChat.css styles tables in both user prompts and agent responses.
check(
  'webview-ui/src/components/sessionChat/sessionChat.css',
  'Issue #2325 table styling selectors',
  /\.msg-content\s+table,\s*\.msg-response\s+table/
);

// --- Issue #2341 Regression Guards (Validate-with-reality token gate) ---
// Replaces the #2326 RE_COMMIT-tightening guard: the lookaround ban
// was deleted along with `RE_PATH_VIBEFLOW_DOC_BLOCKLIST` (#2329)
// once host-side `git cat-file` + `workspace.fs.stat` validation
// became the source of truth. Both old hacks were existence
// heuristics; validation answers existence directly. Guard the
// REPLACEMENT pipeline instead, so a regression that drops the
// validation handler reintroduces the original UX bugs (URL.hostname
// matched, hyphen-prefixed hashes silently dropped) AND trips CI.

// Guard 32a — webview emits the validation request.
check(
  'webview-ui/src/components/sessionChat/chatTokenValidation.ts',
  'Issue #2341 chatValidateTokens postMessage',
  /type:\s*'chatValidateTokens'/,
);

// Guard 32b — host has a case for it.
check(
  'src/views/sessions/SessionPanelManager.ts',
  'Issue #2341 chatValidateTokens host handler',
  /case\s+'chatValidateTokens'/,
);

// Guard 32c — validateHashes uses `git cat-file --batch-check`
// (filters by type==='commit'), not a wider `git rev-parse` which
// would accept tags / refs / branch tips as well.
check(
  'src/views/sessions/chatActions.ts',
  'Issue #2341 validateHashes uses cat-file commit-only filter',
  /git[\s\S]{0,200}cat-file[\s\S]{0,300}type\s*===\s*'commit'/,
);

// --- Issue #1662 Regression Guard (Dashboard SummaryCard chrome) ---

// Guard 43 — SummaryCard restores borders and background (rollback of #1660).
check(
  'webview-ui/src/components/DashboardView.tsx',
  'Issue #1662 SummaryCard restored chrome',
  /background:\s*'var\(--vscode-editor-background\)',[\s\S]{0,100}border:\s*isHero[\s\S]{0,100}1px\s+solid/
);

// --- Issue #1658 Regression Guard (Dashboard polish) ---

// Guard 58 — SummaryCard uses tabular-nums for numeric values.
check(
  'webview-ui/src/components/DashboardView.tsx',
  'Issue #1658 tabular-nums usage',
  /fontVariantNumeric:\s*'tabular-nums'/
);

// --- Issue #1660 Regression Guard (Dashboard bento layout) ---

// Guard 61 — index.css defines the 2-tier bento layout.
check(
  'webview-ui/src/index.css',
  'Issue #1660 dashboard-bento areas',
  /grid-template-areas:[\s\S]{0,100}"sessions\s+sessions\s+sessions\s+work\s+work\s+work"[\s\S]{0,100}"commits\s+commits\s+lines\s+lines\s+time\s+time"/
);

// --- Issue #1671 Regression Guards (Compliance View) ---

// Guard 56 — index.css defines .shimmer skeleton animation.
check(
  'webview-ui/src/index.css',
  'Issue #1657 shimmer keyframe',
  /@keyframes\s+shimmer-sweep/
);
check(
  'webview-ui/src/index.css',
  'Issue #1657 shimmer class',
  /\.shimmer\s*\{[\s\S]{0,100}animation:\s*shimmer-sweep/
);

// --- Issue #1663 Regression Guard (Dashboard topology reimagining) ---

// Guard 62 — index.css defines .persona-pulse breathing halo.
check(
  'webview-ui/src/index.css',
  'Issue #1663 persona-pulse keyframe',
  /@keyframes\s+persona-pulse/
);
check(
  'webview-ui/src/index.css',
  'Issue #1663 persona-pulse class',
  /\.persona-pulse\s*\{[\s\S]{0,100}animation:\s*persona-pulse/
);

// Guard 57 — _shared/icons.tsx exists and defines BoltIcon.
check(
  'webview-ui/src/components/_shared/icons.tsx',
  'Issue #1657 shared icons',
  /export\s+function\s+BoltIcon/
);

// --- Issue #1671 Regression Guards (Compliance View) ---

// Guard 44 — package.json registers vibeflow.openCompliance command.
check(
  'package.json',
  'Issue #1671 openCompliance command',
  /"command":\s*"vibeflow\.openCompliance"/
);

// Guard 45 — CompliancePanel.ts implements composeSnapshot with parallel REST calls.
check(
  'src/views/compliance/CompliancePanel.ts',
  'Issue #1671 composeSnapshot parallel fetch',
  /await\s+Promise\.allSettled\(\[\s*client\.listComplianceFindings\(projectId\),/
);

// Guard 46 — ComplianceView.tsx renders the summary and findings table.
check(
  'webview-ui/src/components/ComplianceView.tsx',
  'Issue #1671 ComplianceView render logic',
  /export\s+function\s+ComplianceView/
);
check(
  'webview-ui/src/components/ComplianceView.tsx',
  'Issue #1671 Framework summary cards',
  /function\s+FrameworkRow[\s\S]{0,1000}cards\.map\(card\s*=>/
);

// --- Issue #1701 Regression Guards (CLI auto-installer) ---

// Guard 47 — package.json registers vibeflow.installCli command.
check(
  'package.json',
  'Issue #1701 installCli command',
  /"command":\s*"vibeflow\.installCli"/
);

// Guard 48 — cliInstaller.ts uses HTTPS hostname allowlist for GitHub.
check(
  'src/commands/cliInstaller.ts',
  'Issue #1701 hostname allowlist',
  /githubusercontent\.com/
);

// Guard 49 — cliInstaller.ts enforces 100MB sanity cap.
check(
  'src/commands/cliInstaller.ts',
  'Issue #1701 MAX_DOWNLOAD_BYTES cap',
  /const\s+MAX_DOWNLOAD_BYTES\s*=\s*100\s*\*\s*1024\s*\*\s*1024;/
);

// --- Issue #2306 Regression Guards (Headless default backing) ---

// Guard 27 — resolveHeadlessBacking prefers tmux on 'auto'.
check(
  'src/commands/sessionCommands.ts',
  'Issue #2306 resolveHeadlessBacking tmux preference',
  /if\s*\(setting\s*===\s*'vscode'\)\s*\{\s*return\s*'vscode';\s*\}[\s\S]{0,1200}detectTmuxAvailability\(/
);

// Guard 28 — Settings UI reflects the new Auto semantic.
check(
  'package.json',
  'Issue #2306 package.json Auto description',
  /tmux\s+when\s+available\s+\(Mac\s*\/\s*Linux\s+with\s+tmux\s+installed\)/
);

// --- Issue #2182 Regression Guards (Walkthrough polish) ---

// Guard 34 — Walkthrough Welcome step has onLink completion event and correct URL.
check(
  'package.json',
  'Issue #2182/2180 walkthrough Welcome step (URL + completionEvent)',
  /"id":\s*"welcome"[\s\S]{0,500}https:\/\/axiomstudio\.ai\/vibeflow[\s\S]{0,500}"completionEvents":\s*\[\s*"onLink:https:\/\/axiomstudio\.ai\/vibeflow"/
);

// Guard 35 — Walkthrough Explore step uses a markdown bullet list.
check(
  'package.json',
  'Issue #2182 walkthrough Explore markdown list',
  /"id":\s*"explore"[\s\S]{0,500}- \*\*Agent Fleet\*\*[\s\S]{0,100}- \*\*Work Items\*\*[\s\S]{0,100}- \*\*Activity Feed\*\*[\s\S]{0,100}- \*\*Documents\*\*/
);

// --- Issue #2183 Regression Guard (Marketplace description) ---

// Guard 36 — package.json description is outcome-first and fits 145 chars.
check(
  'package.json',
  'Issue #2183 punchy marketplace description',
  /"description":\s*"Ship\s+faster\s+with\s+a\s+full\s+AI\s+engineering\s+team\s+—\s+Developer,\s+Architect,\s+QA,\s+Security,\s+and\s+PM\s+agents\s+that\s+know\s+your\s+codebase\s+and\s+do\s+the\s+work\."/
);

// --- Issue #1982 Regression Guards (User documentation suite) ---

// Guard 54 — README.md has a pointer to the user guide index.
check(
  'README.md',
  'Issue #1982 user guide pointer',
  /##\s+Full\s+user\s+guide[\s\S]{0,100}docs\/user-guide\/README\.md/
);

// Guard 55 — User guide index exists and links to all 8 docs.
check(
  'docs/user-guide/README.md',
  'Issue #1982 user guide index',
  /#\s+VibeFlow\s+for\s+VS\s+Code\s+User\s+Guide/
);

// --- Issue #2324 Regression Guards (Tmux session reuse) ---

// Guard 29 — launchSession checks for existing tmux sessions.
check(
  'src/commands/sessionCommands.ts',
  'Issue #2324 tmux session existence check',
  /if\s*\(await\s+tmuxBacking\.hasSession\(tmuxName\)\)\s*\{[\s\S]{0,100}vscode\.window\.showInformationMessage/
);

// Guard 30 — launchSession provides instructions to kill existing session.
check(
  'src/commands/sessionCommands.ts',
  'Issue #2324 tmux session reuse message',
  /Reusing\s+existing\s+[\s\S]{0,100}session\s+in\s+tmux/
);

// --- Issue #2184 Regression Guards (MCP token source) ---

// Guard 18 — ensureMcpConfig sources token from client.getToken() primarily.
check(
  'src/commands/launchWizard/mcpConfig.ts',
  'Issue #2184 ensureMcpConfig primary token source',
  /token\s*=\s*client\.getToken\(\);/
);

// Guard 19 — ensureMcpConfig fallback to CLI config.
check(
  'src/commands/launchWizard/mcpConfig.ts',
  'Issue #2184 ensureMcpConfig fallback token source',
  /\.vibeflow-cli[\s\S]{0,20}config\.yaml/
);

// Guard 20 — VibeFlowClient exports getToken().
check(
  'src/api/client.ts',
  'Issue #2184 VibeFlowClient.getToken implementation',
  /getToken\(\)[\s\S]{0,50}\{\s*return\s+this\.auth\.getToken\(\);/
);

// --- Issue #2340 Regression Guard (Gemini bearer-token gitignore) ---

// Guard 21 — .gitignore must ignore `.gemini/` so the gemini-side tool
// config (which contains an Authorization: Bearer <jwt> to the vibeflow
// MCP endpoint) cannot be accidentally committed by `git add -A` or an
// auto-staging tool. Mirrors the .mcp.json rule for the claude side.
check(
  '.gitignore',
  'Issue #2340 .gemini/ gitignored (gemini-side MCP bearer token)',
  /^\.gemini(\/|$)/m,
);

if (failures.length > 0) {
  console.error('Security-guard regression detected (issue #1947):');
  for (const f of failures) console.error(f);
  console.error('\nSee issue #1947 in vibeflow for the full QA log.');
  console.error('Original fix: commit 00c6041. Silently reverted by: e0ef3ad.');
  process.exit(1);
}

console.log('[check-security-guards] ok — all #1657, #1658, #1659, #1660, #1662, #1663, #1671, #1701, #1947, #1971, #1972, #1982, #2084, #2174, #2175, #2178, #2179, #2180, #2181, #2182, #2183, #2184, #2301, #2302, #2303, #2306, #2324, #2325, #2326, #2329, #2330, #2333, #2334, #2340, and #2341 defense layers present.');
