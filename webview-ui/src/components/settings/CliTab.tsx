import * as React from 'react';
import { useEffect, useState } from 'react';
import type { SettingsData, SettingsCommand } from './settingsTypes';

interface Props {
  data: SettingsData;
  onUpdate: (key: string, value: unknown) => void;
  onCommand: (cmd: SettingsCommand) => void;
}

const RELEASES_URL = 'https://github.com/axiom-studio/vibeflow-cli/releases/latest';
const INSTALL_DOCS_URL = 'https://github.com/axiom-studio/vibeflow-cli#installation';

/**
 * "CLI Interface" — toggle a TUI-driven mode. When enabled, session
 * management is delegated to the vibeflow CLI in a fullscreen editor
 * terminal; the left sidebar (Agent Fleet, Work Items, Documents)
 * keeps polling the same backend so the user still sees live state.
 *
 * The toggle just flips the config; the actual gating happens in
 * extension.ts (launchSession short-circuits to openCli) and via
 * `when: config.vibeflow.cli.enabled` clauses in package.json menus.
 */
export function CliTab({ data, onUpdate, onCommand }: Props) {
  const installed = data.cliInstalled;
  const mcpNameRef = React.useRef(data.cliMcpName);
  const rootPathRef = React.useRef(data.cliRootPath);
  const [clearToken, setClearToken] = useState(0);

  React.useEffect(() => {
    mcpNameRef.current = data.cliMcpName;
  }, [data.cliMcpName]);

  React.useEffect(() => {
    rootPathRef.current = data.cliRootPath;
  }, [data.cliRootPath]);

  const clearLaunchOptions = () => {
    mcpNameRef.current = '';
    rootPathRef.current = '';
    setClearToken(token => token + 1);
    onUpdate('cli.mcpName', '');
    onUpdate('cli.rootPath', '');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <Card
        title="Use VibeFlow CLI"
        description="When enabled, session launches open the VibeFlow CLI (TUI) in a fullscreen editor terminal instead of spawning per-persona terminals from the extension. The left sidebar still shows live agent state — same backend, different lens."
      >
        <Toggle
          checked={data.cliEnabled}
          onChange={(v) => onUpdate('cli.enabled', v)}
          label={data.cliEnabled ? 'Enabled' : 'Disabled'}
        />
        {data.cliEnabled && !installed && (
          <Banner kind="warning">
            <strong>vibeflow binary not found.</strong> Install the latest prebuilt binary in one
            click — we download the matching asset from GitHub Releases into the extension's
            local storage and wire its path into <code>vibeflow.cli.binaryPath</code> for you.
            <ButtonRow>
              <Btn
                label="Install Latest"
                onClick={() => onCommand({ type: 'runCommand', payload: 'vibeflow.installCli' })}
              />
              <LinkBtn href={RELEASES_URL} label="Download Manually" secondary />
              <LinkBtn href={INSTALL_DOCS_URL} label="Install Instructions" secondary />
            </ButtonRow>
          </Banner>
        )}
      </Card>

      <Card
        title="Binary Path Override"
        description="Optional — leave empty to use PATH lookup. Set this if vibeflow is installed in a non-standard location and PATH doesn't include it (common for Homebrew on Apple Silicon under /opt/homebrew/bin)."
      >
        <BinaryPathInput
          initial={data.cliBinaryPath}
          onCommit={(v) => onUpdate('cli.binaryPath', v)}
        />
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--feed-muted)' }}>
          Status: {installed ? (
            <span style={{ color: 'var(--feed-success)' }}>● binary detected{data.cliVersion ? ` · v${data.cliVersion}` : ''}</span>
          ) : data.cliBinaryPathStale ? (
            <span style={{ color: 'var(--feed-error)' }}>● configured path not found: {data.cliBinaryPathStale} — fix it with Browse… or Install Latest</span>
          ) : (
            <span style={{ color: 'var(--feed-error)' }}>● not found</span>
          )}
        </div>
        <ButtonRow>
          <Btn
            label="Browse…"
            secondary
            onClick={() => onCommand({ type: 'runCommand', payload: 'vibeflow.browseCliBinary' })}
          />
          <Btn
            label="Install Latest"
            onClick={() => onCommand({ type: 'runCommand', payload: 'vibeflow.installCli' })}
          />
          <Btn
            label="Check for Updates"
            secondary
            disabled={!installed}
            onClick={() => onCommand({ type: 'runCommand', payload: 'vibeflow.checkCliUpdate' })}
          />
        </ButtonRow>
        <div style={{ marginTop: 6, fontSize: 10.5, color: 'var(--feed-muted)', lineHeight: 1.5 }}>
          Downloads the matching prebuilt asset from GitHub Releases, extracts it into the
          extension's local storage, and points the path above at the result. Re-run any time
          to upgrade.
        </div>
      </Card>

      <Card
        title="Open VibeFlow CLI"
        description="Launches the TUI in a fullscreen editor-area terminal. Re-running focuses the existing terminal (one TUI process at a time — the CLI's own PID lock enforces this)."
      >
        <Field label="MCP name">
          <BufferedTextInput
            initial={data.cliMcpName}
            placeholder="default"
            resetToken={clearToken}
            onValueChange={(v) => { mcpNameRef.current = v; }}
            onCommit={(v) => onUpdate('cli.mcpName', v)}
          />
        </Field>
        <Field label="Root path">
          <BufferedTextInput
            initial={data.cliRootPath}
            placeholder="/path/to/root"
            resetToken={clearToken}
            onValueChange={(v) => { rootPathRef.current = v; }}
            onCommit={(v) => onUpdate('cli.rootPath', v)}
          />
        </Field>
        <div style={{ marginTop: 6, marginBottom: 12, fontSize: 10.5, color: 'var(--feed-muted)', lineHeight: 1.5 }}>
          Blank fields are omitted. Provided values are passed as <code>--mcp</code> and <code>--root</code>.
        </div>
        <ButtonRow>
          <Btn
            label="Clear"
            secondary
            onClick={clearLaunchOptions}
          />
          <Btn
            label="Open CLI"
            onClick={() => onCommand({
              type: 'openCli',
              payload: {
                mcpName: mcpNameRef.current,
                rootPath: rootPathRef.current,
              },
            })}
            disabled={!installed}
          />
        </ButtonRow>
      </Card>

      <Card
        title="What changes when CLI mode is on?"
        description=""
      >
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.7, color: 'var(--feed-fg)' }}>
          <li>The Agent Fleet "Launch Session" button → "Open VibeFlow CLI"</li>
          <li><code>VibeFlow: Launch Session</code> command opens the CLI instead of the QuickPick wizard</li>
          <li>Per-persona terminals are no longer spawned — the CLI manages everything via tmux under its own socket</li>
          <li><code>Ctrl+Q</code> and <code>Ctrl+\</code> in any terminal route through to the shell (so the CLI's tmux toggle works without VS Code stealing the keystroke). Disable CLI mode to revert.</li>
          <li>Right-click Restart, Kill, Focus, and the rest of the per-session commands still work — they hit the same backend</li>
          <li><code>@vibeflow</code> chat participant stays available (read-only against the same project)</li>
        </ul>
      </Card>
    </div>
  );
}

/**
 * Text input that buffers locally and only commits to the host on blur
 * (or Enter). Without this, every keystroke fires onUpdate → host saves
 * config → host re-pushes settings snapshot → webview re-renders → the
 * snapshot can land mid-typing and overwrite the in-progress value
 * with a stale prefix (e.g. typing "~/Projects" left the user stuck on
 * "~"). Buffering decouples the two clocks.
 *
 * The `initial` prop syncs back to local state when the host pushes a
 * different value AND the user isn't currently editing — covers the
 * "another window changed the config" case without disturbing typing.
 */
function BinaryPathInput({ initial, onCommit }: {
  initial: string;
  onCommit: (value: string) => void;
}) {
  return (
    <BufferedTextInput
      initial={initial}
      placeholder="/usr/local/bin/vibeflow"
      onCommit={onCommit}
    />
  );
}

function BufferedTextInput({ initial, placeholder, onCommit, onValueChange, resetToken }: {
  initial: string;
  placeholder: string;
  onCommit: (value: string) => void;
  onValueChange?: (value: string) => void;
  resetToken?: number;
}) {
  const [value, setValue] = useState(initial);
  const [focused, setFocused] = useState(false);
  const lastResetToken = React.useRef(resetToken);

  useEffect(() => {
    if (!focused && initial !== value) { setValue(initial); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  useEffect(() => {
    if (resetToken === undefined || lastResetToken.current === resetToken) { return; }
    lastResetToken.current = resetToken;
    setValue('');
    onValueChange?.('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetToken]);

  const commit = () => {
    if (value !== initial) { onCommit(value); }
  };

  return (
    <input
      type="text"
      placeholder={placeholder}
      value={value}
      onChange={(e) => {
        setValue(e.target.value);
        onValueChange?.(e.target.value);
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); commit(); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); }
        if (e.key === 'Escape') { setValue(initial); (e.target as HTMLInputElement).blur(); }
      }}
      style={inputStyle}
    />
  );
}

// ===== Local primitives, kept private to this tab to match other tabs' style =====

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--feed-muted)' }}>{label}</span>
      {children}
    </label>
  );
}

function Card({ title, description, children }: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{
      padding: '18px 20px',
      borderRadius: 8,
      border: '1px solid var(--feed-border)',
      background: 'var(--vscode-editor-background)',
    }}>
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>{title}</h3>
      {description && (
        <p style={{ margin: '4px 0 14px', fontSize: 11, color: 'var(--feed-muted)', lineHeight: 1.5 }}>
          {description}
        </p>
      )}
      {!description && <div style={{ height: 10 }} />}
      {children}
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        style={{
          position: 'relative', width: 36, height: 20, borderRadius: 10, border: 'none',
          flexShrink: 0, cursor: 'pointer',
          // Off-state uses --feed-border (a visible separator color in light,
          // dark, and high-contrast themes) rather than --vscode-input-background,
          // which is near-white in light themes and made the OFF toggle vanish
          // against the light card (#3198). Matches the shared Toggle in _shared.tsx.
          background: checked ? 'var(--feed-link)' : 'var(--feed-border)',
          transition: 'background 0.15s',
        }}
      >
        <span style={{
          position: 'absolute',
          top: 2,
          left: checked ? 18 : 2,
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: 'white',
          // Drop shadow keeps the white thumb visible even on a light off-track
          // (e.g. a high-contrast-light theme where --feed-border is faint) — #3198.
          boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
          transition: 'left 0.15s',
        }} />
      </button>
      <span style={{ fontSize: 12, color: checked ? 'var(--feed-fg)' : 'var(--feed-muted)' }}>{label}</span>
    </div>
  );
}

function Banner({ kind, children }: { kind: 'warning' | 'info'; children: React.ReactNode }) {
  const colors = {
    warning: { bg: 'rgba(204,167,0,0.08)', border: 'var(--feed-warning)' },
    info:    { bg: 'rgba(0,127,255,0.08)', border: 'var(--feed-link)' },
  }[kind];
  return (
    <div style={{
      marginTop: 12,
      padding: 12,
      background: colors.bg,
      border: `1px solid ${colors.border}`,
      borderRadius: 4,
      fontSize: 11,
      lineHeight: 1.6,
      color: 'var(--feed-fg)',
    }}>
      {children}
    </div>
  );
}

function ButtonRow({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>{children}</div>;
}

function Btn({ label, onClick, secondary, disabled }: {
  label: string; onClick: () => void; secondary?: boolean; disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '6px 14px',
        fontSize: 12,
        borderRadius: 4,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        border: 'none',
        background: secondary ? 'var(--vscode-button-secondaryBackground)' : 'var(--feed-button-bg)',
        color: secondary ? 'var(--vscode-button-secondaryForeground)' : 'var(--feed-button-fg)',
      }}
    >
      {label}
    </button>
  );
}

function LinkBtn({ href, label, secondary }: { href: string; label: string; secondary?: boolean }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        textDecoration: 'none',
        padding: '6px 14px',
        fontSize: 12,
        borderRadius: 4,
        background: secondary ? 'var(--vscode-button-secondaryBackground)' : 'var(--feed-button-bg)',
        color: secondary ? 'var(--vscode-button-secondaryForeground)' : 'var(--feed-button-fg)',
      }}
    >
      {label}
    </a>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 10px',
  fontSize: 12,
  fontFamily: 'var(--vscode-editor-font-family)',
  background: 'var(--feed-input-bg)',
  color: 'var(--feed-fg)',
  border: '1px solid var(--feed-input-border)',
  borderRadius: 4,
  outline: 'none',
  boxSizing: 'border-box',
};
