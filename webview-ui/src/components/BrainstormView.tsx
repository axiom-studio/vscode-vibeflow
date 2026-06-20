import { useState, useEffect, useCallback, type CSSProperties, type ReactNode } from 'react';
import { getVsCodeApi } from '../vscodeApi';
import { PERSONA_COLORS } from '../types';
import { AVATAR_BY_PERSONA } from '../personaAvatars';
import { MarkdownRenderer } from './MarkdownRenderer';
import { SpinnerIcon } from './_shared/icons';
import type { BrainstormSnapshot, BrainstormClientMessage } from '../../../src/core/webviewMessages';
import type { VibeFlowBrainstormResponse, VibeFlowBrainstormSession, BrainstormOpenItem } from '../../../src/api/types';

const vscode = getVsCodeApi() as { postMessage: (msg: BrainstormClientMessage) => void };

/** Contribution-type visual vocabulary (design doc #361 §3.6). Accent colors are
 *  used as left-borders/chips over `--vscode-*` surfaces, not as fills, so the
 *  panel still reads native in any theme. */
const TAG_STYLES: Record<string, { color: string; icon: string; label: string }> = {
  challenge: { color: '#d08b3f', icon: '⚡', label: 'Challenge' },
  risk: { color: '#e0574f', icon: '⚠', label: 'Risk' },
  question: { color: '#4d9fff', icon: '?', label: 'Question' },
  needs_input: { color: '#3bb6b8', icon: '→', label: 'Needs Input' },
  scope: { color: '#b483ff', icon: '◆', label: 'Scope' },
  approved: { color: '#43d782', icon: '✓', label: 'Approved' },
  escalate: { color: '#e0574f', icon: '!', label: 'Escalate' },
  disagree: { color: '#d08b3f', icon: '✗', label: 'Disagree' },
  followup_answer: { color: '#3bb6b8', icon: '💬', label: 'Answer' },
};
function tagStyle(t: string) {
  return TAG_STYLES[t] ?? { color: 'var(--feed-muted)', icon: '•', label: t.replace(/_/g, ' ') };
}

const STATUS_PILL: Record<string, { bg: string; fg: string; label: string }> = {
  setup: { bg: 'rgba(180,131,255,0.18)', fg: '#b483ff', label: 'Setup' },
  seeding: { bg: 'rgba(234,179,8,0.18)', fg: '#eab308', label: 'Seeding' },
  active: { bg: 'rgba(67,215,130,0.18)', fg: 'var(--feed-success, #43d782)', label: 'Active' },
  converging: { bg: 'rgba(77,159,255,0.18)', fg: '#4d9fff', label: 'Converging' },
  done: { bg: 'rgba(67,215,130,0.14)', fg: 'var(--feed-success, #43d782)', label: 'Completed' },
  cancelled: { bg: 'rgba(160,160,160,0.16)', fg: 'var(--feed-muted)', label: 'Cancelled' },
};

function prettyPersona(key: string): string {
  return key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
function personaColor(key: string): string {
  return PERSONA_COLORS[key] ?? 'var(--vscode-foreground)';
}

export function BrainstormView() {
  const [snap, setSnap] = useState<BrainstormSnapshot | null>(null);
  const [error, setError] = useState<string | undefined>();
  // Document | Chat tab for narrow widths (the split is side-by-side when wide).
  const [pane, setPane] = useState<'doc' | 'chat'>('chat');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const m = e.data;
      if (m?.type === 'brainstormSnapshot') { setSnap(m.payload as BrainstormSnapshot); setError(undefined); }
      else if (m?.type === 'brainstormError') { setError(m.payload?.message ?? 'Failed to load brainstorm'); }
    }
    window.addEventListener('message', onMessage);
    vscode.postMessage({ type: 'brainstormLoad' });
    // Cursor service-worker race: re-request once the listener is registered.
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const refresh = useCallback(() => vscode.postMessage({ type: 'brainstormRefresh' }), []);

  if (!snap) {
    return (
      <Centered>
        {error
          ? <div style={{ color: 'var(--feed-error)', fontSize: 13 }}>{error}</div>
          : <><SpinnerIcon size={20} /><div style={{ marginTop: 10, fontSize: 13, color: 'var(--feed-muted)' }}>Loading brainstorm…</div></>}
      </Centered>
    );
  }

  if (snap.mode === 'empty' || !snap.session) {
    return <EmptyState personas={snap.activePersonas} onRefresh={refresh} />;
  }

  const s = snap.session;
  const prog = snap.progress;

  return (
    <div style={{ width: '100%', height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--feed-bg)', overflow: 'hidden' }}>
      <Header snap={snap} onRefresh={refresh} onConfirm={setConfirm} />
      {error && <div style={{ padding: '6px 16px', fontSize: 11, color: 'var(--feed-error)', background: 'rgba(224,87,79,0.1)' }}>{error}</div>}

      <ProgressDashboard session={s} progress={prog} convergence={currentConvergence(snap)} />

      <Banners snap={snap} onConfirm={setConfirm} />

      {/* Pane toggle — hidden on wide (both panes show side-by-side), shown when
          narrow (tabbed). Display is CSS-controlled (.brainstorm-pane-tabs). */}
      <div className="brainstorm-pane-tabs" style={{ gap: 6, padding: '6px 16px 0', flexShrink: 0 }}>
        <PaneTab label="Chat" active={pane === 'chat'} onClick={() => setPane('chat')} />
        <PaneTab label="Document" active={pane === 'doc'} onClick={() => setPane('doc')} />
      </div>

      <div className="brainstorm-split" style={{ flex: 1, minHeight: 0, display: 'flex', gap: 1, padding: '8px 16px 0' }}>
        <div className={`brainstorm-pane brainstorm-pane-doc${pane === 'doc' ? ' is-active' : ''}`} style={paneStyle}>
          <DocumentPane markdown={snap.documentMarkdown} />
        </div>
        <div className={`brainstorm-pane brainstorm-pane-chat${pane === 'chat' ? ' is-active' : ''}`} style={paneStyle}>
          <ChatPane snap={snap} />
        </div>
      </div>

      <OpenItemsDrawer items={s.open_items ?? []} open={drawerOpen} onToggle={() => setDrawerOpen(o => !o)} />

      <ConfirmModal spec={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

const paneStyle: CSSProperties = {
  flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto',
  border: '1px solid var(--feed-border)', borderRadius: 8,
  background: 'var(--vscode-editor-background)',
};

function currentConvergence(snap: BrainstormSnapshot): number {
  const rounds = snap.rounds ?? [];
  return rounds.length ? rounds[rounds.length - 1].convergence_score : 0;
}

// ---------------------------------------------------------------- Header

function Header({ snap, onRefresh, onConfirm }: { snap: BrainstormSnapshot; onRefresh: () => void; onConfirm: (s: ConfirmSpec) => void }) {
  const s = snap.session!;
  const pill = STATUS_PILL[s.status] ?? { bg: 'rgba(160,160,160,0.16)', fg: 'var(--feed-muted)', label: s.status };
  const openCount = (s.open_items ?? []).length;
  const history = snap.history ?? [];
  const live = s.status !== 'done' && s.status !== 'cancelled';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: '1px solid var(--feed-border)', flexShrink: 0 }}>
      <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--feed-fg)' }}>Brainstorm #{s.id}</span>
      <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 9px', borderRadius: 999, background: pill.bg, color: pill.fg }}>{pill.label}</span>
      <span style={{ fontSize: 11, color: 'var(--feed-muted)' }}>
        Round {s.round_number}/{s.config.max_rounds} · Lead: <span style={{ color: personaColor(s.lead_persona_key), fontWeight: 600 }}>{prettyPersona(s.lead_persona_key)}</span> · {openCount} open item{openCount === 1 ? '' : 's'}
      </span>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
        {history.length > 1 && (
          <select
            value={s.id}
            onChange={e => vscode.postMessage({ type: 'brainstormSelectSession', payload: { id: Number(e.target.value) } })}
            title="View a past brainstorm"
            style={selectStyle}
          >
            {history.map((h: VibeFlowBrainstormSession) => (
              <option key={h.id} value={h.id}>#{h.id} · {h.status}</option>
            ))}
          </select>
        )}
        {live && (
          <>
            <button
              onClick={() => onConfirm({ title: 'Stop & finalize brainstorm?', body: 'Open items are preserved in the document and a final document is generated from the working draft.', confirmLabel: 'Stop & finalize', action: () => vscode.postMessage({ type: 'brainstormEnd', payload: { id: s.id, cancel: false } }) })}
              style={ghostBtn}>Stop &amp; finalize</button>
            <button
              onClick={() => onConfirm({ title: 'Discard brainstorm (no document)?', body: 'No final document is generated. The working draft is preserved, but the brainstorm ends without a finalized output.', confirmLabel: 'Discard brainstorm', danger: true, action: () => vscode.postMessage({ type: 'brainstormEnd', payload: { id: s.id, cancel: true } }) })}
              style={ghostBtn}>Discard</button>
          </>
        )}
        <button
          onClick={() => onConfirm({ title: 'Delete brainstorm?', body: 'This permanently deletes the brainstorm session and its rounds.', confirmLabel: 'Delete', danger: true, action: () => vscode.postMessage({ type: 'brainstormDelete', payload: { id: s.id } }) })}
          style={ghostBtn}>Delete</button>
        <button onClick={onRefresh} style={ghostBtn}>Refresh</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Progress dashboard

function ProgressDashboard({ session, progress, convergence }: {
  session: VibeFlowBrainstormSession; progress?: BrainstormSnapshot['progress']; convergence: number;
}) {
  const cfg = session.config;
  const personas = [session.lead_persona_key, ...(cfg.participating_personas ?? []).filter(p => p !== session.lead_persona_key)];
  const responded = progress?.responded ?? {};
  const nextUp = progress?.next_up;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 18, padding: '10px 16px', borderBottom: '1px solid var(--feed-border)', flexShrink: 0, flexWrap: 'wrap' }}>
      <RoundStepper current={session.round_number} max={cfg.max_rounds} />
      <ConvergenceRing value={convergence} />
      <TokenBar used={cfg.tokens_used} budget={cfg.token_budget} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {personas.map(p => {
          const did = responded[p];
          const isNext = p === nextUp;
          const color = personaColor(p);
          const bg = did ? 'rgba(67,215,130,0.14)' : isNext ? 'rgba(77,159,255,0.16)' : 'transparent';
          const bd = did ? 'var(--feed-success, #43d782)' : isNext ? '#4d9fff' : 'var(--feed-border)';
          return (
            <span key={p} title={did ? `Responded: ${did}` : isNext ? 'Up next' : 'Pending'}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, padding: '3px 8px', borderRadius: 999, border: `1px solid ${bd}`, background: bg, color: 'var(--feed-fg)' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
              {prettyPersona(p)}{p === session.lead_persona_key ? ' (lead)' : ''}
              {did ? <span style={{ color: 'var(--feed-success, #43d782)' }}>✓</span> : isNext ? <span style={{ color: '#4d9fff' }}>▸</span> : <span style={{ color: 'var(--feed-muted)' }}>○</span>}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function RoundStepper({ current, max }: { current: number; max: number }) {
  const n = Math.max(max, 1);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }} title={`Round ${current} of ${max}`}>
      {Array.from({ length: n }, (_, i) => {
        const round = i + 1;
        const done = round < current;
        const cur = round === current;
        return (
          <span key={round} style={{
            width: 18, height: 18, borderRadius: '50%', fontSize: 9, fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: done ? 'var(--feed-success, #43d782)' : cur ? 'var(--feed-link)' : 'transparent',
            color: done || cur ? '#0b0b0b' : 'var(--feed-muted)',
            border: `1px solid ${done ? 'var(--feed-success, #43d782)' : cur ? 'var(--feed-link)' : 'var(--feed-border)'}`,
            boxShadow: cur ? '0 0 8px color-mix(in oklab, var(--feed-link) 55%, transparent)' : 'none',
          }}>{done ? '✓' : round}</span>
        );
      })}
    </div>
  );
}

function ConvergenceRing({ value }: { value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const color = pct >= 80 ? 'var(--feed-success, #43d782)' : pct >= 50 ? '#4d9fff' : '#eab308';
  const r = 13, c = 2 * Math.PI * r;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }} title={`Convergence ${pct}%`}>
      <svg width="32" height="32" viewBox="0 0 32 32" style={{ transform: 'rotate(-90deg)' }}>
        <circle cx="16" cy="16" r={r} fill="none" stroke="var(--feed-border)" strokeWidth="3" />
        <circle cx="16" cy="16" r={r} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} />
      </svg>
      <div style={{ fontSize: 10, color: 'var(--feed-muted)', lineHeight: 1.2 }}>
        <div style={{ color: 'var(--feed-fg)', fontWeight: 600 }}>{pct}%</div>
        converged
      </div>
    </div>
  );
}

function TokenBar({ used, budget }: { used: number; budget: number }) {
  const pct = budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0;
  const color = pct >= 95 ? 'var(--feed-error)' : pct >= 80 ? 'var(--feed-warning)' : 'var(--feed-success, #43d782)';
  const fmt = (n: number) => `${Math.round(n / 1000)}K`;
  return (
    <div style={{ minWidth: 120 }} title={`${used.toLocaleString()} / ${budget.toLocaleString()} tokens`}>
      <div style={{ fontSize: 9.5, color: 'var(--feed-muted)', marginBottom: 3 }}>Tokens {fmt(used)} / {fmt(budget)}</div>
      <div style={{ height: 5, borderRadius: 3, background: 'var(--feed-border)', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Banners

function Banners({ snap, onConfirm }: { snap: BrainstormSnapshot; onConfirm: (s: ConfirmSpec) => void }) {
  const s = snap.session!;
  const cfg = s.config;
  const live = s.status !== 'done' && s.status !== 'cancelled';
  const items: { kind: string; color: string; bg: string; text: string; action?: { label: string; spec: ConfirmSpec } }[] = [];
  if (s.status === 'converging' || (currentConvergence(snap) >= 1 && (s.open_items ?? []).length === 0)) {
    items.push({
      kind: 'converged',
      color: 'var(--feed-success, #43d782)', bg: 'rgba(67,215,130,0.12)',
      text: '✓ Brainstorm converged — the team has reached agreement.',
      action: live ? { label: 'Accept & Finalize', spec: { title: 'Accept & finalize?', body: 'Generate the final document from the converged draft and end the brainstorm.', confirmLabel: 'Accept & Finalize', action: () => vscode.postMessage({ type: 'brainstormEnd', payload: { id: s.id, cancel: false } }) } } : undefined,
    });
  }
  if (cfg.token_budget > 0 && cfg.tokens_used >= cfg.token_budget) {
    items.push({ kind: 'budget', color: 'var(--feed-error)', bg: 'rgba(224,87,79,0.12)', text: '⚠ Token budget exhausted — the brainstorm will wind down.' });
  }
  if (cfg.paused) {
    items.push({ kind: 'paused', color: 'var(--feed-warning)', bg: 'rgba(234,179,8,0.12)', text: '⏸ Auto-paused at ~80% of the token budget — the agents will handle resumption or finalize.' });
  }
  if (!items.length) { return null; }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 16px 0', flexShrink: 0 }}>
      {items.map((b) => (
        <div key={b.kind} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11, fontWeight: 500, padding: '6px 10px', borderRadius: 6, color: b.color, background: b.bg }}>
          <span style={{ flex: 1 }}>{b.text}</span>
          {b.action && (
            <button onClick={() => onConfirm(b.action!.spec)} style={{ fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 5, border: `1px solid ${b.color}`, background: 'transparent', color: b.color, cursor: 'pointer', flexShrink: 0 }}>{b.action.label}</button>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Document pane

function DocumentPane({ markdown }: { markdown?: string }) {
  if (!markdown) {
    return <div style={{ padding: 20, fontSize: 12, color: 'var(--feed-muted)', textAlign: 'center' }}>The lead persona is preparing the working draft…</div>;
  }
  return <div style={{ padding: '14px 18px' }}><MarkdownRenderer content={markdown} /></div>;
}

// ---------------------------------------------------------------- Chat pane

function ChatPane({ snap }: { snap: BrainstormSnapshot }) {
  const rounds = snap.rounds ?? [];
  const serverUrl = snap.serverUrl;
  const hasAny = rounds.some(r => r.responses.length > 0);
  if (!hasAny) {
    return <div style={{ padding: 20, fontSize: 12, color: 'var(--feed-muted)', textAlign: 'center' }}>Waiting for persona responses…</div>;
  }
  return (
    <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      {rounds.map(r => (
        <section key={r.round_number}>
          <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--feed-muted)', marginBottom: 6 }}>
            Round {r.round_number} · {r.responses.length} response{r.responses.length === 1 ? '' : 's'}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {r.responses.map(resp => <ContributionBubble key={resp.id} resp={resp} serverUrl={serverUrl} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

function ContributionBubble({ resp, serverUrl }: { resp: VibeFlowBrainstormResponse; serverUrl: string }) {
  const tag = tagStyle(resp.response_type);
  const pColor = personaColor(resp.persona_key);
  const avatar = serverUrl && AVATAR_BY_PERSONA[resp.persona_key] ? `${serverUrl}${AVATAR_BY_PERSONA[resp.persona_key]}` : undefined;
  const escalate = resp.response_type === 'escalate';
  return (
    <div style={{
      borderLeft: `3px solid ${tag.color}`, borderRadius: 6,
      background: escalate ? 'rgba(224,87,79,0.08)' : 'var(--feed-bg)',
      padding: '7px 10px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, fontSize: 11 }}>
        <button
          onClick={() => { if (resp.session_id) { vscode.postMessage({ type: 'brainstormOpenSession', payload: { sessionId: resp.session_id } }); } }}
          disabled={!resp.session_id}
          title={resp.session_id ? 'Open this agent’s session' : undefined}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none', padding: 0, cursor: resp.session_id ? 'pointer' : 'default' }}>
          {avatar
            ? <img src={avatar} alt="" style={{ width: 16, height: 16, borderRadius: '50%', objectFit: 'cover' }} />
            : <span style={{ width: 8, height: 8, borderRadius: '50%', background: pColor }} />}
          <span style={{ fontWeight: 600, color: 'var(--feed-fg)' }}>{prettyPersona(resp.persona_key)}</span>
        </button>
        <span style={{ fontSize: 9.5, fontWeight: 700, color: tag.color }}>{tag.icon} {tag.label}</span>
        {resp.target_section && <span style={{ fontSize: 9.5, color: 'var(--feed-muted)' }}>§{resp.target_section}</span>}
        {resp.target_persona_key && (
          <span style={{ fontSize: 9.5, color: '#3bb6b8' }}>→ {prettyPersona(resp.target_persona_key)}</span>
        )}
      </div>
      <div style={{ fontSize: 12, color: 'var(--feed-fg)', opacity: 0.92, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{resp.content}</div>
    </div>
  );
}

// ---------------------------------------------------------------- Open items drawer

function OpenItemsDrawer({ items, open, onToggle }: { items: BrainstormOpenItem[]; open: boolean; onToggle: () => void }) {
  const openItems = items.filter(i => i.status === 'open' || !i.status);
  return (
    <div style={{ borderTop: '1px solid var(--feed-border)', flexShrink: 0, background: 'var(--feed-bg)' }}>
      <button onClick={onToggle} style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px',
        background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--feed-fg)', fontSize: 11, fontWeight: 600,
      }}>
        <span style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}>▸</span>
        Open items · {openItems.length}
        <span style={{ marginLeft: 'auto', color: 'var(--feed-muted)', fontWeight: 400 }}>{items.length} total</span>
      </button>
      {open && (
        <div style={{ maxHeight: 200, overflowY: 'auto', padding: '0 16px 12px', display: 'flex', flexDirection: 'column', gap: 5 }}>
          {items.length === 0 && <div style={{ fontSize: 11, color: 'var(--feed-muted)', opacity: 0.7 }}>No open items raised yet.</div>}
          {items.map(it => {
            const tag = tagStyle(it.type);
            return (
              <div key={it.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 11, borderLeft: `3px solid ${tag.color}`, paddingLeft: 8 }}>
                <span style={{ fontSize: 9, fontWeight: 700, color: tag.color, flexShrink: 0, marginTop: 1 }}>{tag.label}</span>
                <span style={{ flex: 1, minWidth: 0, color: 'var(--feed-fg)' }}>{it.text}{it.section && <span style={{ color: 'var(--feed-muted)' }}> · §{it.section}</span>}</span>
                <span style={{ flexShrink: 0, color: 'var(--feed-muted)', fontSize: 9.5 }}>R{it.round} · {prettyPersona(it.raised_by)}{it.status && it.status !== 'open' ? ` · ${it.status}` : ''}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Empty state + bits

function EmptyState({ personas, onRefresh }: { personas: { key: string; sessionId: string }[]; onRefresh: () => void }) {
  const canStart = personas.length >= 2;
  return (
    <div style={{ width: '100%', height: '100vh', overflow: 'auto', background: 'var(--feed-bg)', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={{ width: '100%', maxWidth: 560, padding: '32px 24px' }}>
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <div style={{ fontSize: 30, marginBottom: 6 }}>💡</div>
          <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--feed-fg)' }}>Start a brainstorm</div>
          <div style={{ fontSize: 12, color: 'var(--feed-muted)', marginTop: 5, lineHeight: 1.5 }}>
            A lead persona drafts a document; the others review it in rounds — challenging, questioning, refining — until the team converges.
          </div>
        </div>
        <HowItWorks />
        {canStart
          ? <StartBrainstormForm personas={personas} />
          : (
            <div style={{ marginTop: 18, padding: 16, borderRadius: 8, border: '1px solid var(--feed-border)', background: 'rgba(234,179,8,0.08)', fontSize: 12, color: 'var(--feed-warning)', textAlign: 'center', lineHeight: 1.5 }}>
              Need at least <b>2 personas with running agents</b> to brainstorm (currently {personas.length}). Fan-out only reaches heartbeating sessions — launch more agents, then refresh.
              <div><button onClick={onRefresh} style={{ ...ghostBtn, marginTop: 10 }}>Refresh</button></div>
            </div>
          )}
      </div>
    </div>
  );
}

function HowItWorks() {
  const steps: [string, string, string][] = [
    ['1', 'Define', 'topic + team'],
    ['2', 'Review', 'agents weigh in'],
    ['3', 'Iterate', 'rounds to converge'],
    ['4', 'Finalize', 'a document'],
  ];
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
      {steps.map(([n, t, d]) => (
        <div key={n} style={{ flex: 1, textAlign: 'center', padding: '8px 6px', border: '1px solid var(--feed-border)', borderRadius: 8 }}>
          <div style={{ width: 18, height: 18, borderRadius: '50%', background: 'var(--feed-link)', color: '#0b0b0b', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 5px' }}>{n}</div>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--feed-fg)' }}>{t}</div>
          <div style={{ fontSize: 9.5, color: 'var(--feed-muted)', marginTop: 1 }}>{d}</div>
        </div>
      ))}
    </div>
  );
}

// The backend builds the working-draft doc title as `"Brainstorm: " + topic`
// (12-char prefix) and stores it in a varchar(255) column with no truncation,
// so cap the topic to keep the title under 255 (#2415). The axiomcloud web form
// has no cap either — this is really a backend bug (it should truncate the
// title); the cap here is a client-side guardrail so the extension never trips
// it. Note: this matches the per-client reality, not a divergence from the web.
const TOPIC_MAX = 240;

function StartBrainstormForm({ personas }: { personas: { key: string; sessionId: string }[] }) {
  const [topic, setTopic] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [maxRounds, setMaxRounds] = useState(5);
  const [showAdv, setShowAdv] = useState(false);
  const [tokenBudget, setTokenBudget] = useState(500_000);
  const [scopeGuard, setScopeGuard] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | undefined>();

  // Re-enable the Start button if the form is STILL mounted 4s after submit. On
  // success the panel flips to the live view and this form unmounts — the
  // cleanup clears the timer so we never setState on an unmounted form (#2413).
  useEffect(() => {
    if (!submitting) { return; }
    const t = setTimeout(() => setSubmitting(false), 4000);
    return () => clearTimeout(t);
  }, [submitting]);

  const toggle = (key: string) => setSelected(s => (s.includes(key) ? s.filter(k => k !== key) : [...s, key]));
  const topicShort = topic.trim().length > 0 && topic.trim().length < 5;
  const valid = topic.trim().length >= 5 && selected.length >= 2;

  const submit = () => {
    // Guard re-entry: a double-click would POST twice → the 2nd hits the
    // backend's one-active-brainstorm-per-project guard with a 409 (#2413).
    if (!valid || submitting) { return; }
    const lead = personas.find(p => p.key === selected[0]);
    // Don't hand the backend a dead/empty initiator session_id — the brainstorm
    // POST returns an opaque 409 if the lead's session FK doesn't resolve. The
    // lead must be a persona with a live session (#2414).
    if (!lead || !lead.sessionId) {
      setFormError('The lead persona has no live agent session — pick a persona whose agent is running.');
      return;
    }
    setFormError(undefined);
    setSubmitting(true);
    vscode.postMessage({
      type: 'brainstormStart',
      payload: {
        topic: topic.trim(),
        lead_persona_key: selected[0],
        session_id: lead.sessionId,
        participating_personas: selected.slice(1),
        max_rounds: maxRounds,
        scope_guard_enabled: scopeGuard,
        token_budget: tokenBudget,
      },
    });
    // Re-enable handled by the useEffect above (unmount-safe).
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Field label="Topic" hint={topicShort ? 'At least 5 characters' : undefined}>
        <textarea
          value={topic} onChange={e => setTopic(e.target.value)} rows={2} autoFocus maxLength={TOPIC_MAX}
          placeholder="What should the team brainstorm? e.g. “Design the rate-limiting strategy for the public API”"
          style={{ width: '100%', resize: 'vertical', fontSize: 13, padding: 9, borderRadius: 6, border: '1px solid var(--feed-border)', background: 'var(--vscode-input-background, var(--feed-bg))', color: 'var(--feed-fg)', fontFamily: 'inherit', boxSizing: 'border-box' }}
        />
        <div style={{ fontSize: 10, textAlign: 'right', marginTop: 3, color: topic.length >= TOPIC_MAX ? 'var(--feed-warning)' : 'var(--feed-muted)' }}>{topic.length}/{TOPIC_MAX}</div>
      </Field>

      <Field label="Team — pick ≥2 · first pick leads">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
          {personas.map(p => {
            const idx = selected.indexOf(p.key);
            const on = idx >= 0;
            const isLead = idx === 0;
            const color = personaColor(p.key);
            return (
              <button key={p.key} onClick={() => toggle(p.key)} style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, padding: '5px 10px', borderRadius: 999, cursor: 'pointer',
                border: `1px solid ${on ? color : 'var(--feed-border)'}`,
                background: on ? `color-mix(in oklab, ${color} 16%, transparent)` : 'transparent',
                color: 'var(--feed-fg)', fontWeight: on ? 600 : 400,
              }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
                {prettyPersona(p.key)}
                {isLead && <span style={{ fontSize: 9, fontWeight: 700, color }}>LEAD</span>}
              </button>
            );
          })}
        </div>
      </Field>

      <Field label={`Rounds — ${maxRounds}`}>
        <input type="range" min={3} max={10} value={maxRounds} onChange={e => setMaxRounds(Number(e.target.value))} style={{ width: '100%', accentColor: 'var(--feed-link)' }} />
      </Field>

      <button onClick={() => setShowAdv(a => !a)} style={{ ...ghostBtn, alignSelf: 'flex-start' }}>
        {showAdv ? '▾' : '▸'} Advanced
      </button>
      {showAdv && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '0 2px' }}>
          <Field label="Token budget">
            <select value={tokenBudget} onChange={e => setTokenBudget(Number(e.target.value))} style={{ ...selectStyle, width: '100%', padding: 6 }}>
              <option value={250_000}>250K</option>
              <option value={500_000}>500K</option>
              <option value={1_000_000}>1M</option>
              <option value={2_000_000}>2M</option>
            </select>
          </Field>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--feed-fg)', cursor: 'pointer' }}>
            <input type="checkbox" checked={scopeGuard} onChange={e => setScopeGuard(e.target.checked)} />
            Scope guard — flag responses that drift off-topic
          </label>
        </div>
      )}

      <button onClick={submit} disabled={!valid || submitting} style={{
        marginTop: 4, fontSize: 13, fontWeight: 600, padding: 10, borderRadius: 7, border: 'none',
        background: (valid && !submitting) ? 'var(--feed-link)' : 'var(--feed-border)',
        color: (valid && !submitting) ? '#0b0b0b' : 'var(--feed-muted)',
        cursor: (valid && !submitting) ? 'pointer' : 'not-allowed',
      }}>{submitting ? 'Starting…' : 'Start brainstorm'}</button>
      {formError && <div style={{ fontSize: 11, color: 'var(--feed-error)', marginTop: -8 }}>{formError}</div>}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--feed-fg)' }}>{label}</span>
        {hint && <span style={{ fontSize: 10, color: 'var(--feed-warning)' }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div style={{ width: '100%', height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'var(--feed-bg)' }}>
      {children}
    </div>
  );
}

function PaneTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className="brainstorm-pane-tab" style={{
      fontSize: 11, fontWeight: 600, padding: '4px 11px', borderRadius: 6, cursor: 'pointer',
      border: '1px solid var(--feed-border)',
      background: active ? 'color-mix(in oklab, var(--feed-link) 18%, transparent)' : 'transparent',
      color: active ? 'var(--feed-link)' : 'var(--feed-muted)',
    }}>{label}</button>
  );
}

interface ConfirmSpec {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  action: () => void;
}

function ConfirmModal({ spec, onClose }: { spec: ConfirmSpec | null; onClose: () => void }) {
  useEffect(() => {
    if (!spec) { return; }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [spec, onClose]);
  if (!spec) { return null; }
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" style={{ width: '100%', maxWidth: 380, margin: 16, padding: 18, borderRadius: 10, background: 'var(--vscode-editor-background, var(--feed-bg))', border: '1px solid var(--feed-border)', boxShadow: '0 8px 32px rgba(0,0,0,0.4)' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--feed-fg)', marginBottom: 8 }}>{spec.title}</div>
        <div style={{ fontSize: 12, color: 'var(--feed-muted)', lineHeight: 1.5, marginBottom: 16 }}>{spec.body}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button autoFocus onClick={onClose} style={ghostBtn}>Cancel</button>
          <button
            onClick={() => { spec.action(); onClose(); }}
            style={{ fontSize: 12, fontWeight: 600, padding: '6px 14px', borderRadius: 5, border: 'none', cursor: 'pointer', background: spec.danger ? 'var(--feed-error)' : 'var(--feed-link)', color: spec.danger ? '#fff' : '#0b0b0b' }}>{spec.confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

const ghostBtn: CSSProperties = {
  fontSize: 11, padding: '5px 11px', borderRadius: 4, border: '1px solid var(--feed-border)',
  background: 'transparent', color: 'var(--feed-muted)', cursor: 'pointer', fontWeight: 500,
};
const selectStyle: CSSProperties = {
  fontSize: 11, padding: '4px 6px', borderRadius: 4, border: '1px solid var(--feed-border)',
  background: 'var(--feed-bg)', color: 'var(--feed-fg)', cursor: 'pointer',
};
