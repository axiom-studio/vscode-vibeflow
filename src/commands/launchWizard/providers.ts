import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isBinaryOnPath } from '../../utils/whichBinary.js';

export const PROVIDERS = [
  { label: '$(hubot) Claude', description: 'claude', value: 'claude' },
  { label: '$(code) Codex', description: 'codex', value: 'codex' },
  { label: '$(sparkle) Gemini', description: 'gemini', value: 'gemini' },
  { label: '$(terminal) Cursor', description: 'cursor', value: 'cursor' },
];

// Provider → CLI binary names. Mirrors `SettingsPanel.ts:392-398` (the same
// table the Setup tab uses to render its availability dots). Cursor ships
// as `cursor-agent` but some installers symlink it to `agent`; either name
// satisfies the gate. Aligns with vibeflow-cli's `ProviderRegistry`
// (`internal/vibeflowcli/provider.go:174-180 checkBinaryAvailable`).
export const PROVIDER_BINARIES: Record<string, string[]> = {
  claude: ['claude'],
  codex: ['codex'],
  gemini: ['gemini'],
  cursor: ['cursor-agent', 'agent'],
};

export function isProviderInstalled(provider: string): boolean {
  const names = PROVIDER_BINARIES[provider] ?? [provider];
  return names.some(n => isBinaryOnPath(n));
}

// Canonical name to print in user-facing error messages.
export function providerBinaryDisplayName(provider: string): string {
  return PROVIDER_BINARIES[provider]?.[0] ?? provider;
}

// Conservative minimum-length floor per env-token kind. Goal: trip on the
// "user pasted `abc123` / hit Enter on an empty box" path without rejecting
// the wide variety of real key formats (Google AI Studio keys are 39-char
// `AIza…`; gcloud-issued OAuth tokens are longer and start differently;
// MCP bearer tokens vary by provider). Floors are deliberately well below
// any plausible real-key length.
export const PROVIDER_KEY_RULES: Record<string, { minLength: number; hint: string }> = {
  GEMINI_API_KEY: { minLength: 20, hint: 'Real Gemini keys are typically 39 characters starting with "AIza".' },
  MCP_TOKEN: { minLength: 16, hint: 'Real MCP bearer tokens are at least 16 characters.' },
};

/**
 * Detect provider credentials configured outside the VS Code secret store.
 * Called when the user hits Enter on an empty env-token prompt — empty
 * input doesn't mean "no auth", it often means "I have auth set up
 * elsewhere (gcloud, shell rc, ~/.gemini/credentials)." Returning a
 * non-null source lets the wizard proceed without setting `envVars[envName]`;
 * the spawned terminal inherits parent-process env via the existing
 * `vscode.window.createTerminal({ env })` merge semantics, so a shell
 * `GEMINI_API_KEY` survives the launch.
 *
 * Existence-only check — does NOT validate that the credential actually
 * works. The agent binary fails fast at startup if the credential is
 * bad, which is detectable via the #2175 stall sweep.
 */
export function detectExternalAuth(envName: string): { source: string } | null {
  if (process.env[envName]) {
    return { source: `${envName} from your shell environment` };
  }
  if (envName === 'GEMINI_API_KEY') {
    const credPath = path.join(os.homedir(), '.gemini', 'credentials');
    if (fs.existsSync(credPath)) {
      return { source: '~/.gemini/credentials (local Gemini auth)' };
    }
  }
  return null;
}

export function validateProviderKey(envName: string, raw: string): { ok: true; value: string } | { ok: false; reason: string } {
  // Match vibeflow-cli's paste hygiene (`tui_wizard.go:851`
  // `strings.Trim(w.envTokenValue, "[]\"' ")`) — users frequently paste
  // keys with surrounding quotes/brackets from `.env` files or docs.
  const trimmed = raw.replace(/^[\s[\]'"]+|[\s[\]'"]+$/g, '');
  if (!trimmed) {
    return { ok: false, reason: 'Key is empty.' };
  }
  const rule = PROVIDER_KEY_RULES[envName];
  if (rule && trimmed.length < rule.minLength) {
    return { ok: false, reason: `That value is only ${trimmed.length} characters — too short to be a real key. ${rule.hint}` };
  }
  return { ok: true, value: trimmed };
}

// Build the PROVIDERS list with per-entry availability tagged in the
// description. Picking a flagged provider still triggers the post-pick
// abort below — the tag is informational so users see the constraint
// before picking. Mirrors vibeflow-cli's `Available()` filter pattern
// from `provider.go:81-88`, but renders unavailable rows instead of
// hiding them so the user understands why their preferred provider is
// missing rather than being silently presented a different list.
export function buildProvidersWithAvailability(): { label: string; description: string; value: string; available: boolean }[] {
  return PROVIDERS.map(p => {
    const available = isProviderInstalled(p.value);
    return {
      label: p.label,
      description: available ? p.description : `${p.description} · $(error) not installed`,
      value: p.value,
      available,
    };
  });
}
