import * as vscode from 'vscode';
import type { VibeFlowClient } from '../../api/client.js';
import { connectBearerUIWebSocket, type UIWebSocketConnection } from '../../sessions/SessionWorkingObserver.js';
import {
  deriveTerminalWsUrl,
  extractTerminalSessionId,
  encodeTerminalBind,
  encodeTerminalStdin,
  encodeTerminalResize,
  parseTerminalServerMessage,
} from '../../api/cloudRunners.js';

/**
 * Bridge a runner pod's PTY to a native VS Code terminal (#2818, reworked in
 * #3588 for the axiomcloud raw-PTY SockJS bridge): create a terminal session
 * (`POST terminal/session`), connect the Bearer-authenticated `wss://` socket
 * (owner/admin only, server-enforced), bind the session id as the first frame,
 * then relay stdin/resize up and stdout back. Frame contents are never logged
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
    wsUrl = deriveTerminalWsUrl(client.getValidatedBaseUrl(), projectId, id);
  } catch (err) {
    vscode.window.showErrorMessage(`VibeFlow: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const writeEmitter = new vscode.EventEmitter<string>();
  const closeEmitter = new vscode.EventEmitter<number | void>();
  let conn: UIWebSocketConnection | undefined;
  let dims: { cols: number; rows: number } | undefined;
  let closed = false;

  const pty: vscode.Pseudoterminal = {
    onDidWrite: writeEmitter.event,
    onDidClose: closeEmitter.event,
    open: () => {
      writeEmitter.fire(`Connecting to ${name}…\r\n`);
      void (async () => {
        // The session must exist before the socket binds to it.
        let sessionId: string;
        try {
          sessionId = extractTerminalSessionId(await client.createRunnerTerminalSession(projectId, id));
        } catch (err) {
          writeEmitter.fire(`\r\n[terminal error: ${err instanceof Error ? err.message : String(err)}]\r\n`);
          closeEmitter.fire();
          return;
        }
        if (!sessionId) {
          writeEmitter.fire('\r\n[terminal error: unable to open a terminal session]\r\n');
          closeEmitter.fire();
          return;
        }
        if (closed) { return; } // user closed the terminal during session create

        conn = connectBearerUIWebSocket(wsUrl, token, {
          onOpen: () => {
            conn?.send?.(encodeTerminalBind(sessionId));
            if (dims) { conn?.send?.(encodeTerminalResize(dims.cols, dims.rows)); }
          },
          onMessage: (text) => {
            const msg = parseTerminalServerMessage(text);
            if (msg.kind === 'stdout') {
              writeEmitter.fire(msg.data);
            } else if (msg.kind === 'error') {
              // Status only — the bridge closes the socket itself after a dial
              // failure, which lands in onClose (web parity).
              writeEmitter.fire(`\r\n[terminal error: ${msg.message}]\r\n`);
            }
            // 'ignore': other Ops / non-JSON frames are dropped.
          },
          onClose: () => closeEmitter.fire(),
          onError: (err) => {
            writeEmitter.fire(`\r\n[connection error: ${err.message}]\r\n`);
            closeEmitter.fire();
          },
        });
      })();
    },
    close: () => {
      closed = true;
      conn?.dispose();
      conn = undefined;
    },
    handleInput: (data) => {
      conn?.send?.(encodeTerminalStdin(data));
    },
    setDimensions: (d) => {
      dims = { cols: d.columns, rows: d.rows };
      conn?.send?.(encodeTerminalResize(d.columns, d.rows));
    },
  };

  const terminal = vscode.window.createTerminal({ name: `Runner: ${name}`, pty });
  terminal.show();
}
