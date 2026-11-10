// Isolated MCP server used for HTTP, SSE and local-process integration tests.
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
function server() {
  const s = new Server({ name: 'fixture', version: '1' }, { capabilities: { tools: {} } });
  s.setRequestHandler(ListToolsRequestSchema, async req => req.params?.cursor ? { tools: [{ name: 'fail', description: 'Returns a tool error.', inputSchema: { type: 'object', properties: {} } }] } : { tools: [{ name: 'echo', description: 'Echoes the supplied message.', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } }], nextCursor: 'page2' });
  s.setRequestHandler(CallToolRequestSchema, async req => req.params.name === 'fail' ? { isError: true, content: [{ type: 'text', text: 'Fixture failure secret-fixture-token' }] } : { content: [{ type: 'text', text: `MCP says: ${req.params.arguments?.message}; env=${process.env.MCP_FIXTURE_VALUE ?? 'none'}; inherited=${!!process.env.XAI_API_KEY}` }] });
  return s;
}
if (process.argv[2] === 'stdio') await server().connect(new StdioServerTransport());
else {
  const sessions = new Map();
  const web = http.createServer(async (req,res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') { res.end('ok'); return; }
    if (req.headers.authorization !== 'Bearer secret-fixture-token' || req.headers['x-fixture'] !== 'header-secret') { res.writeHead(401); res.end('Need fixture credentials'); return; }
    if (url.pathname === '/sse') {
      const transport = new SSEServerTransport('/messages',res); sessions.set(transport.sessionId,transport); await server().connect(transport); return;
    }
    if (url.pathname === '/messages') { const t = sessions.get(url.searchParams.get('sessionId')); if(t) await t.handlePostMessage(req,res); else { res.writeHead(404); res.end(); } return; }
    if (url.pathname === '/mcp') {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const s=server(); await s.connect(transport); res.on('close', () => void s.close()); await transport.handleRequest(req,res); return;
    }
    res.writeHead(404);res.end('missing');
  });
  web.listen(Number(process.argv[2]),'127.0.0.1');
}
