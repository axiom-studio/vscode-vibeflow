import { useState, useEffect, type CSSProperties } from 'react';
import { getVsCodeApi } from '../vscodeApi';
import type {
  CloudRunnerManageClientMessage,
  CloudRunnerManageHostMessage,
  CloudRunnerManageState,
} from '../../../src/core/webviewMessages';
import {
  WORKSPACE_PERSONAS,
  ADVISORY_PERSONAS,
  togglePersonaSelection,
  canLaunch,
  CUSTOM_MODEL_VALUE,
  defaultModelForAgent,
  isPresetModel,
  modelOptionsForAgent,
  llmGatewaySupportedForAgent,
} from '../../../src/api/cloudRunners';

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

  // Hold until the initial hydrate completes (#2885/#2886). The host's first
  // push carries constructor defaults (agentType '', no savedConfig) — mounting
  // a step on it latches blanks into the form's state initializers, and they
  // never re-run when the real data arrives on the next push.
  if (!state || !state.hydrated) {
    return <div style={wrap}><p style={{ fontSize: 12, color: 'var(--feed-muted)' }}>Loading…</p></div>;
  }

  const steps: CloudRunnerManageState['step'][] = state.authMode === 'oauth'
    ? ['authenticate', 'configure', 'launch']
    : ['configure', 'launch'];

  return (
    <div style={wrap}>
      <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 4px' }}>Manage {state.runnerName}</h2>
      <div style={{ display: 'flex', gap: 14, margin: '10px 0 18px', alignItems: 'center' }}>
        {steps.map(s => (
          <span key={s} style={{ fontSize: 12, fontWeight: s === state.step ? 700 : 400, color: s === state.step ? 'var(--feed-fg)' : 'var(--feed-muted)' }}>
            {STEP_LABELS[s]}
          </span>
        ))}
        <button
          style={{ ...ghostBtn, marginLeft: 'auto', padding: '4px 10px' }}
          onClick={() => vscode.postMessage({ type: 'manageOpenTerminal' })}
        >Open terminal</button>
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
  // '' | 'url' | 'code' — which value was just copied (for the "Copied ✓" flash).
  const [copied, setCopied] = useState<'' | 'url' | 'code'>('');

  async function copy(text: string, which: 'url' | 'code') {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(''), 1500);
    } catch { /* clipboard unavailable in this host — no-op */ }
  }

  if (!state.podReady) {
    return <p style={{ fontSize: 12, color: 'var(--feed-muted)' }}>Pod is starting ({state.podStatus || 'pending'})…</p>;
  }

  if (!state.oauthUrl) {
    return (
      <div>
        <p style={{ fontSize: 12, marginBottom: 12 }}>Authenticate the agent on this runner to continue.</p>
        <button style={btn} disabled={state.busy} onClick={() => vscode.postMessage({ type: 'manageStartOAuth' })}>
          {state.busy ? 'Starting…' : 'Start authentication'}
        </button>
      </div>
    );
  }

  return (
    <div>
      <div style={field}>
        <span style={label}>Sign in</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* Clean button instead of the raw URL dump (web parity) — the full
              URL stays on the href and is available via Copy link. */}
          <a href={state.oauthUrl} style={{ ...btn, textDecoration: 'none', display: 'inline-block' }}>Open sign-in page ↗</a>
          <button style={ghostBtn} onClick={() => copy(state.oauthUrl ?? '', 'url')}>
            {copied === 'url' ? 'Copied ✓' : 'Copy link'}
          </button>
        </div>
      </div>
      {state.oauthCode && (
        <div style={field}>
          <span style={label}>Device code</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <code style={{ fontSize: 13, padding: '4px 8px', background: 'var(--vscode-textCodeBlock-background)', borderRadius: 4 }}>{state.oauthCode}</code>
            <button style={ghostBtn} onClick={() => copy(state.oauthCode ?? '', 'code')}>
              {copied === 'code' ? 'Copied ✓' : 'Copy'}
            </button>
          </div>
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
  // Defaults come from the saved manifest when the runner is already
  // configured (#2885), and the model preset from the loaded agentType (#2886).
  // Both are read once, at mount — safe only because the view holds "Loading…"
  // until state.hydrated, so this step cannot mount before the data lands.
  const saved = state.savedConfig;
  const [workingDir, setWorkingDir] = useState(saved?.workingDir ?? '');
  const [project, setProject] = useState(state.defaultProject);
  const [personas, setPersonas] = useState<string[]>(saved?.personas ?? []);
  const [sessionType, setSessionType] = useState<'vibeflow' | 'vanilla'>(saved?.sessionType ?? 'vibeflow');
  const [branch, setBranch] = useState(saved?.branch ?? 'main');
  const [worktree, setWorktree] = useState(saved?.worktree ?? false);
  const [worktreeName, setWorktreeName] = useState(saved?.worktreeName ?? '');
  const [newBranch, setNewBranch] = useState(saved?.newBranch ?? false);
  const [llmGateway, setLlmGateway] = useState(saved?.llmGateway ?? false);
  const [skipPermissions, setSkipPermissions] = useState(saved?.skipPermissions ?? true);
  // Model (#2886): per-agent presets + custom id, saved-manifest aware.
  const [model, setModel] = useState(saved?.model ?? defaultModelForAgent(state.agentType));
  const [modelMode, setModelMode] = useState<'preset' | 'custom'>(
    saved?.model && !isPresetModel(state.agentType, saved.model) ? 'custom' : 'preset',
  );
  // "+ Clone repository" inline form (web CloudRunnerDetail parity). The host
  // injects the provider's git credentials BEFORE the clone, which is also the
  // recovery path for push access on a relaunched pod (pod creds are ephemeral).
  const [showCloneForm, setShowCloneForm] = useState(false);
  const [cloneUrl, setCloneUrl] = useState('');
  const [cloneBranch, setCloneBranch] = useState('main');
  const [cloneProviderId, setCloneProviderId] = useState('');

  useEffect(() => {
    if (!project && state.defaultProject) { setProject(state.defaultProject); }
    if (!workingDir && state.repos[0]?.path) { setWorkingDir(state.repos[0].path); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.defaultProject, state.repos]);

  function togglePersona(p: string) {
    // Workspace personas behave like a radio (one replaces another); advisory
    // personas toggle (#2887).
    setPersonas(cur => togglePersonaSelection(cur, p));
  }

  function submitClone() {
    vscode.postMessage({
      type: 'manageClone',
      payload: {
        gitProviderId: cloneProviderId ? Number(cloneProviderId) : undefined,
        url: cloneUrl.trim(),
        branch: cloneBranch.trim() || 'main',
      },
    });
    // The host pushes busy → refreshed repos (or an error into the banner).
    setCloneUrl('');
    setShowCloneForm(false);
  }

  function handleModelSelect(value: string) {
    if (value === CUSTOM_MODEL_VALUE) {
      setModelMode('custom');
      setModel(isPresetModel(state.agentType, model) ? '' : model);
      return;
    }
    setModelMode('preset');
    setModel(value);
  }

  const modelOptions = modelOptionsForAgent(state.agentType, modelMode === 'preset' ? model : undefined);
  const gatewaySupported = llmGatewaySupportedForAgent(state.agentType);
  const ready = canLaunch(workingDir, project, personas) && (modelMode !== 'custom' || model.trim() !== '');

  return (
    <div style={{ maxWidth: 560 }}>
      <div style={field}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <span style={label}>Working directory</span>
          <button
            style={{ ...ghostBtn, padding: '2px 8px', fontSize: 11 }}
            onClick={() => setShowCloneForm(v => !v)}
          >{showCloneForm ? 'Cancel' : '+ Clone repository'}</button>
        </div>
        {showCloneForm && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 10, margin: '6px 0', border: '1px solid var(--feed-border)', borderRadius: 4 }}>
            <div style={field}>
              <span style={label}>Repository URL</span>
              <input style={input} value={cloneUrl} onChange={e => setCloneUrl(e.target.value)} placeholder="https://github.com/org/repo.git" />
            </div>
            <div style={field}>
              <span style={label}>Branch</span>
              <input style={input} value={cloneBranch} onChange={e => setCloneBranch(e.target.value)} />
            </div>
            <div style={field}>
              <span style={label}>Git provider</span>
              <select style={input} value={cloneProviderId} onChange={e => setCloneProviderId(e.target.value)}>
                <option value="">None (public repos only)</option>
                {state.gitProviders.map(p => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
              </select>
            </div>
            <button
              style={{ ...btn, alignSelf: 'flex-start', opacity: state.busy || !cloneUrl.trim() ? 0.5 : 1 }}
              disabled={state.busy || !cloneUrl.trim()}
              onClick={submitClone}
            >{state.busy ? 'Cloning…' : 'Clone'}</button>
          </div>
        )}
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
        <span style={label}>Workspace agent — choose one</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {WORKSPACE_PERSONAS.map(p => (
            <label key={p} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
              <input type="radio" name="workspace-persona" checked={personas.includes(p)} onChange={() => togglePersona(p)} />
              {p}
            </label>
          ))}
        </div>
      </div>

      <div style={field}>
        <span style={label}>Advisory &amp; review — select any</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {ADVISORY_PERSONAS.map(p => (
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
        <span style={label}>Model</span>
        <select
          style={input}
          value={modelMode === 'custom' ? CUSTOM_MODEL_VALUE : model}
          onChange={e => handleModelSelect(e.target.value)}
        >
          {modelOptions.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          <option value={CUSTOM_MODEL_VALUE}>Custom model id</option>
        </select>
      </div>
      {modelMode === 'custom' && (
        <div style={field}>
          <span style={label}>Custom model id</span>
          <input style={input} value={model} onChange={e => setModel(e.target.value)} placeholder="provider/model-id" />
        </div>
      )}

      <div style={field}>
        <span style={label}>Git branch</span>
        <input style={input} value={branch} onChange={e => setBranch(e.target.value)} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14, fontSize: 12 }}>
        <label><input type="checkbox" checked={worktree} onChange={e => setWorktree(e.target.checked)} /> Create git worktree</label>
        {worktree && (
          <input
            style={{ ...input, marginLeft: 20 }}
            value={worktreeName}
            onChange={e => setWorktreeName(e.target.value)}
            placeholder="Worktree name (optional — auto-generated when blank)"
          />
        )}
        <label><input type="checkbox" checked={newBranch} onChange={e => setNewBranch(e.target.checked)} /> Create new branch</label>
        <label><input type="checkbox" checked={skipPermissions} onChange={e => setSkipPermissions(e.target.checked)} /> Skip permission prompts (autonomous)</label>
        <label style={gatewaySupported ? undefined : { opacity: 0.5 }}>
          <input
            type="checkbox"
            checked={llmGateway && gatewaySupported}
            disabled={!gatewaySupported}
            onChange={e => setLlmGateway(e.target.checked)}
          /> Route LLM through Axiom Cloud Gateway{gatewaySupported ? '' : ' (not applicable — Cursor uses its own account)'}
        </label>
      </div>

      <button
        style={{ ...btn, opacity: ready && !state.busy ? 1 : 0.5, cursor: ready && !state.busy ? 'pointer' : 'not-allowed' }}
        disabled={!ready || state.busy}
        onClick={() => vscode.postMessage({
          type: 'manageLaunch',
          payload: { workingDir, project, personas, sessionType, model: model.trim(), branch, worktree, worktreeName: worktreeName.trim(), newBranch, llmGateway: llmGateway && gatewaySupported, skipPermissions },
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
