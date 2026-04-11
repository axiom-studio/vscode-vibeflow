import { useState, useEffect } from 'react';
import { ActivityFeed } from './components/ActivityFeed';
import { SettingsView } from './components/settings/SettingsView';

type View = 'activity' | 'settings';

export function App() {
  const [view, setView] = useState<View>('activity');

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.data?.type === 'showSettings') {
        setView('settings');
      } else if (event.data?.type === 'showActivity') {
        setView('activity');
      } else if (event.data?.type === 'closeSettings') {
        setView('activity');
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  if (view === 'settings') {
    return <SettingsView />;
  }

  return <ActivityFeed />;
}
