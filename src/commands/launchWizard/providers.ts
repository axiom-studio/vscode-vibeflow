import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  launchableProviders,
  isProviderInstalled,
  providerBinaryDisplayName,
} from '../../providers/registry.js';

// The provider list, the binary-name table and the two availability helpers
// all used to live here as hand-maintained copies. They now derive from
// `providers/registry.ts` — see that module for why (issue #4633). Re-exported
// so existing callers are unaffected.
export { isProviderInstalled, providerBinaryDisplayName };

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
    // Gemini auth lives in several places depending on how the user
    // logged in — accept any of them.
    const home = os.homedir();
    // 1. `gemini auth login` writes here.
    const geminiCredPath = path.join(home, '.gemini', 'credentials');
    if (fs.existsSync(geminiCredPath)) {
      return { source: '~/.gemini/credentials (local Gemini auth)' };
    }
    // 2. `gcloud auth application-default login` (ADC) writes here.
    //    Our pre-1.0.3 detect missed this even though the error message
    //    explicitly told users to run that command — confusing.
    //    User-reported via agent-prompt 8db1893f (2026-05-24).
    const gcloudAdcPath = path.join(home, '.config', 'gcloud', 'application_default_credentials.json');
    if (fs.existsSync(gcloudAdcPath)) {
      return { source: '~/.config/gcloud/application_default_credentials.json (gcloud ADC)' };
    }
    // 3. `gcloud auth login` writes legacy creds here. Less common for
    //    new users but still works for some setups.
    const gcloudLegacyDir = path.join(home, '.config', 'gcloud', 'legacy_credentials');
    if (fs.existsSync(gcloudLegacyDir)) {
      return { source: '~/.config/gcloud/legacy_credentials (gcloud legacy auth)' };
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

// Build the launchable-provider list with per-entry availability tagged in
// the description. Picking a flagged provider still triggers the post-pick
// abort below — the tag is informational so users see the constraint
// before picking. Mirrors vibeflow-cli's `Available()` filter pattern
// from `provider.go:81-88`, but renders unavailable rows instead of
// hiding them so the user understands why their preferred provider is
// missing rather than being silently presented a different list.
export function buildProvidersWithAvailability(): { label: string; description: string; value: string; available: boolean }[] {
  return launchableProviders().map(p => {
    const available = isProviderInstalled(p.key);
    return {
      label: p.label,
      description: available ? p.key : `${p.key} · $(error) not installed`,
      value: p.key,
      available,
    };
  });
}
