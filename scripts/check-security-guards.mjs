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

// --- Issue #2340 Regression Guard (Gemini bearer-token gitignore) ---

// Guard — .gitignore must ignore `.gemini/` so the gemini-side tool
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

console.log('[check-security-guards] ok — all three #1947 defense layers + #2340 present.');
