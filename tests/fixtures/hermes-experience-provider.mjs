// Deterministic model fixture. All application tools still execute in the real
// native server. Only model responses are mocked; this process never sends files.
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';
const probe = net.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const fallbackPort = probe.address().port; await new Promise(r => probe.close(r));
const fallback = spawn(process.execPath, ['tests/mock-provider.mjs', String(fallbackPort)], { env: process.env, stdio: 'inherit' });
let seq = 0;
const fixture = JSON.parse(fs.readFileSync(process.env.HERMES_FIXTURE_FILE, 'utf8'));
const server = http.createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk); const raw = Buffer.concat(chunks);
    let body; try { body = JSON.parse(raw.toString()); } catch { body = {}; }
    const items = Array.isArray(body.input) ? body.input : [];
    const lastUserIndex = items.findLastIndex(i => i.role === 'user');
    const content = items[lastUserIndex]?.content;
    const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
    if (request.url?.startsWith('/v1/responses') && text.includes('Execute native workflow') && text.includes('OUTPUT CONTRACT')) {
      const outputs = items.slice(lastUserIndex + 1).filter(i => i.type === 'function_call_output');
      const writing = text.includes('Write report');
      let item;
      if (!writing && outputs.length === 0) item = { type: 'function_call', call_id: `workflow_${++seq}`, name: 'session_search', arguments: JSON.stringify({ anchor: fixture.researchDaily, window: 0 }) };
      else if (outputs.length === (writing ? 0 : 1)) item = { type: 'function_call', call_id: `workflow_${++seq}`, name: 'save_file', arguments: JSON.stringify({ filename: writing ? 'workflow-report.md' : 'workflow-research.md', content: `# Sourced workflow artifact\n\nOwner: ${writing ? 'Ellis' : 'Nia'}. Report cadence: daily.\nSource: /api/bots/${fixture.nia.id}/messages/${fixture.researchDaily.generation}/${fixture.researchDaily.seq}\n` }) };
      else item = { type: 'message', id: `workflow_message_${++seq}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ summary: `Saved a daily report with named owner ${writing ? 'Ellis' : 'Nia'} and original source /api/bots/${fixture.nia.id}/messages/${fixture.researchDaily.generation}/${fixture.researchDaily.seq}.` }), annotations: [] }] };
      const result = { id: `workflow_response_${++seq}`, object: 'response', status: 'completed', model: body.model, output: [item], usage: { input_tokens: 100, output_tokens: 30, total_tokens: 130 } };
      if (body.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        event('response.created', { response: { ...result, status: 'in_progress', output: [] } });
        event('response.output_item.added', { output_index: 0, item });
        if (item.type === 'message') event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text });
        event('response.output_item.done', { output_index: 0, item }); event('response.completed', { response: result }); response.end();
      } else { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result)); }
      return;
    }
    if (request.url?.startsWith('/v1/responses') && text.includes('Native source anchors')) {
      const research = text.includes(fixture.researchSkill.id), skill = research ? fixture.researchSkill : fixture.skill;
      const outputs = items.slice(lastUserIndex + 1).filter(i => i.type === 'function_call_output');
      let item;
      const call = (name, args) => ({ type: 'function_call', call_id: `review_${++seq}`, name, arguments: JSON.stringify(args) });
      if (outputs.length === 0) item = call('read_skill', { skill_id: skill.id });
      else if (outputs.length === 1) {
        const read = JSON.parse(outputs[0].output).skill;
        item = call('manage_skill', { action: 'update', skill_id: skill.id, expected_revision: read.revision, body: `${read.body.replace(/weekly/g, 'daily')}\nVerify original source links before reporting.`, reason: 'Encode the user’s durable correction in the existing procedure.', evidence: [research ? fixture.researchDaily : fixture.daily] });
      } else if (research && outputs.length === 2) item = call('manage_memory', { action: 'replace', memory_id: fixture.researchMemory.id, expected_revision: fixture.researchMemory.revision, text: 'Prefers daily research reports with named owners and source links.', target: 'user', evidence: [fixture.researchDaily] });
      else item = { type: 'message', id: `review_message_${++seq}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Reviewed source evidence and current skill; recorded the guarded knowledge changes.', annotations: [] }] };
      const result = { id: `review_response_${++seq}`, object: 'response', status: 'completed', model: body.model, output: [item], usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150 } };
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result)); return;
    }
    const upstream = await fetch(`http://127.0.0.1:${fallbackPort}${request.url}`, { method: request.method, headers: { 'content-type': request.headers['content-type'] ?? 'application/json', authorization: request.headers.authorization ?? '' }, ...(raw.length ? { body: raw } : {}) });
    response.writeHead(upstream.status, Object.fromEntries(upstream.headers)); response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) { response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: String(error) } })); }
});
server.listen(Number(process.argv[2]), '127.0.0.1');
const close = () => { fallback.kill(); server.close(); }; process.on('SIGTERM', close); process.on('SIGINT', close);
