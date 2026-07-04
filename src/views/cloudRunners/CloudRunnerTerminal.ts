import * as vscode from 'vscode';
import type { VibeFlowClient } from '../../api/client.js';
import { connectBearerUIWebSocket, type UIWebSocketConnection } from '../../sessions/SessionWorkingObserver.js';
import {
  deriveTmuxWsUrl,
  encodeTmuxInput,
  encodeTmuxResize,
  parseTmuxServerFrame,
} from '../../api/cloudRunners.js';

/**
 * Bridge a runner pod's tmux WebSocket to a native VS Code terminal (#2818,
 * spec #436 §4.4). The socket is a Bearer-authenticated `wss://` connection
 * (owner/admin only, server-enforced); keystrokes/resizes go up as JSON frames
 * and terminal output comes back as raw frames. Frame contents are never logged
 * (they can echo keystrokes/secrets).
 */
export function openRunnerTerminal(
  client: VibeFlowClient,
  projectId: number,
  id: number,
  name: string,
): void {
  const token = client.getToken();
  if (!token) {
    vscode.window.showErrorMessage('VibeFlow: Not logged in. Run "VibeFlow: Setup" first.');
    return;
  }

  let wsUrl: string;
  try {
    wsUrl = deriveTmuxWsUrl(client.getValidatedBaseUrl(), projectId, id);
  } catch (err) {
    vscode.window.showErrorMessage(`VibeFlow: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const writeEmitter = new vscode.EventEmitter<string>();
  const closeEmitter = new vscode.EventEmitter<number | void>();
  let conn: UIWebSocketConnection | undefined;
  let dims: { cols: number; rows: number } | undefined;

  const pty: vscode.Pseudoterminal = {
    onDidWrite: writeEmitter.event,
    onDidClose: closeEmitter.event,
    open: () => {
      writeEmitter.fire(`Connecting to ${name}…\r\n`);
      conn = connectBearerUIWebSocket(wsUrl, token, {
        onOpen: () => {
          if (dims) { conn?.send?.(encodeTmuxResize(dims.cols, dims.rows)); }
        },
        onMessage: (text) => {
          const frame = parseTmuxServerFrame(text);
          if (frame.kind === 'error') {
            writeEmitter.fire(`\r\n[terminal error: ${frame.message}]\r\n`);
            closeEmitter.fire();
          } else {
            writeEmitter.fire(frame.data);
          }
        },
        onClose: () => closeEmitter.fire(),
        onError: (err) => {
          writeEmitter.fire(`\r\n[connection error: ${err.message}]\r\n`);
          closeEmitter.fire();
        },
      });
    },
    close: () => {
      conn?.dispose();
      conn = undefined;
    },
    handleInput: (data) => {
      conn?.send?.(encodeTmuxInput(data));
    },
    setDimensions: (d) => {
      dims = { cols: d.columns, rows: d.rows };
      conn?.send?.(encodeTmuxResize(d.columns, d.rows));
    },
  };

  const terminal = vscode.window.createTerminal({ name: `Runner: ${name}`, pty });
  terminal.show();
}
