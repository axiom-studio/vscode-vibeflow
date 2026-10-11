import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react';

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

/**
 * Text input that buffers locally and commits to the host only on blur or
 * Enter (Escape reverts). Saving per keystroke would race the host's
 * snapshot re-push and, for the server URL, send requests to half-typed
 * hosts. The `initial` prop syncs back while the user is not editing.
 */
export function BufferedTextInput({ initial, placeholder, onCommit, onValueChange, ariaLabel }: {
  initial: string;
  placeholder?: string;
  onCommit: (value: string) => void;
  onValueChange?: (value: string) => void;
  ariaLabel?: string;
}) {
  const [value, setValue] = useState(initial);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) { setValue(initial); onValueChange?.(initial); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);
  const commit = () => { if (value !== initial) { onCommit(value); } };
  return (
    <input
      type="text"
      aria-label={ariaLabel}
      placeholder={placeholder}
      value={value}
      onChange={e => { setValue(e.target.value); onValueChange?.(e.target.value); }}
      onFocus={() => { focused.current = true; }}
      onBlur={() => { focused.current = false; commit(); }}
      onKeyDown={e => {
        if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); }
        if (e.key === 'Escape') { setValue(initial); onValueChange?.(initial); }
      }}
      style={textInputStyle}
    />
  );
}

export function Btn({ label, onClick, secondary, disabled }: {
  label: string; onClick: () => void; secondary?: boolean; disabled?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: '5px 12px', fontSize: 12, borderRadius: 4, border: 'none', whiteSpace: 'nowrap',
      cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
      background: secondary ? 'var(--vscode-button-secondaryBackground)' : 'var(--feed-button-bg)',
      color: secondary ? 'var(--vscode-button-secondaryForeground)' : 'var(--feed-button-fg)',
    }}>{label}</button>
  );
}

export function LinkBtn({ href, label, secondary }: { href: string; label: string; secondary?: boolean }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{
      textDecoration: 'none', padding: '5px 12px', fontSize: 12, borderRadius: 4, whiteSpace: 'nowrap',
      background: secondary ? 'var(--vscode-button-secondaryBackground)' : 'var(--feed-button-bg)',
      color: secondary ? 'var(--vscode-button-secondaryForeground)' : 'var(--feed-button-fg)',
    }}>{label}</a>
  );
}

export function ButtonRow({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>{children}</div>;
}

/** A coloured dot plus text: ok = green, false = red, null = neutral. */
export function Status({ ok, children }: { ok: boolean | null; children: ReactNode }) {
  const color = ok === null ? 'var(--feed-muted)' : ok ? 'var(--feed-success)' : 'var(--feed-error)';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
      {children}
    </span>
  );
}

export const textInputStyle: CSSProperties = {
  ...inputStyle, width: '100%', boxSizing: 'border-box', flex: 1, minWidth: 0,
};
