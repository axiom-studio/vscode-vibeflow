import type { SettingsData } from './settingsTypes';
import { Card } from './_shared';

interface Props {
  data: SettingsData;
}

export function AboutTab({ data }: Props) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <Card title="About" description="">
        <div style={{ fontSize: 12, color: 'var(--feed-muted)', lineHeight: 1.8 }}>
          <div><strong style={{ color: 'var(--feed-fg)' }}>VibeFlow for VS Code</strong> v{data.version}</div>
          <div>Multi-persona AI agent orchestration, project management, and governance.</div>
          <div style={{ marginTop: 8, fontSize: 11 }}>
            <a href="https://cloud.axiomstudio.ai" style={{ color: 'var(--feed-link)', textDecoration: 'none' }}>VibeFlow Cloud</a>
            {' · '}
            <a href="https://bitbucket.org/axiom-studio/vscode-vibeflow" style={{ color: 'var(--feed-link)', textDecoration: 'none' }}>Source Code</a>
            {' · '}
            <a href="https://www.apache.org/licenses/LICENSE-2.0" style={{ color: 'var(--feed-link)', textDecoration: 'none' }}>Apache 2.0 License</a>
          </div>
        </div>
      </Card>
    </div>
  );
}
