import { useState, useEffect, type CSSProperties } from 'react';
import { getVsCodeApi } from '../vscodeApi';
import type {
  CloudRunnerManageClientMessage,
  CloudRunnerManageHostMessage,
  CloudRunnerManageState,
} from '../../../src/core/webviewMessages';
import { VIBEFLOW_PERSONAS, canLaunch } from '../../../src/api/cloudRunners';

const vscode = getVsCodeApi() as { postMessage: (msg: CloudRunnerManageClientMessage) => void };

const wrap: CSSProperties = {
  fontFamily: 'var(--vscode-font-family)', color: 'var(--feed-fg)', background: 'var(--feed-bg)',
  minHeight: '100vh', padding: '20px 28px', boxSizing: 'border-box',
};
const btn: CSSProperties = {
  padding: '6px 14px', fontSize: 12, borderRadius: 4, cursor: 'pointer', border: 'none',
  background: 'var(--feed-button-bg)', color: 'var(--feed-button-fg)',
};
const ghostBtn: CSSProperties = { ...btn, background: 'transparent', color: 'var(--feed-fg)', border: '1px solid var(--feed-border)' };
const field: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12, fontSize: 12 };
const input: CSSProperties = {
  padding: '5px 8px', fontSize: 12, borderRadius: 4, border: '1px solid var(--feed-border)',
  background: 'var(--vscode-input-background)', color: 'var(--feed-fg)',
};
const label: CSSProperties = { fontSize: 11, fontWeight: 600, color: 'var(--feed-muted)', textTransform: 'uppercase', letterSpacing: 0.4 };

const STEP_LABELS: Record<CloudRunnerManageState['step'], string> = {
  authenticate: 'Authenticate',
  configure: 'Configure',
  launch: 'Launch',
};

export function CloudRunnerManageView() {
  const [state, setState] = useState<CloudRunnerManageState | undefined>(undefined);

  useEffect(() => {
    function handle(event: MessageEvent<CloudRunnerManageHostMessage>) {
      if (event.data?.type === 'manageState') { setState(event.data.payload); }
    }
    window.addEventListener('message', handle);
    vscode.postMessage({ type: 'manageLoad' });
    return () => window.removeEventListener('message', handle);
  }, []);

  if (!state) {
    return <div style={wrap}><p style={{ fontSize: 12, color: 'var(--feed-muted)' }}>Loading…</p></div>;
  }

  const steps: CloudRunnerManageState['step'][] = state.authMode === 'oauth'
    ? ['authenticate', 'configure', 'launch']
    : ['configure', 'launch'];

  return (
    <div style={wrap}>
      <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 4px' }}>Manage {state.runnerName}</h2>
      <div style={{ display: 'flex', gap: 14, margin: '10px 0 18px' }}>
        {steps.map(s => (
          <span key={s} style={{ fontSize: 12, fontWeight: s === state.step ? 700 : 400, color: s === state.step ? 'var(--feed-fg)' : 'var(--feed-muted)' }}>
            {STEP_LABELS[s]}
          </span>
        ))}
      </div>

      {state.error && (
        <div style={{ fontSize: 12, color: 'var(--feed-error)', marginBottom: 14 }}>{state.error}</div>
      )}

      {state.step === 'authenticate' && <AuthenticateStep state={state} />}
      {state.step === 'configure' && <ConfigureStep state={state} />}
      {state.step === 'launch' && <LaunchStep state={state} />}
    </div>
  );
}

function AuthenticateStep({ state }: { state: CloudRunnerManageState }) {
  const [code, setCode] = useState('');

  if (!state.podReady) {
    return <p style={{ fontSize: 12, color: 'var(--feed-muted)' }}>Pod is starting ({state.podStatus || 'pending'})…</p>;
  }

  if (!state.oauthUrl) {
    return (
      <div>
        <p style={{ fontSize: 12, marginBottom: 12 }}>Authenticate the agent on this runner to continue.</p>
        <button style={btn} disabled={state.busy} onClick={() => vscode.postMessage({ type: 'manageStartOAuth' })}>
          Start authentication
        </button>
      </div>
    );
  }

  return (
    <div>
      <div style={field}>
        <span style={label}>Authentication URL</span>
        <a href={state.oauthUrl} style={{ fontSize: 12, color: 'var(--feed-link, #4daafc)', wordBreak: 'break-all' }}>{state.oauthUrl} ↗</a>
      </div>
      {state.oauthCode && (
        <div style={field}>
          <span style={label}>Device code</span>
          <code style={{ fontSize: 13, padding: '4px 8px', background: 'var(--vscode-textCodeBlock-background)', borderRadius: 4, alignSelf: 'flex-start' }}>{state.oauthCode}</code>
        </div>
      )}
      {state.needsPasteBack ? (
        <div style={field}>
          <span style={label}>Paste the code shown after you sign in</span>
          <input style={input} value={code} onChange={e => setCode(e.target.value)} placeholder="verification code" />
          <button
            style={{ ...btn, marginTop: 6, alignSelf: 'flex-start' }}
            disabled={state.busy || !code.trim()}
            onClick={() => vscode.postMessage({ type: 'manageSubmitOAuth', payload: { code: code.trim() } })}
          >Submit code</button>
        </div>
      ) : (
        <p style={{ fontSize: 12, color: 'var(--feed-muted)' }}>Waiting for confirmation…</p>
      )}
    </div>
  );
}

function ConfigureStep({ state }: { state: CloudRunnerManageState }) {
  const [workingDir, setWorkingDir] = useState('');
  const [project, setProject] = useState(state.defaultProject);
  const [personas, setPersonas] = useState<string[]>([]);
  const [sessionType, setSessionType] = useState<'vibeflow' | 'vanilla'>('vibeflow');
  const [branch, setBranch] = useState('main');
  const [worktree, setWorktree] = useState(false);
  const [newBranch, setNewBranch] = useState(false);
  const [llmGateway, setLlmGateway] = useState(false);
  const [skipPermissions, setSkipPermissions] = useState(true);

  useEffect(() => {
    if (!project && state.defaultProject) { setProject(state.defaultProject); }
    if (!workingDir && state.repos[0]?.path) { setWorkingDir(state.repos[0].path); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.defaultProject, state.repos]);

  function togglePersona(p: string) {
    setPersonas(cur => cur.includes(p) ? cur.filter(x => x !== p) : [...cur, p]);
  }

  const ready = canLaunch(workingDir, project, personas);

  return (
    <div style={{ maxWidth: 560 }}>
      <div style={field}>
        <span style={label}>Working directory</span>
        {state.repos.length > 0 ? (
          <select style={input} value={workingDir} onChange={e => setWorkingDir(e.target.value)}>
            <option value="">Select a repo…</option>
            {state.repos.map(r => <option key={r.path} value={r.path}>{r.path}{r.branch ? ` (${r.branch})` : ''}</option>)}
          </select>
        ) : (
          <input style={input} value={workingDir} onChange={e => setWorkingDir(e.target.value)} placeholder="/workspace/repos/app" />
        )}
      </div>

      <div style={field}>
        <span style={label}>Project</span>
        <input style={input} list="vf-agent-projects" value={project} onChange={e => setProject(e.target.value)} placeholder="vibeflow project name" />
        <datalist id="vf-agent-projects">
          {state.agentProjects.map(p => <option key={p} value={p} />)}
        </datalist>
      </div>

      <div style={field}>
        <span style={label}>Personas</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {VIBEFLOW_PERSONAS.map(p => (
            <label key={p} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
              <input type="checkbox" checked={personas.includes(p)} onChange={() => togglePersona(p)} />
              {p}
            </label>
          ))}
        </div>
      </div>

      <div style={field}>
        <span style={label}>Session type</span>
        <select style={input} value={sessionType} onChange={e => setSessionType(e.target.value as 'vibeflow' | 'vanilla')}>
          <option value="vibeflow">vibeflow</option>
          <option value="vanilla">vanilla</option>
        </select>
      </div>

      <div style={field}>
        <span style={label}>Git branch</span>
        <input style={input} value={branch} onChange={e => setBranch(e.target.value)} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14, fontSize: 12 }}>
        <label><input type="checkbox" checked={worktree} onChange={e => setWorktree(e.target.checked)} /> Create git worktree</label>
        <label><input type="checkbox" checked={newBranch} onChange={e => setNewBranch(e.target.checked)} /> Create new branch</label>
        <label><input type="checkbox" checked={skipPermissions} onChange={e => setSkipPermissions(e.target.checked)} /> Skip permission prompts (autonomous)</label>
        <label><input type="checkbox" checked={llmGateway} onChange={e => setLlmGateway(e.target.checked)} /> Route LLM through Axiom Cloud Gateway</label>
      </div>

      <button
        style={{ ...btn, opacity: ready && !state.busy ? 1 : 0.5, cursor: ready && !state.busy ? 'pointer' : 'not-allowed' }}
        disabled={!ready || state.busy}
        onClick={() => vscode.postMessage({
          type: 'manageLaunch',
          payload: { workingDir, project, personas, sessionType, branch, worktree, newBranch, llmGateway, skipPermissions },
        })}
      >Launch</button>
    </div>
  );
}

function LaunchStep({ state }: { state: CloudRunnerManageState }) {
  const phase = state.launchPhase;
  return (
    <div>
      {state.launching && <p style={{ fontSize: 12, color: 'var(--feed-muted)' }}>Launching… waiting for the session to come up.</p>}
      {phase === 'running' && <p style={{ fontSize: 13, color: 'var(--feed-success, #3fb950)' }}>✓ Session is running.</p>}
      {phase === 'error' && (
        <div>
          <p style={{ fontSize: 13, color: 'var(--feed-error)' }}>Launch failed.</p>
          {state.launchErrors?.map((e, i) => <p key={i} style={{ fontSize: 12, color: 'var(--feed-muted)' }}>{e}</p>)}
        </div>
      )}
      {phase === 'timeout' && <p style={{ fontSize: 12, color: 'var(--feed-muted)' }}>Still starting — it may still come up; check the terminal.</p>}
      <button
        style={{ ...ghostBtn, marginTop: 16 }}
        onClick={() => vscode.postMessage({ type: 'manageAdvance', payload: { step: 'configure' } })}
      >Back to configuration</button>
    </div>
  );
}
