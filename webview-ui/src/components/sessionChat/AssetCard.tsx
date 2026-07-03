import { useEffect, useState } from 'react';
import { getVsCodeApi } from '../../vscodeApi';
import { FileIcon, SpinnerIcon } from '../_shared/icons';

/**
 * Inline render of a `[asset:N "name"]` token from chat (#1670). Asks
 * the host to resolve the asset id into a webview-safe URI on mount,
 * then renders one of:
 *
 *   - extension looks like an image → `<img src={uri}>`
 *   - everything else → file card (icon + name + size + "Open" link)
 *   - error → red chip with the host's message
 *
 * Single source of truth for which renderer to use: file extension.
 * The host already validated the MIME at upload time (`verifyDeclaredMime`),
 * so we trust the name's extension as a proxy. If an image fails to
 * load (corrupt bytes, removed from cache), we fall back to the file
 * card via `<img onError>`.
 *
 * Both flavors are inline-compatible (`display: inline-block`) so the
 * card can sit inside a `<p>` without breaking React's HTML-nesting
 * warnings — same constraint the commit-hash + path buttons follow.
 */

const vscode = getVsCodeApi() as { postMessage: (msg: unknown) => void };

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'heic', 'heif', 'tif', 'tiff']);

interface AssetCardProps {
  id: number;
  name: string;
}

interface ResolvedMessage {
  type: 'chatAssetUriResolved';
  payload: { id: number; uri: string } | { id: number; error: string };
}

/** Bounded auto-retry for resolve failures (#3345): after a restart the
 *  cache may be empty and the host's re-download races the async auth /
 *  project-connection restore, so the mount-time resolve can fail while
 *  everything is healthy a second later. 3 attempts at ~1s/3s/9s absorb
 *  that window; beyond it the failed chip is click-to-retry. */
const AUTO_RETRY_LIMIT = 3;
const AUTO_RETRY_BASE_MS = 1_000;

export function AssetCard({ id, name }: AssetCardProps) {
  const [uri, setUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imageBroken, setImageBroken] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    function handle(event: MessageEvent<ResolvedMessage>) {
      const msg = event.data;
      if (!msg || msg.type !== 'chatAssetUriResolved') { return; }
      if (msg.payload.id !== id) { return; }
      if ('uri' in msg.payload) {
        setUri(msg.payload.uri);
        setError(null);
      } else {
        setError(msg.payload.error);
      }
    }
    window.addEventListener('message', handle);
    vscode.postMessage({ type: 'chatGetAssetUri', payload: { id, name } });
    return () => { window.removeEventListener('message', handle); };
  }, [id, name, attempt]);

  useEffect(() => {
    if (!error || attempt >= AUTO_RETRY_LIMIT) { return; }
    const timer = window.setTimeout(() => {
      setError(null);
      setAttempt(a => a + 1);
    }, AUTO_RETRY_BASE_MS * Math.pow(3, attempt));
    return () => { window.clearTimeout(timer); };
  }, [error, attempt]);

  const retryNow = (): void => {
    setError(null);
    setAttempt(a => a + 1);
  };

  const ext = (name.split('.').pop() ?? '').toLowerCase();
  const looksLikeImage = IMAGE_EXTS.has(ext);

  const openInVSCode = (): void => {
    vscode.postMessage({ type: 'chatOpenAsset', payload: { id, name } });
  };

  if (error) {
    return (
      <button
        type="button"
        className="asset-card is-error"
        title={`${error} — click to retry`}
        onClick={retryNow}
      >
        <FileIcon size={12} />
        <span className="asset-card-name">{name}</span>
        <span className="asset-card-error">failed — retry</span>
      </button>
    );
  }

  if (!uri) {
    return (
      <span className="asset-card is-loading">
        <SpinnerIcon size={12} />
        <span className="asset-card-name">{name}</span>
      </span>
    );
  }

  if (looksLikeImage && !imageBroken) {
    return (
      <img
        src={uri}
        alt={name}
        className="asset-image"
        onError={() => setImageBroken(true)}
        onClick={openInVSCode}
        title={`${name} — click to open`}
      />
    );
  }

  // File card — clicking fires `chatOpenAsset`, host routes through
  // `vscode.open` which picks the right viewer (built-in PDF / text
  // editor / external app prompt for unknown binaries). More reliable
  // than the previous `<a download>` approach, which VSCode can
  // intercept in unpredictable ways.
  return (
    <button
      type="button"
      onClick={openInVSCode}
      className="asset-card is-file"
      title={`Open ${name}`}
    >
      <FileIcon size={12} />
      <span className="asset-card-name">{name}</span>
    </button>
  );
}
