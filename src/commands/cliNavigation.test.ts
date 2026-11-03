import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import { cliControlSocket, requestCliNavigation, waitForCliNavigation } from './cliNavigation.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) { await dispose(); } });

async function endpoint(onRequest: (request: string, socket: net.Socket) => void): Promise<string> {
  const dir = await fs.mkdtemp('/tmp/vf-nav-test-');
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  const server = net.createServer(socket => {
    let request = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', chunk => {
      request += chunk;
      if (request.includes('\n')) { onRequest(request, socket); }
    });
  });
  const address = `${dir}/control.sock`;
  await new Promise<void>(resolve => server.listen(address, resolve));
  cleanup.push(() => new Promise(resolve => server.close(() => resolve())));
  return address;
}
const response = { version: 1, ok: true, root: '/tmp/root', tmux_socket: 'test' };

describe('local CLI navigation transport', () => {
  it('sends an exact session identity over a real private socket and reads a fragmented acknowledgement', async () => {
    let received: unknown;
    const address = await endpoint((request, socket) => {
      received = JSON.parse(request);
      const body = JSON.stringify(response);
      socket.write(body.slice(0, 10));
      setTimeout(() => socket.end(body.slice(10) + '\n'), 10);
    });
    expect(await requestCliNavigation(address, { view: 'session', session: 'vibeflow_codex-exact-id' })).toEqual(response);
    expect(received).toEqual({ version: 1, view: 'session', session: 'vibeflow_codex-exact-id' });
  });

  it('surfaces server refusal and rejects an incompatible protocol', async () => {
    const rejected = await endpoint((_, socket) => socket.end(JSON.stringify({ ...response, ok: false, error: 'Session no longer running' }) + '\n'));
    await expect(requestCliNavigation(rejected, { view: 'project', session: 'vibeflow_gone' })).rejects.toThrow('Session no longer running');
    const incompatible = await endpoint((_, socket) => socket.end(JSON.stringify({ ...response, version: 2 }) + '\n'));
    await expect(requestCliNavigation(incompatible, { view: 'ping' })).rejects.toThrow('Update VibeFlow CLI');
  });

  it('bounds stalled and oversized replies', async () => {
    const stalled = await endpoint(() => {});
    await expect(requestCliNavigation(stalled, { view: 'ping' }, 30)).rejects.toThrow('acknowledge');
    const oversized = await endpoint((_, socket) => socket.end('x'.repeat(4097)));
    await expect(requestCliNavigation(oversized, { view: 'ping' })).rejects.toThrow('Invalid');
  });

  it('stops waiting when the owned terminal exits', async () => {
    await expect(waitForCliNavigation('/tmp/not-a-vibeflow-socket', () => true)).rejects.toThrow('exited');
  });

  it('recovers only the explicitly enabled terminal socket from argv', () => {
    expect(cliControlSocket(['--root', '/tmp/r', '--client', 'vscode', '--control-socket', '/tmp/a/control.sock'])).toBe('/tmp/a/control.sock');
    expect(cliControlSocket(['--control-socket', '/tmp/a/control.sock'])).toBeUndefined();
    expect(cliControlSocket('--client vscode --control-socket /tmp/a/control.sock')).toBeUndefined();
  });
});
