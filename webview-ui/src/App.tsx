export function App() {
  return (
    <div style={{
      fontFamily: 'var(--vscode-font-family)',
      fontSize: 'var(--vscode-font-size)',
      color: 'var(--vscode-foreground)',
      padding: '8px',
    }}>
      <div style={{
        textAlign: 'center',
        padding: '24px 8px',
        color: 'var(--vscode-descriptionForeground)',
      }}>
        <p>Activity Feed</p>
        <p style={{ fontSize: '0.9em' }}>
          Launch an agent session to see real-time logs here.
        </p>
      </div>
    </div>
  );
}
