import { describe, expect, it, vi } from 'vitest';
import type { VibeFlowClient } from '../api/client.js';
import type { PollingCoordinator } from '../core/PollingCoordinator.js';
import {
  SessionWorkingObserver,
  readFrame,
  foldFrame,
  type UIWebSocketConnector,
  type UIWebSocketHandlers,
  type WorkingObserverLogger,
} from './SessionWorkingObserver.js';

function fakeLogger() {
  const lines: string[] = [];
  const logger: WorkingObserverLogger = {
    trace: msg => lines.push(`trace ${msg}`),
    debug: msg => lines.push(`debug ${msg}`),
    info: msg => lines.push(`info ${msg}`),
    warn: msg => lines.push(`warn ${msg}`),
    error: msg => lines.push(`error ${msg}`),
  };
  return { logger, lines };
}

describe('SessionWorkingObserver logging', () => {
  it('logs WebSocket connection and event activity without exposing the bearer token', () => {
    const secret = 'super-secret-token';
    const { logger, lines } = fakeLogger();
    let handlers: UIWebSocketHandlers | undefined;
    const connector: UIWebSocketConnector = (_url, _token, nextHandlers) => {
      handlers = nextHandlers;
      return { dispose: vi.fn() };
    };
    const client = {
      getToken: () => secret,
      getValidatedBaseUrl: () => 'https://cloud.axiomstudio.ai',
    } as unknown as VibeFlowClient;
    const coordinator = {
      subscribe: vi.fn(() => ({ dispose: vi.fn() })),
      query: vi.fn(),
    } as unknown as PollingCoordinator;
    const observer = new SessionWorkingObserver(
      client,
      28,
      coordinator,
      vi.fn(),
      { connector, logger, now: () => 1_000 },
    );

    observer.start();
    handlers?.onOpen();
    handlers?.onMessage(JSON.stringify({
      type: 'vibeflow_activity',
      data: {
        project_id: 28,
        session_id: 'session-1',
        summary: `working with Bearer ${secret}`,
      },
    }));

    const output = lines.join('\n');
    expect(output).toContain('connecting to wss://cloud.axiomstudio.ai/ws/ui');
    expect(output).toContain('connected to /ws/ui; using WebSocket events');
    expect(output).toContain('/ws/ui event received type=vibeflow_activity project=28 session=session-1');
    expect(output).toContain('Bearer [redacted]');
    expect(output).not.toContain(secret);
  });

  it('trace-logs the full frame payload — fields the debug summary drops — with bearer redacted (#2771)', () => {
    const secret = 'super-secret-token';
    const { logger, lines } = fakeLogger();
    let handlers: UIWebSocketHandlers | undefined;
    const connector: UIWebSocketConnector = (_url, _token, nextHandlers) => {
      handlers = nextHandlers;
      return { dispose: vi.fn() };
    };
    const client = {
      getToken: () => secret,
      getValidatedBaseUrl: () => 'https://cloud.axiomstudio.ai',
    } as unknown as VibeFlowClient;
    const coordinator = { subscribe: vi.fn(() => vi.fn()), query: vi.fn() } as unknown as PollingCoordinator;
    const observer = new SessionWorkingObserver(
      client,
      28,
      coordinator,
      vi.fn(),
      { connector, logger, now: () => 1_000 },
    );

    observer.start();
    handlers?.onOpen();
    handlers?.onMessage(JSON.stringify({
      type: 'vibeflow_activity',
      data: {
        project_id: 28,
        session_id: 'session-1',
        summary: 'building',
        // Fields the one-line debug summary never shows:
        milestone_name: 'tests_green',
        progress_pct: 80,
        auth_echo: `Bearer ${secret}`,
      },
    }));
    // Non-JSON frames must still be traceable — the dump runs before parsing.
    handlers?.onMessage('not-json-frame');

    const traceLines = lines.filter(l => l.startsWith('trace '));
    expect(traceLines.some(l => l.includes('milestone_name') && l.includes('tests_green') && l.includes('progress_pct'))).toBe(true);
    expect(traceLines.some(l => l.includes('not-json-frame'))).toBe(true);
    const output = lines.join('\n');
    expect(output).toContain('Bearer [redacted]');
    expect(output).not.toContain(secret);
    // The debug summary stays the compact view — no payload-only fields there.
    expect(lines.filter(l => l.startsWith('debug ')).some(l => l.includes('milestone_name'))).toBe(false);
  });
});

describe('WebSocket frame assembly (#3631)', () => {
  it('reassembles a text message fragmented across FIN=0 + continuation frames', () => {
    // Server-style unmasked frames: "hello world" split as
    // [0x01 text FIN=0] "hello " + [0x80 continuation FIN=1] "world".
    const first = Buffer.concat([Buffer.from([0x01, 6]), Buffer.from('hello ')]);
    const second = Buffer.concat([Buffer.from([0x80, 5]), Buffer.from('world')]);

    const f1 = readFrame(first);
    const f2 = readFrame(second);
    expect(f1).toMatchObject({ fin: false, opcode: 0x1 });
    expect(f2).toMatchObject({ fin: true, opcode: 0x0 });

    const step1 = foldFrame(undefined, f1!);
    expect(step1.complete).toBeUndefined();
    const step2 = foldFrame(step1.state, f2!);
    expect(step2.state).toBeUndefined();
    expect(step2.complete?.opcode).toBe(0x1);
    expect(step2.complete?.payload.toString('utf8')).toBe('hello world');
  });

  it('lets control frames interleave a fragmented message without corrupting it', () => {
    const start = foldFrame(undefined, { fin: false, opcode: 0x1, payload: Buffer.from('par'), bytesRead: 0 });
    // A ping (0x9) arrives mid-message — completes immediately, assembly kept.
    const ping = foldFrame(start.state, { fin: true, opcode: 0x9, payload: Buffer.from('p'), bytesRead: 0 });
    expect(ping.complete?.opcode).toBe(0x9);
    expect(ping.state).toEqual(start.state);
    const done = foldFrame(ping.state, { fin: true, opcode: 0x0, payload: Buffer.from('tial'), bytesRead: 0 });
    expect(done.complete?.payload.toString('utf8')).toBe('partial');
  });

  it('delivers single-frame messages directly and drops stray continuations', () => {
    const single = foldFrame(undefined, { fin: true, opcode: 0x1, payload: Buffer.from('whole'), bytesRead: 0 });
    expect(single.complete?.payload.toString('utf8')).toBe('whole');
    expect(single.state).toBeUndefined();
    const stray = foldFrame(undefined, { fin: true, opcode: 0x0, payload: Buffer.from('junk'), bytesRead: 0 });
    expect(stray.complete).toBeUndefined();
    expect(stray.state).toBeUndefined();
  });
});
