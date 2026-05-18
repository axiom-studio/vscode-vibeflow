import { useEffect, useRef, useState, useCallback } from 'react';
import { getVsCodeApi } from '../../vscodeApi';

/**
 * Hook that owns the chat-attachment upload lifecycle (#1670).
 *
 *  - Reads File objects from paste / drag / picker
 *  - Validates client-side (cheap pre-checks; host re-validates authoritatively)
 *  - Encodes to base64 dataUrl, posts `chatUploadAsset` to the host
 *  - Tracks pending upload chips by clientId
 *  - Subscribes to `chatUploadProgress` messages and transitions chips
 *  - On `done`, appends `[asset:N "name"]` to the draft via `insertToken`
 *
 * Append-at-end semantics (rather than insert-at-cursor) is intentional:
 * the first attempt at this feature had a useEffect closure bug that
 * captured a stale cursor while uploads were in flight, so the token
 * always landed at offset 0. Appending dodges the bug class entirely
 * and matches the Slack/Discord UX pattern.
 */

export type PendingUploadStatus = 'uploading' | 'error';

export interface PendingUpload {
  clientId: string;
  name: string;
  mimeType: string;
  size: number;
  status: PendingUploadStatus;
  errorMessage?: string;
}

const MAX_BYTES = 32 * 1024 * 1024;

const vscode = getVsCodeApi() as { postMessage: (msg: unknown) => void };

let clientIdCounter = 0;
function nextClientId(): string {
  clientIdCounter++;
  return `upload-${Date.now()}-${clientIdCounter}`;
}

interface UploadDoneAsset {
  id: number;
  name: string;
  mimeType: string;
  size: number;
  category: string;
}

interface ProgressMessage {
  type: 'chatUploadProgress';
  payload:
    | { clientId: string; status: 'uploading' }
    | { clientId: string; status: 'done'; asset: UploadDoneAsset }
    | { clientId: string; status: 'error'; message: string };
}

export interface UseChatAttachmentsResult {
  pending: PendingUpload[];
  attachFiles(files: FileList | File[]): Promise<void>;
  dismiss(clientId: string): void;
}

/**
 * Build the canonical token shape. Filenames are escaped so a name
 * containing a `"` can't break out of the token. The host re-parses
 * via the same shape (see the postmortem doc § "Token regex
 * anti-injection").
 */
function buildAssetToken(asset: UploadDoneAsset): string {
  const safe = asset.name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `[asset:${asset.id} "${safe}"]`;
}

/**
 * Read a File into `data:<mime>;base64,...`. Resolves to undefined on
 * read error (caller surfaces as a chip error).
 */
function readFileAsDataUrl(file: File): Promise<string | undefined> {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      resolve(typeof result === 'string' ? result : undefined);
    };
    reader.onerror = () => resolve(undefined);
    reader.readAsDataURL(file);
  });
}

export function useChatAttachments(opts: {
  /** Called when an upload finishes successfully — append the token to the draft. */
  appendToDraft: (token: string) => void;
}): UseChatAttachmentsResult {
  const [pending, setPending] = useState<PendingUpload[]>([]);
  // Mirror onAppend in a ref so the message listener (registered once
  // on mount) calls the latest version even after parent re-renders.
  // This is the lesson learned from the prior closure-on-cursor bug.
  const appendRef = useRef(opts.appendToDraft);
  appendRef.current = opts.appendToDraft;

  useEffect(() => {
    function handle(event: MessageEvent<ProgressMessage>) {
      const msg = event.data;
      if (!msg || msg.type !== 'chatUploadProgress') { return; }
      const payload = msg.payload;
      if (payload.status === 'uploading') {
        return; // No-op — the chip is already in 'uploading' state since we set it locally.
      }
      if (payload.status === 'done') {
        const token = buildAssetToken(payload.asset);
        setPending(prev => prev.filter(p => p.clientId !== payload.clientId));
        appendRef.current(token);
        return;
      }
      if (payload.status === 'error') {
        setPending(prev => prev.map(p =>
          p.clientId === payload.clientId
            ? { ...p, status: 'error', errorMessage: payload.message }
            : p,
        ));
      }
    }
    window.addEventListener('message', handle);
    return () => { window.removeEventListener('message', handle); };
  }, []);

  const attachFiles = useCallback(async (files: FileList | File[]): Promise<void> => {
    const list = Array.from(files);
    for (const file of list) {
      const clientId = nextClientId();
      const mimeType = file.type || 'application/octet-stream';
      // Client-side pre-check; the host's check is the authority. A
      // local check just saves the round-trip on obvious-fail cases.
      if (file.size > MAX_BYTES) {
        setPending(prev => [...prev, {
          clientId,
          name: file.name,
          mimeType,
          size: file.size,
          status: 'error',
          errorMessage: `File exceeds 32MB cap.`,
        }]);
        continue;
      }
      setPending(prev => [...prev, {
        clientId,
        name: file.name,
        mimeType,
        size: file.size,
        status: 'uploading',
      }]);
      const dataUrl = await readFileAsDataUrl(file);
      if (!dataUrl) {
        setPending(prev => prev.map(p => p.clientId === clientId
          ? { ...p, status: 'error', errorMessage: 'Could not read file.' }
          : p));
        continue;
      }
      vscode.postMessage({
        type: 'chatUploadAsset',
        payload: {
          clientId,
          name: file.name,
          mimeType,
          size: file.size,
          dataUrl,
        },
      });
    }
  }, []);

  const dismiss = useCallback((clientId: string) => {
    setPending(prev => prev.filter(p => p.clientId !== clientId));
  }, []);

  return { pending, attachFiles, dismiss };
}
