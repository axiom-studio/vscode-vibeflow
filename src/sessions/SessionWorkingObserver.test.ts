import { describe, expect, it, vi } from 'vitest';
import type { VibeFlowClient } from '../api/client.js';
import type { PollingCoordinator } from '../core/PollingCoordinator.js';
import {
  SessionWorkingObserver,
  type UIWebSocketConnector,
  type UIWebSocketHandlers,
  type WorkingObserverLogger,
} from './SessionWorkingObserver.js';

function fakeLogger() {
  const lines: string[] = [];
  const logger: WorkingObserverLogger = {
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
});
