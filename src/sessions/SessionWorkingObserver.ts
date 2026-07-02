import * as http from 'http';
import * as https from 'https';
import { createHash, randomBytes } from 'crypto';
import type { Socket } from 'net';
import type { VibeFlowClient } from '../api/client.js';
import type { VibeFlowIssue, VibeFlowSession, VibeFlowTodo } from '../api/types.js';
import type { Disposer, PollingCoordinator } from '../core/PollingCoordinator.js';
import { liveIntervalMs } from '../core/pollingConfig.js';
import { isActiveSession } from './sessionStatus.js';
import {
  buildUIWebSocketUrl,
  SessionWorkingState,
  type WorkingActivityInput,
  type WorkingIndicatorUpdate,
} from './workingIndicator.js';

export interface UIWebSocketHandlers {
  onOpen(): void;
  onMessage(message: string): void;
  onClose(reason: string): void;
  onError(error: Error): void;
}

export interface UIWebSocketConnection extends Disposer {}

export type UIWebSocketConnector = (
  url: string,
  bearerToken: string,
  handlers: UIWebSocketHandlers,
) => UIWebSocketConnection;

export interface WorkingObserverLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

interface SessionWorkingObserverOptions {
  connector?: UIWebSocketConnector;
  logger?: WorkingObserverLogger;
  now?: () => number;
  reconnectBackoffMs?: number[];
}

const DEFAULT_RECONNECT_BACKOFF_MS = [2_000, 5_000, 10_000, 30_000];
const NOOP_LOGGER: WorkingObserverLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export class SessionWorkingObserver implements Disposer {
  private readonly state = new SessionWorkingState();
  private readonly connector: UIWebSocketConnector;
  private readonly logger: WorkingObserverLogger;
  private readonly now: () => number;
  private readonly reconnectBackoffMs: number[];
  private ws: UIWebSocketConnection | undefined;
  private pollSub: Disposer | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private reconnectAttempt = 0;
  private source: WorkingIndicatorUpdate['source'] = 'websocket';
  private connection: WorkingIndicatorUpdate['connection'] = 'connecting';
  private detail: string | undefined;
  private readonly lastSessionMessageAt = new Map<string, string>();

  constructor(
    private readonly client: VibeFlowClient,
    private readonly projectId: number,
    private readonly coordinator: PollingCoordinator,
    private readonly emit: (update: WorkingIndicatorUpdate) => void,
    options: SessionWorkingObserverOptions = {},
  ) {
    this.connector = options.connector ?? connectBearerUIWebSocket;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.now = options.now ?? Date.now;
    this.reconnectBackoffMs = options.reconnectBackoffMs ?? DEFAULT_RECONNECT_BACKOFF_MS;
  }

  start(): void {
    this.stop();
    this.stopped = false;
    this.state.clearProject(this.projectId);
    this.lastSessionMessageAt.clear();
    this.openWebSocket();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.dispose();
    this.ws = undefined;
    this.pollSub?.dispose();
    this.pollSub = undefined;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.state.clearProject(this.projectId);
    this.source = 'websocket';
    this.connection = 'connecting';
    this.detail = undefined;
    this.emitCurrent();
  }

  dispose(): void {
    this.stop();
  }

  private openWebSocket(): void {
    if (this.stopped) { return; }

    const token = this.client.getToken();
    if (!token) {
      this.logger.warn('Working indicator: WebSocket unavailable: missing API key; using REST fallback');
      this.switchToPolling('WebSocket unavailable: missing API key');
      return;
    }

    let wsUrl: string;
    try {
      wsUrl = buildUIWebSocketUrl(this.client.getValidatedBaseUrl());
    } catch (err) {
      const reason = `WebSocket unavailable: ${errorMessage(err)}`;
      this.logger.warn(`Working indicator: ${safeReason(reason)}; using REST fallback`);
      this.switchToPolling(reason);
      return;
    }

    try {
      this.logger.info(`Working indicator: connecting to ${formatWebSocketUrlForLog(wsUrl)}`);
      this.ws?.dispose();
      this.ws = this.connector(wsUrl, token, {
        onOpen: () => this.onWebSocketOpen(),
        onMessage: (message) => this.onWebSocketMessage(message),
        onClose: (reason) => this.onWebSocketUnavailable(reason),
        onError: (err) => this.onWebSocketUnavailable(errorMessage(err)),
      });
    } catch (err) {
      this.onWebSocketUnavailable(errorMessage(err));
    }
  }

  private onWebSocketOpen(): void {
    if (this.stopped) { return; }
    this.reconnectAttempt = 0;
    this.pollSub?.dispose();
    this.pollSub = undefined;
    this.state.clearProject(this.projectId);
    this.source = 'websocket';
    this.connection = 'connected';
    this.detail = 'Live /ws/ui events';
    this.logger.info('Working indicator: connected to /ws/ui; using WebSocket events');
    this.emitCurrent();
  }

  private onWebSocketMessage(message: string): void {
    if (this.stopped) { return; }
    let envelope: unknown;
    try {
      envelope = JSON.parse(message);
    } catch {
      this.logger.warn('Working indicator: received non-JSON /ws/ui message');
      return;
    }
    const applied = this.state.applyEnvelope(envelope, this.projectId, this.now());
    this.logger.debug(`Working indicator: /ws/ui event received ${summarizeWebSocketEnvelope(envelope)} ${applied ? 'applied' : 'ignored'}`);
    if (applied) {
      this.source = 'websocket';
      this.connection = 'connected';
      this.detail = 'Live /ws/ui events';
      this.emitCurrent();
    }
  }

  private onWebSocketUnavailable(reason: string): void {
    if (this.stopped) { return; }
    this.ws?.dispose();
    this.ws = undefined;
    this.logger.warn(`Working indicator: ${safeReason(reason)}; using REST fallback`);
    this.switchToPolling(`WebSocket fallback: ${safeReason(reason)}`);
    this.scheduleReconnect();
  }

  private switchToPolling(detail: string): void {
    if (this.stopped) { return; }
    this.source = 'polling';
    this.connection = 'fallback';
    this.detail = detail;
    if (!this.pollSub) {
      this.logger.info(`Working indicator: using REST fallback (${safeReason(detail)})`);
      this.pollSub = this.coordinator.subscribe(liveIntervalMs(), () => {
        void this.pollFallback();
      }, 'working-indicator');
      void this.pollFallback();
    }
    this.emitCurrent();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) { return; }
    const index = Math.min(this.reconnectAttempt, this.reconnectBackoffMs.length - 1);
    const delay = this.reconnectBackoffMs[index] ?? DEFAULT_RECONNECT_BACKOFF_MS[0];
    this.reconnectAttempt++;
    this.logger.debug(`Working indicator: reconnecting to /ws/ui in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openWebSocket();
    }, delay);
  }

  private async pollFallback(): Promise<void> {
    const nowMs = this.now();
    const activeSessionIds = new Set<string>();

    try {
      const [sessions, issues, features] = await Promise.all([
        this.coordinator.query(`listSessions:${this.projectId}`, () => this.client.listSessions(this.projectId)).catch(() => []),
        this.coordinator.query(`listIssues:${this.projectId}:implementing`, () => this.client.listIssues(this.projectId, { status: 'implementing' })).catch(() => []),
        this.coordinator.query(`listFeatures:${this.projectId}`, () => this.client.listFeatures(this.projectId)).catch(() => []),
      ]);

      for (const session of sessions) {
        this.recordSessionMessage(session, activeSessionIds, nowMs);
      }

      for (const issue of issues) {
        this.recordWorkItemActivity('issue', issue, activeSessionIds, nowMs);
      }

      const activeFeatures = features.filter(f =>
        f.status === 'implementing' || f.status === 'ready_to_implement',
      );
      const todoGroups = await Promise.all(activeFeatures.map(feature =>
        this.coordinator.query(
          `listTodos:${feature.id}:implementing`,
          () => this.client.listTodos(feature.id, { status: 'implementing' }),
        ).catch(() => []),
      ));
      for (const todos of todoGroups) {
        for (const todo of todos) {
          this.recordWorkItemActivity('todo', todo, activeSessionIds, nowMs);
        }
      }

      this.state.markProjectIdleExcept(this.projectId, activeSessionIds, nowMs);
      this.emitCurrent();
    } catch (err) {
      this.logger.warn(`Working indicator: REST fallback poll failed: ${safeReason(errorMessage(err))}`);
      // Keep the last known indicator state during transient fallback failures.
    }
  }

  private recordSessionMessage(
    session: VibeFlowSession,
    activeSessionIds: Set<string>,
    nowMs: number,
  ): void {
    if (!isActiveSession(session) || !session.last_message || !session.last_message_at) {
      return;
    }
    if (this.lastSessionMessageAt.get(session.session_id) === session.last_message_at) {
      return;
    }
    this.lastSessionMessageAt.set(session.session_id, session.last_message_at);
    activeSessionIds.add(session.session_id);
    this.state.recordActivity({
      session_id: session.session_id,
      project_id: this.projectId,
      summary: session.last_message,
      created_at: session.last_message_at,
    }, this.projectId, nowMs);
  }

  private recordWorkItemActivity(
    type: 'todo' | 'issue',
    item: VibeFlowTodo | VibeFlowIssue,
    activeSessionIds: Set<string>,
    nowMs: number,
  ): void {
    const sessionId = item.claimed_by;
    if (!sessionId) { return; }
    activeSessionIds.add(sessionId);

    const progressAt = item.progress?.last_progress_at;
    const currentAction = item.progress?.current_action;
    const summary = currentAction && currentAction.trim().length > 0
      ? currentAction
      : `Implementing ${type} #${item.id}: ${item.title}`;

    const input: WorkingActivityInput = {
      session_id: sessionId,
      project_id: this.projectId,
      summary,
      created_at: progressAt,
      work_item_type: type,
      work_item_id: item.id,
    };

    this.state.recordActivity(input, this.projectId, nowMs);
  }

  private emitCurrent(): void {
    this.emit({
      snapshot: this.state.getSnapshot(this.projectId),
      source: this.source,
      connection: this.connection,
      detail: this.detail,
    });
  }
}

export function connectBearerUIWebSocket(
  url: string,
  bearerToken: string,
  handlers: UIWebSocketHandlers,
): UIWebSocketConnection {
  return new BearerUIWebSocket(url, bearerToken, handlers);
}

class BearerUIWebSocket implements UIWebSocketConnection {
  private request: http.ClientRequest | undefined;
  private socket: Socket | undefined;
  private buffer = Buffer.alloc(0);
  private closed = false;

  constructor(
    url: string,
    bearerToken: string,
    private readonly handlers: UIWebSocketHandlers,
  ) {
    this.connect(url, bearerToken);
  }

  dispose(): void {
    if (this.closed) { return; }
    try {
      this.sendFrame(0x8, Buffer.alloc(0));
    } catch {
      // Socket may already be gone.
    }
    this.closed = true;
    this.request?.destroy();
    this.socket?.destroy();
    this.request = undefined;
    this.socket = undefined;
  }

  private connect(url: string, bearerToken: string): void {
    const wsUrl = new URL(url);
    if (wsUrl.protocol !== 'ws:' && wsUrl.protocol !== 'wss:') {
      throw new Error(`unsupported WebSocket protocol ${wsUrl.protocol}`);
    }

    const requestUrl = new URL(wsUrl.toString());
    const secure = wsUrl.protocol === 'wss:';
    requestUrl.protocol = secure ? 'https:' : 'http:';

    const key = randomBytes(16).toString('base64');
    const expectedAccept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');

    const transport = secure ? https : http;
    this.request = transport.request(requestUrl, {
      headers: {
        'Authorization': `Bearer ${bearerToken}`,
        'Connection': 'Upgrade',
        'Upgrade': 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });

    this.request.on('upgrade', (res, socket, head) => {
      if (this.closed) {
        socket.destroy();
        return;
      }
      const accept = res.headers['sec-websocket-accept'];
      if (accept !== expectedAccept) {
        socket.destroy();
        this.fail(new Error('WebSocket handshake accept header mismatch'));
        return;
      }
      this.socket = socket;
      socket.on('data', chunk => this.onData(chunk));
      socket.on('close', () => this.closeFromRemote('socket closed'));
      socket.on('error', err => this.fail(err));
      if (head.length > 0) {
        this.onData(head);
      }
      this.handlers.onOpen();
    });

    this.request.on('response', res => {
      const status = res.statusCode ?? 0;
      res.resume();
      this.fail(new Error(`HTTP ${status} during WebSocket upgrade`));
    });
    this.request.on('error', err => this.fail(err));
    this.request.end();
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let frame: WebSocketFrame | undefined;
    try {
      frame = readFrame(this.buffer);
      while (frame) {
        this.buffer = this.buffer.subarray(frame.bytesRead);
        this.handleFrame(frame);
        frame = readFrame(this.buffer);
      }
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private handleFrame(frame: WebSocketFrame): void {
    if (frame.opcode === 0x1) {
      this.handlers.onMessage(frame.payload.toString('utf8'));
      return;
    }
    if (frame.opcode === 0x8) {
      this.closeFromRemote('server closed socket');
      return;
    }
    if (frame.opcode === 0x9) {
      this.sendFrame(0xA, frame.payload);
    }
  }

  private sendFrame(opcode: number, payload: Buffer): void {
    if (!this.socket || this.closed) { return; }
    const header = buildClientFrameHeader(opcode, payload);
    this.socket.write(Buffer.concat([header.header, header.maskedPayload]));
  }

  private fail(err: Error): void {
    if (this.closed) { return; }
    this.closed = true;
    this.request?.destroy();
    this.socket?.destroy();
    this.handlers.onError(err);
  }

  private closeFromRemote(reason: string): void {
    if (this.closed) { return; }
    this.closed = true;
    this.request?.destroy();
    this.socket?.destroy();
    this.handlers.onClose(reason);
  }
}

interface WebSocketFrame {
  opcode: number;
  payload: Buffer;
  bytesRead: number;
}

function readFrame(buffer: Buffer): WebSocketFrame | undefined {
  if (buffer.length < 2) { return undefined; }
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let payloadLength = buffer[1] & 0x7f;
  let offset = 2;

  if (payloadLength === 126) {
    if (buffer.length < offset + 2) { return undefined; }
    payloadLength = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLength === 127) {
    if (buffer.length < offset + 8) { return undefined; }
    const bigLength = buffer.readBigUInt64BE(offset);
    if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('WebSocket frame too large');
    }
    payloadLength = Number(bigLength);
    offset += 8;
  }

  let mask: Buffer | undefined;
  if (masked) {
    if (buffer.length < offset + 4) { return undefined; }
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + payloadLength) { return undefined; }

  let payload = buffer.subarray(offset, offset + payloadLength);
  if (mask) {
    const unmasked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) {
      unmasked[i] = payload[i] ^ mask[i % 4];
    }
    payload = unmasked;
  }

  return { opcode, payload, bytesRead: offset + payloadLength };
}

function buildClientFrameHeader(opcode: number, payload: Buffer): { header: Buffer; maskedPayload: Buffer } {
  const mask = randomBytes(4);
  const payloadLength = payload.length;
  let header: Buffer;
  if (payloadLength < 126) {
    header = Buffer.alloc(2 + 4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | payloadLength;
    mask.copy(header, 2);
  } else if (payloadLength <= 0xffff) {
    header = Buffer.alloc(4 + 4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payloadLength, 2);
    mask.copy(header, 4);
  } else {
    header = Buffer.alloc(10 + 4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payloadLength), 2);
    mask.copy(header, 10);
  }

  const maskOffset = header.length - 4;
  const maskedPayload = Buffer.alloc(payloadLength);
  for (let i = 0; i < payloadLength; i++) {
    maskedPayload[i] = payload[i] ^ header[maskOffset + (i % 4)];
  }
  return { header, maskedPayload };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safeReason(reason: string): string {
  return reason.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]').slice(0, 180);
}

function formatWebSocketUrlForLog(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '[invalid websocket url]';
  }
}

function summarizeWebSocketEnvelope(envelope: unknown): string {
  if (!isRecord(envelope)) {
    return 'type=non_object';
  }
  const type = typeof envelope.type === 'string' && envelope.type.trim()
    ? envelope.type.trim()
    : 'unknown';
  const data = isRecord(envelope.data) ? envelope.data : {};
  const parts = [`type=${type}`];
  const projectId = logScalar(data.project_id);
  const sessionId = logScalar(data.session_id);
  const summary = firstString(data.summary, data.current_action, data.message, data.content, data.message_type);
  if (projectId) { parts.push(`project=${projectId}`); }
  if (sessionId) { parts.push(`session=${sessionId}`); }
  if (summary) { parts.push(`summary="${truncateForLog(safeReason(summary), 180)}"`); }
  return parts.join(' ');
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((v): v is string => typeof v === 'string' && v.trim().length > 0)?.trim();
}

function logScalar(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return truncateForLog(safeReason(value.trim()), 80);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function truncateForLog(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
