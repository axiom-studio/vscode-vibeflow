import type { ReactNode, CSSProperties } from 'react';

export function Card({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div style={{
      padding: '18px 20px',
      borderRadius: 8,
      border: '1px solid var(--feed-border)',
      background: 'var(--vscode-editor-background)',
    }}>
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, letterSpacing: '0.01em' }}>{title}</h3>
      {description && <p style={{ margin: '4px 0 14px', fontSize: 11, color: 'var(--feed-muted)', lineHeight: 1.5 }}>{description}</p>}
      {!description && <div style={{ height: 10 }} />}
      {children}
    </div>
  );
}

export function ToggleRow({ label, desc, checked, onChange }: {
  label: string; desc: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '8px 0', gap: 16 }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, fontWeight: 500 }}>{label}</div>
        <div style={{ fontSize: 10, color: 'var(--feed-muted)', marginTop: 2, lineHeight: 1.4 }}>{desc}</div>
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  );
}

export function RadioGroup({ name, value, options, onChange }: {
  name: string; value: string; options: { value: string; label: string; desc: string }[]; onChange: (v: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {options.map(opt => (
        <label key={opt.value} style={{
          display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px',
          borderRadius: 6, cursor: 'pointer',
          background: value === opt.value ? 'rgba(127,127,127,0.08)' : 'transparent',
          border: value === opt.value ? '1px solid var(--feed-border)' : '1px solid transparent',
        }}>
          <input type="radio" name={name} checked={value === opt.value} onChange={() => onChange(opt.value)}
            style={{ marginTop: 2, accentColor: 'var(--feed-link)' }} />
          <div>
            <div style={{ fontSize: 12, fontWeight: 500 }}>{opt.label}</div>
            <div style={{ fontSize: 10, color: 'var(--feed-muted)', marginTop: 1 }}>{opt.desc}</div>
          </div>
        </label>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button role="switch" aria-checked={checked} onClick={() => onChange(!checked)} style={{
      position: 'relative', width: 36, height: 20, borderRadius: 10, border: 'none', flexShrink: 0,
      background: checked ? 'var(--feed-link)' : 'var(--feed-border)', cursor: 'pointer',
      transition: 'background 150ms', padding: 0,
    }}>
      <span style={{
        position: 'absolute', top: 2, left: checked ? 18 : 2, width: 16, height: 16,
        borderRadius: '50%', background: 'white', transition: 'left 150ms',
        boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
      }} />
    </button>
  );
}

export const inputStyle: CSSProperties = {
  padding: '7px 10px', fontSize: 12, borderRadius: 4,
  background: 'var(--feed-input-bg)', border: '1px solid var(--feed-input-border)',
  color: 'var(--feed-fg)', outline: 'none', fontFamily: 'var(--vscode-editor-font-family)', width: 80,
};
