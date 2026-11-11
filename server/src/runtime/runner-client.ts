import { WebSocket } from 'ws';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '../mcp/store.js';
import { assertTenant, isTenant } from '../deployment.js';
const socketPath = () => {
  const value = process.env.SWARM_RUNNER_SOCKET;
  if (!isTenant || !value?.startsWith('/run/swarm/')) throw new Error('Isolated tenant runner is unavailable. Local execution is disabled.');
  return value;
};
/** Only a tenant-local Unix socket is reachable; clients never control Docker arguments. */
export class SandboxMcpTransport implements Transport {
  onclose?: () => void;
  onerror?: (e: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private ws?: WebSocket;
  private closed = false;
  constructor(private server: McpServer) { assertTenant(server.userId); }
  async start() {
    if (this.closed) throw new Error('MCP authorization was revoked.');
    const ws = this.ws = new WebSocket('ws://localhost/mcp', { socketPath: socketPath(), maxPayload: 8 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { ws.terminate(); reject(new Error('Isolated MCP runner timed out.')); }, 12_000);
      ws.once('error', e => { clearTimeout(timer); reject(e); });
      ws.once('close', () => { clearTimeout(timer); reject(new Error('MCP runner closed.')); });
      ws.once('open', () => ws.send(JSON.stringify({ tenantId: this.server.userId, id: this.server.id, revision: this.server.revision, config: this.server.config })));
      ws.once('message', raw => {
        clearTimeout(timer);
        try { if (JSON.parse(raw.toString()).type !== 'ready') throw new Error('Isolated runner refused MCP startup.'); resolve(); }
        catch (e) { ws.close(); reject(e); }
      });
    });
    ws.on('message', raw => { try { this.onmessage?.(JSON.parse(raw.toString())); } catch { this.onerror?.(new Error('Invalid MCP message.')); void this.close(); } });
    ws.on('close', () => this.onclose?.());
    ws.on('error', e => this.onerror?.(e));
  }
  async send(message: JSONRPCMessage) {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error('Isolated MCP runner is offline.');
    await new Promise<void>((resolve, reject) => this.ws!.send(JSON.stringify(message), e => e ? reject(e) : resolve()));
  }
  async close() { this.closed = true; this.ws?.terminate(); }
}
