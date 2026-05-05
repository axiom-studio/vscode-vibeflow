import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AuthService } from '../auth/AuthService.js';
import * as vscode from 'vscode';

/**
 * Persistent MCP client connection to the VibeFlow MCP server.
 * Uses the @modelcontextprotocol/sdk StreamableHTTP transport.
 *
 * Lifecycle: connect on auth, disconnect on logout, reconnect on token refresh.
 * All 72 VibeFlow tools are available via callTool().
 */
export class VibeFlowMcpClient {
  private client: Client | undefined;
  private connected = false;
  /**
   * In-flight connect promise. Concurrent callers (e.g. two parallel
   * callTool() calls before the first connect resolves) all await the
   * same promise, so we never spawn two transports racing to connect.
   * Cleared after success or failure so a later call can retry.
   */
  private connectPromise: Promise<void> | undefined;

  constructor(private readonly auth: AuthService) {}

  /**
   * Connect to the MCP server. Call after authentication.
   * Idempotent + concurrency-safe: if a connect is already in flight,
   * subsequent callers wait for its result rather than starting a second.
   */
  async connect(): Promise<void> {
    if (this.connected) { return; }
    if (this.connectPromise) { return this.connectPromise; }

    this.connectPromise = (async () => {
      const token = this.auth.getToken();
      if (!token) {
        throw new Error('Not authenticated');
      }

      const serverUrl = vscode.workspace.getConfiguration('vibeflow')
        .get<string>('serverUrl', 'https://cloud.axiomstudio.ai');

      const transport = new StreamableHTTPClientTransport(
        new URL(`${serverUrl}/rest/v1/vibeflow/mcp`),
        {
          requestInit: {
            headers: {
              'Authorization': `Bearer ${token}`,
            },
          },
        },
      );

      const client = new Client({
        name: 'vscode-vibeflow',
        version: '0.1.0',
      });

      await client.connect(transport);
      this.client = client;
      this.connected = true;
      console.log('[VibeFlow] MCP client connected');
    })();

    try {
      await this.connectPromise;
    } finally {
      // Clear regardless of outcome — on success the `connected` flag
      // makes future calls fast-path; on failure we want to allow retry.
      this.connectPromise = undefined;
    }
  }

  /**
   * Disconnect from the MCP server.
   */
  async disconnect(): Promise<void> {
    if (this.client && this.connected) {
      try {
        await this.client.close();
      } catch {
        // Ignore close errors
      }
      this.connected = false;
      this.client = undefined;
      console.log('[VibeFlow] MCP client disconnected');
    }
  }

  /**
   * Call an MCP tool by name with arguments.
   * Auto-connects if not already connected.
   * Returns the tool result content as parsed JSON or string.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.connected || !this.client) {
      await this.connect();
    }

    if (!this.client) {
      throw new Error('MCP client not connected');
    }

    const result = await this.client.callTool({
      name,
      arguments: args,
    });

    // Extract content from MCP result
    if (result.content && Array.isArray(result.content) && result.content.length > 0) {
      const first = result.content[0];
      if (first.type === 'text' && typeof first.text === 'string') {
        try {
          return JSON.parse(first.text);
        } catch {
          return first.text;
        }
      }
      return first;
    }

    return result;
  }

  get isConnected(): boolean {
    return this.connected;
  }
}
