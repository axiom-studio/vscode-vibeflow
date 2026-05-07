import { useState, useEffect } from 'react';
import type { SettingsData, SettingsMessage, SettingsCommand } from './settingsTypes';
import { ConnectionTab } from './ConnectionTab';
import { ProvidersTab } from './ProvidersTab';
import { ModelsTab } from './ModelsTab';
import { SessionDefaultsTab } from './SessionDefaultsTab';
import { WorktreesTab } from './WorktreesTab';
import { NotificationsTab } from './NotificationsTab';
import { AdvancedTab } from './AdvancedTab';
import { AboutTab } from './AboutTab';
import { CliTab } from './CliTab';
import { getVsCodeApi } from '../../vscodeApi';

const vscode = getVsCodeApi() as { postMessage: (msg: SettingsCommand) => void };

/**
 * Maps the dotted VS Code config keys we send via updateSetting to the
 * camelCase SettingsData fields the React tabs read from. Keys not
 * listed here use the same name on both sides (e.g. `serverUrl`,
 * `defaultProvider`) and pass through unchanged via the `?? key` fallback.
 *
 * If you add a new config key with a dot in it, add a row here too —
 * otherwise the optimistic update in SettingsView.updateSetting will
 * write a literal dotted property that no component reads, and the
 * control won't visibly respond to clicks until the host's pushSettings
 * round-trip completes.
 */
const CONFIG_KEY_TO_FIELD: Record<string, string> = {
  'polling.interval': 'pollInterval',
  'session.terminalMode': 'sessionTerminalMode',
  'session.reattachMode': 'sessionReattachMode',
  'notifications.agentPrompts': 'notifyAgentPrompts',
  'notifications.workItemComplete': 'notifyWorkComplete',
  'debug.simulateActivity': 'debugSimulateActivity',
  'cli.enabled': 'cliEnabled',
  'cli.binaryPath': 'cliBinaryPath',
};

const TABS = [
  { id: 'connection', label: 'Connection', icon: '🔗' },
  { id: 'providers', label: 'Providers', icon: '🤖' },
  { id: 'session', label: 'Session Defaults', icon: '⚙' },
  { id: 'models', label: 'Sticky Models', icon: '🧠' },
  { id: 'worktrees', label: 'Worktrees', icon: '🌿' },
  { id: 'notifications', label: 'Notifications', icon: '🔔' },
  { id: 'cli', label: 'CLI Interface', icon: '⌨' },
  { id: 'advanced', label: 'Advanced', icon: '🛠' },
  { id: 'about', label: 'About', icon: 'ℹ' },
] as const;

type TabId = typeof TABS[number]['id'];

export function SettingsView() {
  const [activeTab, setActiveTab] = useState<TabId>('connection');
  const [data, setData] = useState<SettingsData | null>(null);

  useEffect(() => {
    function handleMessage(event: MessageEvent<SettingsMessage>) {
      const msg = event.data;
      if (msg.type === 'settingsData') {
        setData(msg.payload);
      }
    }
    window.addEventListener('message', handleMessage);
    vscode.postMessage({ type: 'getSetting' });
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  function updateSetting(key: string, value: unknown) {
    vscode.postMessage({ type: 'updateSetting', payload: { key, value } });
    if (data) {
      // Optimistic local update — the host also re-pushes a fresh
      // SettingsData snapshot after persisting, but doing the local
      // patch keeps the UI snappy on click.
      //
      // Config keys are dotted (`session.terminalMode`); SettingsData
      // fields are camelCase (`sessionTerminalMode`) for ergonomics.
      // Without this mapping, setData would write a literal
      // `'session.terminalMode'` property that no component reads, so
      // the radio buttons never visibly moved on click.
      const field = CONFIG_KEY_TO_FIELD[key] ?? key;
      setData({ ...data, [field]: value });
    }
  }

  function sendCommand(cmd: SettingsCommand) {
    vscode.postMessage(cmd);
  }

  if (!data) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        color: 'var(--feed-muted)',
        fontFamily: 'var(--vscode-font-family)',
      }}>
        Loading settings...
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      fontFamily: 'var(--vscode-font-family)',
      color: 'var(--feed-fg)',
      background: 'var(--feed-bg)',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '16px 32px',
        borderBottom: '1px solid var(--feed-border)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 18, fontWeight: 700 }}>Settings</span>
          <span style={{
            fontSize: 10,
            padding: '2px 6px',
            borderRadius: 3,
            background: 'var(--feed-badge-bg)',
            color: 'var(--feed-badge-fg)',
          }}>v{data.version}</span>
        </div>
        <button
          onClick={() => sendCommand({ type: 'closeSettings' })}
          style={{
            padding: '5px 14px',
            fontSize: 12,
            background: 'var(--feed-button-bg)',
            color: 'var(--feed-button-fg)',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          Done
        </button>
      </div>

      {/* Tabs — wrap to a second row when there are too many to fit on one */}
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 0,
        borderBottom: '1px solid var(--feed-border)',
        padding: '0 32px',
        flexShrink: 0,
      }}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: '10px 16px',
              fontSize: 12,
              fontWeight: activeTab === tab.id ? 600 : 400,
              color: activeTab === tab.id ? 'var(--feed-fg)' : 'var(--feed-muted)',
              background: 'transparent',
              border: 'none',
              borderBottom: activeTab === tab.id ? '2px solid var(--feed-link)' : '2px solid transparent',
              cursor: 'pointer',
              transition: 'all 100ms',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span>{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content — wide padding so scrollbar sits at the right edge */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '24px 32px 40px 32px',
      }}>
        <div style={{ maxWidth: 580 }}>
          {activeTab === 'connection' && (
            <ConnectionTab data={data} onUpdate={updateSetting} onCommand={sendCommand} />
          )}
          {activeTab === 'providers' && (
            <ProvidersTab data={data} onUpdate={updateSetting} onCommand={sendCommand} />
          )}
          {activeTab === 'session' && (
            <SessionDefaultsTab data={data} onUpdate={updateSetting} />
          )}
          {activeTab === 'models' && (
            <ModelsTab data={data} onCommand={sendCommand} />
          )}
          {activeTab === 'worktrees' && (
            <WorktreesTab data={data} onUpdate={updateSetting} />
          )}
          {activeTab === 'notifications' && (
            <NotificationsTab data={data} onUpdate={updateSetting} />
          )}
          {activeTab === 'cli' && (
            <CliTab data={data} onUpdate={updateSetting} onCommand={sendCommand} />
          )}
          {activeTab === 'advanced' && (
            <AdvancedTab data={data} onUpdate={updateSetting} />
          )}
          {activeTab === 'about' && (
            <AboutTab data={data} />
          )}
        </div>
      </div>
    </div>
  );
}
