import type { SettingsData, SettingsCommand } from './settingsTypes';
import { BufferedTextInput, Btn, ButtonRow, Card, LinkBtn, Status } from './_shared';

interface Props {
  data: SettingsData;
  onUpdate: (key: string, value: unknown) => void;
  onCommand: (cmd: SettingsCommand) => void;
}

const RELEASES_URL = 'https://github.com/axiom-studio/vibeflow-cli/releases/latest';
const INSTALL_DOCS_URL = 'https://github.com/axiom-studio/vibeflow-cli#installation';
// Mirrors WSL_SETUP_URL in src/commands/cliPlatform.ts (the webview cannot import host modules).
const WSL_SETUP_URL = 'https://learn.microsoft.com/windows/wsl/install';

/**
 * VibeFlow CLI card in the Connection tab (#3113, #4045). The CLI is the only
 * way agents are launched (design doc #627 D1/D2): this card shows whether it
 * is installed, installs or updates it, and keeps the rarely needed binary
 * path override under "Advanced".
 */
export function CliSettings({ data, onUpdate, onCommand }: Props) {
  const installed = data.cliInstalled;
  const run = (command: string) => () => onCommand({ type: 'runCommand', payload: command });

  return (
    <Card
      title="VibeFlow CLI"
      description="Agents run in the VibeFlow CLI, which opens in a fullscreen editor terminal. The sidebar shows the same live state."
    >
      {data.cliNeedsWsl ? (
        <>
          <Status ok={false}>Needs WSL on Windows</Status>
          <p style={hint}>
            The CLI runs agents in tmux, which Windows does not provide. Install WSL and the WSL extension,
            reopen this folder in WSL, then install the CLI there.
          </p>
          <ButtonRow><LinkBtn href={WSL_SETUP_URL} label="How to Set Up WSL" secondary /></ButtonRow>
        </>
      ) : (
        <>
          <Status ok={installed}>
            {installed
              ? `Installed${data.cliVersion ? ` · v${data.cliVersion}` : ''}`
              : data.cliBinaryPathStale
                ? `Configured path not found: ${data.cliBinaryPathStale}`
                : 'Not installed'}
          </Status>
          <ButtonRow>
            {installed ? (
              <>
                <Btn label="Check for Updates" onClick={run('vibeflow.checkCliUpdate')} />
                <Btn label="Reinstall Latest" secondary onClick={run('vibeflow.installCli')} />
              </>
            ) : (
              <>
                <Btn label="Install Latest" onClick={run('vibeflow.installCli')} />
                <LinkBtn href={RELEASES_URL} label="Download Manually" secondary />
                <LinkBtn href={INSTALL_DOCS_URL} label="Install Instructions" secondary />
              </>
            )}
          </ButtonRow>
          {!installed && (
            <p style={hint}>Install Latest downloads the prebuilt binary from GitHub Releases into the extension's storage and points the extension at it.</p>
          )}
        </>
      )}

      <details open={!!data.cliBinaryPath || !!data.cliBinaryPathStale} style={{ marginTop: 14 }}>
        <summary style={{ fontSize: 12, cursor: 'pointer', color: 'var(--feed-muted)' }}>Advanced: binary path override</summary>
        <p style={hint}>Leave empty to find <code>vibeflow</code> on PATH. Set it if the binary lives elsewhere (for example /opt/homebrew/bin on Apple Silicon).</p>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <BufferedTextInput
            ariaLabel="CLI binary path"
            initial={data.cliBinaryPath}
            placeholder="/usr/local/bin/vibeflow"
            onCommit={v => onUpdate('cli.binaryPath', v)}
          />
          <Btn label="Browse…" secondary onClick={run('vibeflow.browseCliBinary')} />
        </div>
      </details>
    </Card>
  );
}

const hint = { margin: '8px 0 0', fontSize: 11, lineHeight: 1.55, color: 'var(--feed-muted)' } as const;
