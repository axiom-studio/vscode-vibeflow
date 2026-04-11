import { useState, useEffect } from 'react';
import type { SettingsData, SettingsMessage, SettingsCommand } from './settingsTypes';
import { ConnectionTab } from './ConnectionTab';
import { ProvidersTab } from './ProvidersTab';
import { SessionTab } from './SessionTab';

const vscode = (window as unknown as {
  acquireVsCodeApi: () => { postMessage: (msg: SettingsCommand) => void };
}).acquireVsCodeApi();

const TABS = [
  { id: 'connection', label: 'Connection', icon: '🔗' },
  { id: 'providers', label: 'Providers', icon: '🤖' },
  { id: 'session', label: 'Session', icon: '⚡' },
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
    // Optimistic update
    if (data) {
      setData({ ...data, [key]: value });
    }
  }

  function sendCommand(cmd: SettingsCommand) {
    vscode.postMessage(cmd);
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--feed-muted)]">
        Loading settings...
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--feed-border)]">
        <span className="text-sm font-medium">Settings</span>
        <button
          onClick={() => sendCommand({ type: 'closeSettings' })}
          className="px-2 py-0.5 text-xs rounded bg-[var(--feed-button-bg)] text-[var(--feed-button-fg)] hover:bg-[var(--feed-button-hover)] cursor-pointer border-none"
        >
          Done
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-[var(--feed-border)]">
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 px-2 py-1.5 text-xs cursor-pointer border-none border-b-2 transition-colors ${
              activeTab === tab.id
                ? 'border-[var(--feed-link)] text-[var(--feed-fg)]'
                : 'border-transparent text-[var(--feed-muted)] hover:text-[var(--feed-fg)]'
            }`}
            style={{ background: 'transparent' }}
          >
            {tab.icon} {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {activeTab === 'connection' && (
          <ConnectionTab data={data} onUpdate={updateSetting} onCommand={sendCommand} />
        )}
        {activeTab === 'providers' && (
          <ProvidersTab data={data} onUpdate={updateSetting} onCommand={sendCommand} />
        )}
        {activeTab === 'session' && (
          <SessionTab data={data} onUpdate={updateSetting} />
        )}
      </div>
    </div>
  );
}
