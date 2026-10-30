import * as net from 'net';

export interface CliNavigationTarget {
  view: 'project' | 'session';
  /** Exact local tmux session name from the CLI store. */
  session: string;
}

export interface CliNavigationResponse {
  version: 1;
  ok: boolean;
  error?: string;
  root: string;
  tmux_socket: string;
}

/** One bounded, acknowledged request. This channel never carries terminal input. */
export function requestCliNavigation(
  socketPath: string,
  target: CliNavigationTarget | { view: 'ping' },
  timeoutMs = 25_000,
): Promise<CliNavigationResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let response = '';
    let settled = false;
    const finish = (error?: Error, result?: CliNavigationResponse): void => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) { reject(error); } else { resolve(result!); }
    };
    const timer = setTimeout(() => finish(new Error('VibeFlow CLI did not acknowledge navigation in time.')), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify({ version: 1, ...target }) + '\n'));
    socket.on('error', error => finish(error));
    socket.on('end', () => finish(new Error('VibeFlow CLI closed the navigation connection.')));
    socket.on('data', (chunk: string) => {
      response += chunk;
      if (response.length > 4096) { finish(new Error('Invalid VibeFlow CLI navigation response.')); return; }
      const newline = response.indexOf('\n');
      if (newline === -1) { return; }
      try {
        const result = JSON.parse(response.slice(0, newline)) as Partial<CliNavigationResponse>;
        if (result.version !== 1 || typeof result.ok !== 'boolean'
          || typeof result.root !== 'string' || typeof result.tmux_socket !== 'string') {
          throw new Error('Update VibeFlow CLI to use Agent Fleet navigation.');
        }
        if (!result.ok) { throw new Error(typeof result.error === 'string' ? result.error : 'CLI navigation failed.'); }
        finish(undefined, result as CliNavigationResponse);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

/** Terminal creation arguments survive extension-host reloads. No global socket lookup. */
export function cliControlSocket(args: string | readonly string[] | undefined): string | undefined {
  if (!Array.isArray(args)) { return undefined; }
  const client = args.indexOf('--client');
  const socket = args.indexOf('--control-socket');
  return client >= 0 && args[client + 1] === 'vscode' && socket >= 0
    ? args[socket + 1] : undefined;
}

export async function waitForCliNavigation(
  socketPath: string,
  isClosed: () => boolean,
  timeoutMs = 30_000,
): Promise<CliNavigationResponse> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isClosed()) { throw new Error('VibeFlow CLI exited before navigation was ready. Reopen the CLI to retry.'); }
    try {
      return await requestCliNavigation(socketPath, { view: 'ping' }, Math.min(1000, deadline - Date.now()));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ECONNREFUSED') { throw error; }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }
  throw new Error('VibeFlow CLI is not ready. Finish setup in its terminal, then click the agent again.');
}
