// Run: node --import tsx --test tests/voice-results-client.test.mts
// Exercise the real call controller, Zustand state and HTTP client, mocking only browser audio,
// WebSocket, fetch and the unrelated app store. No live provider, server or account is needed.
import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import type { VoiceApproval, VoiceConnectionRequest, VoiceTask, VoiceUpdate, VoiceUpdates } from '../web/src/voice/api.js';

const bundle = await build({
  entryPoints: ['web/src/voice/call.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
  define: { 'process.env.NODE_ENV': '"test"' },
  plugins: [{ name: 'browser-boundaries', setup(builder) {
    builder.onResolve({ filter: /^(\.\.\/store|\.\/audio)$/ }, args => ({ path: args.path, namespace: 'voice-test' }));
    builder.onLoad({ filter: /.*/, namespace: 'voice-test' }, args => ({ contents: args.path === '../store'
      ? 'export const useStore = { getState: () => globalThis.__voiceHarness.store };'
      : `export const createAudioContext = () => ({ state: 'running', close: async () => {} });
         export const openMic = async () => ({ getTracks: () => [] });
         export const micErrorMessage = e => e.message;
         export const pcmToBase64 = () => '';
         export const base64ToPcm = () => new Int16Array([1]);
         export class MicCapture { level = 0; async start() {} stop() {} }
         export class PcmPlayer {
           playing = false; onStart = null; onIdle = null; waiters = []; pushes = 0; clears = 0;
           constructor() { globalThis.__voiceHarness.players.push(this); }
           level() { return 0; }
           push() { this.pushes++; this.playing = true; this.onStart?.(); }
           clear() { this.clears++; this.playing = false; this.onIdle?.(); this.waiters.splice(0).forEach(f => f()); }
           whenIdle() { return this.playing ? new Promise(r => this.waiters.push(r)) : Promise.resolve(); }
           dispose() { this.clear(); }
         }`,
    }));
  } }],
});
const tmp = mkdtempSync(path.join(os.tmpdir(), 'voice-results-client-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const modulePath = path.join(tmp, 'call.mjs');
writeFileSync(modulePath, bundle.outputFiles[0].text);
const voice: typeof import('../web/src/voice/call.js') = await import(pathToFileURL(modulePath).href);

const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const task = (id: string, botId = 'research', status: VoiceTask['status'] = 'running'): VoiceTask => ({ id, botId, botName: botId === 'main' ? 'Main agent' : 'Research agent', request: `Request ${id}`, status });
const update = (id: number, kind: VoiceUpdate['kind'] = 'message', botId = 'research', text = `Update ${id}`): VoiceUpdate => ({ id, botId, botName: botId === 'main' ? 'Main agent' : 'Research agent', kind, text });
const connection = (seq = 12, botId = 'research'): VoiceConnectionRequest => ({ botId, seq, toolkit: 'gmail', toolkitName: 'Gmail' });
const approval = (seq = 13, botId = 'research'): VoiceApproval => ({ botId, seq, body: {
  type: 'card', card: 'approval', approvalId: `approval-${botId}-${seq}`, title: 'Send this email?', detail: 'To Sam: agenda for tomorrow',
  tool: 'GMAIL_SEND_EMAIL', toolkit: 'gmail', toolkitName: 'Gmail', args: { recipient: 'sam@example.test' }, status: 'pending',
} });

async function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requests: { path: string; body: any; init: RequestInit }[] = [];
  const beacons: { path: string; body: Blob }[] = [];
  const sockets: FakeSocket[] = [];
  const harness = { store: { user: { name: 'Alex' }, bots: [{ id: 'main', name: 'Main agent' }, { id: 'research', name: 'Research agent' }] }, players: [] as any[] };
  const listeners = new Map();
  // Test cleanup hooks run in registration order: end before restoring browser globals.
  t.after(() => voice.endCall());
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    sent: any[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(readonly url: string, readonly protocols: string[]) { sockets.push(this); }
    send(raw: string) { this.sent.push(JSON.parse(raw)); }
    emit(event: object) { this.onmessage?.({ data: JSON.stringify(event) }); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  for (const [key, value] of Object.entries({
    window: { addEventListener: (name: string, fn: unknown) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name) },
    navigator: { sendBeacon: (path: string, body: Blob) => { beacons.push({ path, body }); return true; } },
    WebSocket: FakeSocket, __voiceHarness: harness,
  })) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => { if (old) Object.defineProperty(globalThis, key, old); else Reflect.deleteProperty(globalThis, key); });
  }
  let poll: (body: any, init: RequestInit) => Promise<Response> = async () => json({ cursor: 0, updates: [], tasks: [] });
  let tool: (body: any) => Promise<Response> = async () => json({ output: 'Read result' });
  t.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push({ path, body, init });
    if (path === '/api/voice/session') return json({ callId: `session-${sockets.length + 1}`, clientSecret: 'ephemeral', clientSecretProtocol: 'xai-client-secret', websocketUrl: 'wss://test/realtime', sampleRate: 24000, session: {} });
    if (path === '/api/voice/updates') return poll(body, init);
    if (path === '/api/voice/tool') return tool(body);
    if (path === '/api/voice/end') return json({ ok: true });
    throw new Error(`Unexpected request ${path}`);
  });
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args));
  async function start() {
    voice.startCall('main');
    await settle();
    const ws = sockets.at(-1)!;
    assert.ok(ws);
    ws.onopen?.();
    ws.emit({ type: 'session.updated' });
    await settle();
    assert.equal(voice.useVoice.getState().status, 'live');
    assert.deepEqual(ws.protocols, ['xai-client-secret.ephemeral']);
    return ws;
  }
  const ws = await start();
  return {
    ws, requests, beacons, harness, warnings, listeners, start,
    setPoll: (fn: typeof poll) => { poll = fn; }, setTool: (fn: typeof tool) => { tool = fn; },
    tick: async (ms = 1500) => { t.mock.timers.tick(ms); await settle(); },
    polls: () => requests.filter(r => r.path.endsWith('/updates')),
    tools: () => requests.filter(r => r.path.endsWith('/tool')),
  };
}
const notes = (ws: { sent: any[] }) => ws.sent.filter(e => e.type === 'conversation.item.create' && e.item.type === 'message').map(e => e.item.content[0].text as string);
function noteData(text: string): { updates: VoiceUpdate[]; tasks: VoiceTask[]; overflow?: { omittedUpdatesByKind: Record<string, number>; omittedTasks: number; message: string } } {
  return JSON.parse(text.split('\n')[1]);
}
const done = (ws: { emit: (e: object) => void }, output: object[] = []) => ws.emit({ type: 'response.done', response: { output } });
const toolEvent = (callId: string, name: string, args: object) => ({ type: 'response.function_call_arguments.done', call_id: callId, name, arguments: JSON.stringify(args) });

test('send_task forwards final spoken context outside model args and duplicate invocations retain their original snapshot', async t => {
  const f = await fixture(t);
  const reply = deferred<Response>();
  f.setTool(() => reply.promise);
  f.ws.emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'partial-user', delta: 'Unfinished request' });
  f.ws.emit({ type: 'response.audio_transcript.delta', item_id: 'partial-agent', delta: 'Unfinished reply' });
  f.ws.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'constraint', transcript: '  Draft the agenda using my work account. Do not send it or contact anyone.  ' });
  f.ws.emit({ type: 'response.audio_transcript.done', item_id: 'acknowledgement', transcript: 'I will prepare a draft for your review.' });
  f.ws.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'empty', transcript: '   ' });
  const args = { bot_id: 'research', request: 'Prepare the agenda' };
  const event = toolEvent('provider-context', 'send_task', args);
  const expected = [
    { id: 'constraint', role: 'user', text: 'Draft the agenda using my work account. Do not send it or contact anyone.' },
    { id: 'acknowledgement', role: 'assistant', text: 'I will prepare a draft for your review.' },
  ];
  f.ws.emit(event);
  assert.equal(f.tools().length, 1);
  assert.equal(f.tools()[0].body.toolCallId, 'provider-context');
  assert.equal(f.tools()[0].body.transcriptRevision, 1);
  assert.deepEqual(f.tools()[0].body.transcript, expected, 'actual spoken constraints accompany the shorter model summary');
  assert.deepEqual(f.tools()[0].body.args, args, 'transcript is transport context, never model tool arguments');
  const originalBody = f.tools()[0].init.body;

  f.ws.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'constraint', transcript: 'Use the work account and save the draft only.' });
  f.ws.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'later', transcript: 'Keep the budget below fifty dollars.' });
  f.ws.emit(event);
  done(f.ws, [{ type: 'function_call', call_id: 'provider-context', name: 'send_task', arguments: event.arguments }]);
  assert.equal(f.tools().length, 1, 'argument and response replays do not create another request');
  assert.equal(f.tools()[0].init.body, originalBody);
  assert.equal(f.tools()[0].body.transcriptRevision, 1, 'duplicate invocation retains the captured revision');
  assert.deepEqual(f.tools()[0].body.transcript, expected, 'later caption finalization cannot mutate an invocation snapshot');
  reply.resolve(json({ output: 'Queued for chat', taskId: 'chat-context-task', taskBotId: 'research' }));
  await settle();
  f.ws.emit(event);
  assert.equal(f.tools().length, 1, 'a replay after resolution still keeps the stable invocation');

  f.setTool(async () => json({ output: 'Agent state' }));
  f.ws.emit(toolEvent('provider-next-context', 'get_agent', { bot_id: 'research' }));
  await settle();
  const latest = [
    { id: 'constraint', role: 'user', text: 'Use the work account and save the draft only.' },
    expected[1],
    { id: 'later', role: 'user', text: 'Keep the budget below fifty dollars.' },
  ];
  assert.deepEqual(f.tools()[1].body.transcript, latest, 'every remote tool receives its own current finalized context');
  assert.equal(f.tools()[1].body.transcriptRevision, 2, 'provider replays do not consume another revision');
  voice.endCall();
  const end = f.requests.find(r => r.path.endsWith('/end'))!.body;
  assert.deepEqual(end.transcript, latest, 'call end persists final context and excludes partial captions');
  assert.equal(end.transcriptRevision, 3);
});

test('tool and end context retain the latest 200 finalized captions and cap each text at 2000 characters', async t => {
  const f = await fixture(t);
  const long = `  Use the work account. ${'Keep this constraint. '.repeat(200)}  `;
  const boundary = 'b'.repeat(2000);
  for (let i = 0; i < 205; i++) f.ws.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: `line-${i}`, transcript: i === 6 ? long : i === 7 ? boundary : `Constraint ${i}` });
  f.ws.emit(toolEvent('bounded-context', 'send_task', { request: 'Follow the spoken constraints' }));
  await settle();
  const transcript = f.tools()[0].body.transcript;
  assert.equal(transcript.length, 200);
  assert.deepEqual(transcript[0], { id: 'line-5', role: 'user', text: 'Constraint 5' });
  assert.equal(transcript[1].text.length, 2000);
  assert.equal(transcript[1].text, `${long.trim().slice(0, 1999)}…`, 'oversized final captions use the server ellipsis convention');
  assert.deepEqual(transcript[2], { id: 'line-7', role: 'user', text: boundary }, 'exactly 2000 characters are retained without an ellipsis');
  assert.deepEqual(transcript.at(-1), { id: 'line-204', role: 'user', text: 'Constraint 204' });
  assert.equal(voice.useVoice.getState().captions.find(c => c.id === 'line-6')!.text, long, 'transport clipping preserves the displayed caption');
  voice.endCall();
  assert.deepEqual(f.requests.find(r => r.path.endsWith('/end'))!.body.transcript, transcript);
});

test('disjoint rolling snapshots carry capture order even when an older tool response arrives last', async t => {
  const f = await fixture(t);
  const olderReply = deferred<Response>();
  f.setTool(body => body.toolCallId === 'older-snapshot' ? olderReply.promise : Promise.resolve(json({ output: 'Newer request accepted' })));
  f.ws.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'old-constraint', transcript: 'Draft only.' });
  const olderEvent = toolEvent('older-snapshot', 'send_task', { request: 'Prepare an initial draft' });
  f.ws.emit(olderEvent);
  const originalBody = f.tools()[0].init.body;
  for (let i = 0; i < 205; i++) f.ws.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: `new-${i}`, transcript: `New constraint ${i}` });
  f.ws.emit(toolEvent('newer-snapshot', 'send_task', { request: 'Revise the draft' }));
  await settle();

  const [older, newer] = f.tools().map(r => r.body);
  assert.deepEqual(older.transcript, [{ id: 'old-constraint', role: 'user', text: 'Draft only.' }]);
  assert.equal(newer.transcript.length, 200);
  assert.equal(newer.transcript[0].id, 'new-5');
  assert.ok(newer.transcript.every((entry: { id: string }) => entry.id !== 'old-constraint'), 'snapshots have no shared IDs for content dedup to compare');
  assert.deepEqual([older.transcriptRevision, newer.transcriptRevision], [1, 2], 'server can order disjoint context by capture revision');
  f.ws.emit(olderEvent);
  assert.equal(f.tools().length, 2);
  assert.equal(f.tools()[0].init.body, originalBody, 'an older invocation replay cannot capture newer context');
  voice.endCall();
  const end = f.requests.find(r => r.path.endsWith('/end'))!.body;
  assert.equal(end.transcriptRevision, 3);
  assert.deepEqual(end.transcript, newer.transcript);
  olderReply.resolve(json({ output: 'Older request accepted after the newer request' }));
  await settle();
  assert.equal(f.tools()[0].init.body, originalBody, 'response arrival order cannot mutate capture order');
});

test('identical captions keep distinct IDs and beacon/end revisions increase within a call then reset for a new call', async t => {
  const f = await fixture(t);
  for (const id of ['repeat-1', 'repeat-2', 'repeat-1']) f.ws.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: 'Yes, draft only.' });
  f.ws.emit({ type: 'response.audio_transcript.delta', item_id: 'partial', delta: 'Still speaking' });
  f.ws.emit(toolEvent('repeat-task', 'send_task', { request: 'Prepare a draft' }));
  await settle();
  const expected = ['repeat-1', 'repeat-2'].map(id => ({ id, role: 'user', text: 'Yes, draft only.' }));
  assert.deepEqual(f.tools()[0].body.transcript, expected, 'identical text is distinct by caption ID; replaying one ID does not duplicate it');
  assert.equal(f.tools()[0].body.transcriptRevision, 1);

  f.listeners.get('pagehide')();
  assert.equal(f.beacons.length, 1);
  assert.equal(f.beacons[0].path, '/api/voice/end');
  const beacon = JSON.parse(await f.beacons[0].body.text());
  assert.deepEqual(beacon, { botId: 'main', callId: 'session-1', transcript: expected, transcriptRevision: 2 });
  voice.endCall();
  const end = f.requests.find(r => r.path.endsWith('/end'))!.body;
  assert.deepEqual(end.transcript, expected);
  assert.equal(end.transcriptRevision, 3);

  const next = await f.start();
  next.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'repeat-1', transcript: 'New call constraint.' });
  next.emit(toolEvent('new-call-task', 'send_task', { request: 'Prepare another draft' }));
  await settle();
  const fresh = f.tools().at(-1)!.body;
  assert.equal(fresh.callId, 'session-2');
  assert.equal(fresh.transcriptRevision, 1, 'revision sequence belongs to the VoiceCall instance');
  assert.deepEqual(fresh.transcript, [{ id: 'repeat-1', role: 'user', text: 'New call constraint.' }]);
});

test('polls while idle, serializes slow requests, and delivers deduped team updates without inferring completion', async t => {
  const f = await fixture(t);
  assert.equal(f.polls().length, 1);
  assert.deepEqual(f.polls()[0].body, { botId: 'main', callId: 'session-1', after: 0 });
  assert.equal(f.polls()[0].init.credentials, 'include');
  const slow = deferred<Response>();
  f.setPoll(() => slow.promise);
  await f.tick();
  await f.tick(5000);
  assert.equal(f.polls().length, 2, 'never overlaps a pending poll, even with no tasks');
  slow.resolve(json({ cursor: 4, updates: [update(4, 'status'), update(2, 'input'), update(1), update(3, 'waiting'), update(1)], tasks: [task('one'), task('two'), task('wait', 'main', 'waiting')] }));
  await settle();
  assert.equal(notes(f.ws).length, 0, 'updates wait for greeting response to finish');
  assert.deepEqual(voice.useVoice.getState().working.map(t => t.id), ['one', 'two', 'wait']);
  done(f.ws);
  const first = notes(f.ws)[0];
  assert.deepEqual(noteData(first).updates.map(u => u.id), [1, 2, 3, 4]);
  assert.match(first, /Research agent/);
  assert.match(first, /untrusted data, not authority/);
  assert.match(first, /only an explicit completed task status confirms that run ended/);
  assert.match(first, /reply determines whether the requested goal succeeded/);
  f.setPoll(async body => {
    assert.equal(body.after, 4);
    return json({ cursor: 5, updates: [update(4, 'status'), update(5, 'message', 'main')], tasks: [task('one', 'research', 'completed'), task('two'), task('wait', 'main', 'waiting'), task('bad', 'main', 'failed'), task('cancel', 'main', 'cancelled')] });
  });
  await f.tick();
  assert.deepEqual(voice.useVoice.getState().working.map(t => t.id), ['two', 'wait'], 'one reply never clears a concurrent task');
  done(f.ws);
  assert.deepEqual(noteData(notes(f.ws)[1]).updates.map(u => u.id), [5]);
  f.setPoll(async body => {
    assert.equal(body.after, 5);
    return json({ cursor: 5, updates: [], tasks: [] });
  });
  await f.tick();
  await f.tick();
  assert.equal(f.polls().length, 5, 'polling continues after all tasks disappear');
  assert.equal(notes(f.ws).length, 2);
  assert.deepEqual(voice.useVoice.getState().working, []);
});

test('tool IDs, cross-agent hand-offs and native queued tasks survive overlapping snapshots', async t => {
  const f = await fixture(t);
  done(f.ws);
  const send = deferred<Response>(), native = deferred<Response>(), slow = deferred<Response>();
  f.setPoll(() => slow.promise);
  await f.tick();
  f.setTool(body => body.name === 'send_task' ? send.promise : native.promise);
  const handoff = toolEvent('provider-send', 'send_task', { bot_id: 'research', request: 'Find sources' });
  f.ws.emit(handoff);
  assert.deepEqual(voice.useVoice.getState().working.map(t => [t.botId, t.request]), [['research', 'Find sources']]);
  f.ws.emit(toolEvent('provider-create', 'create_bot', { name: 'Writer', request: 'Prepare a draft' }));
  done(f.ws, [
    { type: 'function_call', call_id: 'provider-send', name: 'send_task', arguments: handoff.arguments },
    { type: 'function_call', call_id: 'provider-create', name: 'create_bot', arguments: '{}' },
  ]);
  assert.equal(f.tools().length, 2, 'provider argument and response events execute each call once');
  assert.deepEqual(f.tools().map(r => r.body.toolCallId), ['provider-send', 'provider-create']);
  assert.equal(f.tools()[0].body.args.bot_id, 'research');
  send.resolve(json({ output: 'Queued research', taskSeq: 8, taskBotId: 'research', taskId: 'durable-send' }));
  native.resolve(json({ output: 'Created and queued', taskSeq: 8, taskBotId: 'writer', taskId: 'durable-native' }));
  await settle();
  assert.deepEqual(voice.useVoice.getState().working.map(t => t.botId), ['research', 'writer']);
  slow.resolve(json({ cursor: 0, updates: [], tasks: [] }));
  await settle();
  assert.equal(voice.useVoice.getState().working.length, 2, 'snapshot requested before tool replies cannot erase optimistic work');
  const outputs = f.ws.sent.filter(e => e.item?.type === 'function_call_output');
  assert.deepEqual(outputs.map(e => [e.item.call_id, e.item.output]), [['provider-send', 'Queued research'], ['provider-create', 'Created and queued']]);
  const outputIndex = f.ws.sent.findIndex(e => e === outputs[1]);
  assert.equal(f.ws.sent[outputIndex + 1].type, 'response.create', 'all parallel outputs precede a single follow-up');
  f.setPoll(async () => json({ cursor: 0, updates: [], tasks: [task('durable-send'), task('durable-native', 'writer', 'queued')] }));
  await f.tick();
  assert.deepEqual(voice.useVoice.getState().working.map(t => t.id), ['durable-send', 'durable-native'], 'durable IDs replace optimistic placeholders without seq collisions');
  f.setPoll(async () => json({ cursor: 0, updates: [], tasks: [task('durable-send', 'research', 'completed'), task('durable-native', 'writer', 'failed')] }));
  await f.tick();
  assert.deepEqual(voice.useVoice.getState().working, []);
});

test('HTTP, network and timeout failures retry with the same cursor and preserve task state', async t => {
  const f = await fixture(t);
  f.setPoll(async () => json({ cursor: 7, updates: [update(7, 'status')], tasks: [task('still-running')] }));
  await f.tick();
  f.setPoll(async () => json({ error: 'Temporarily unavailable' }, 503));
  await f.tick();
  assert.equal(voice.useVoice.getState().working[0].id, 'still-running');
  f.setPoll(async () => { throw new TypeError('Network unavailable'); });
  await f.tick();
  f.setPoll((_body, init) => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })));
  await f.tick();
  await f.tick(10000);
  assert.equal(voice.useVoice.getState().working[0].id, 'still-running');
  assert.equal(f.warnings.length, 3);
  f.setPoll(async () => json({ cursor: 8, updates: [update(8, 'status', 'research', 'Run ended without a reply; goal success is unknown.')], tasks: [task('still-running', 'research', 'completed')] }));
  await f.tick();
  assert.deepEqual(f.polls().slice(2).map(r => r.body.after), [7, 7, 7, 7]);
  assert.deepEqual(voice.useVoice.getState().working, []);
  done(f.ws);
  assert.equal(noteData(notes(f.ws)[0]).updates.at(-1)?.text, 'Run ended without a reply; goal success is unknown.');
});

test('notes wait for pending tools, speech and playback; interrupted audio stays dropped', async t => {
  const f = await fixture(t);
  const toolReply = deferred<Response>();
  f.setTool(() => toolReply.promise);
  f.ws.emit(toolEvent('read', 'get_agent', { bot_id: 'research' }));
  done(f.ws);
  f.setPoll(async () => json({ cursor: 1, updates: [update(1)], tasks: [task('pending')] }));
  await f.tick();
  assert.equal(notes(f.ws).length, 0, 'no note or response is injected before pending function outputs');
  toolReply.resolve(json({ output: 'Agent state' }));
  await settle();
  assert.equal(notes(f.ws).length, 0, 'read tool follow-up gets its turn before queued notes');
  f.ws.emit({ type: 'response.created', response: { id: 'spoken' } });
  f.ws.emit({ type: 'response.audio.delta', response_id: 'spoken', delta: 'fake-pcm' });
  const player = f.harness.players[0];
  assert.equal(player.pushes, 1);
  f.ws.emit({ type: 'input_audio_buffer.speech_started' });
  assert.equal(player.playing, false);
  assert.ok(f.ws.sent.some(e => e.type === 'response.cancel'));
  f.ws.emit({ type: 'response.audio.delta', response_id: 'spoken', delta: 'late-pcm' });
  assert.equal(player.pushes, 1, 'late audio from interrupted response is ignored');
  done(f.ws);
  assert.equal(notes(f.ws).length, 0, 'user speech holds the note');
  f.ws.emit({ type: 'input_audio_buffer.speech_stopped' });
  assert.equal(notes(f.ws).length, 1);
  f.ws.emit({ type: 'response.created', response: { id: 'next' } });
  f.ws.emit({ type: 'response.audio.delta', response_id: 'next', delta: 'pcm' });
  f.setPoll(async () => json({ cursor: 2, updates: [update(2, 'waiting')], tasks: [task('pending', 'research', 'waiting')] }));
  await f.tick();
  done(f.ws);
  assert.equal(notes(f.ws).length, 1, 'response.done can precede playback finishing');
  player.clear();
  await settle();
  assert.equal(notes(f.ws).length, 2);
  assert.equal(noteData(notes(f.ws)[1]).tasks[0].status, 'waiting');
});

test('end aborts polling, drops queued notes and ignores late tool/update responses across calls', async t => {
  const f = await fixture(t);
  const slow = deferred<Response>(), toolReply = deferred<Response>();
  f.setPoll(() => slow.promise);
  f.setTool(() => toolReply.promise);
  await f.tick();
  f.ws.emit(toolEvent('late-tool', 'send_task', { request: 'Old call request' }));
  done(f.ws);
  const signal = f.polls().at(-1)!.init.signal!;
  voice.endCall();
  assert.equal(signal.aborted, true);
  assert.equal(f.listeners.has('pagehide'), false);
  assert.deepEqual(voice.useVoice.getState().working, []);
  const oldSent = f.ws.sent.length;
  f.setPoll(async () => json({ cursor: 0, updates: [], tasks: [] }));
  const next = await f.start();
  slow.resolve(json({ cursor: 10, updates: [update(10)], tasks: [task('old-call')], connectionRequests: [connection()], approvals: [approval()] }));
  toolReply.resolve(json({ output: 'Late task', taskId: 'old-task', taskBotId: 'research' }));
  await settle();
  assert.deepEqual(voice.useVoice.getState().working, []);
  assert.deepEqual(voice.useVoice.getState().connectionRequests, []);
  assert.deepEqual(voice.useVoice.getState().approvals, []);
  assert.equal(f.ws.sent.length, oldSent);
  assert.equal(notes(next).length, 0);
  voice.endCall();
  const count = f.polls().length;
  await f.tick(30000);
  assert.equal(f.polls().length, count, 'no timer is recreated by a late response');
});

test('delegated chat work delivers connection cards through polling without direct voice app schemas', async t => {
  const f = await fixture(t);
  const slow = deferred<Response>();
  f.setPoll(() => slow.promise);
  await f.tick();
  f.setTool(async () => json({ output: 'Queued for chat', taskId: 'chat-connect', taskBotId: 'research' }));
  f.ws.emit(toolEvent('connect-gmail', 'send_task', { bot_id: 'research', request: 'Connect my Gmail account so you can prepare a draft' }));
  done(f.ws);
  await settle();
  assert.deepEqual(voice.useVoice.getState().connectionRequests, [], 'delegation does not invent a connection card');
  assert.equal(f.tools()[0].body.toolCallId, 'connect-gmail');
  assert.equal(f.tools()[0].body.name, 'send_task');
  assert.equal(f.requests.some(r => r.path.includes('/apps/')), false, 'voice does not execute app tools or start OAuth');
  slow.resolve(json({ cursor: 0, updates: [], tasks: [], connectionRequests: [], approvals: [] }));
  await settle();
  assert.deepEqual(voice.useVoice.getState().connectionRequests, []);
  f.setPoll(async () => json({ cursor: 1, updates: [update(1, 'waiting', 'research', 'Connect Gmail using the card.')], tasks: [task('chat-connect', 'research', 'waiting')], connectionRequests: [connection()] }));
  await f.tick();
  assert.deepEqual(voice.useVoice.getState().connectionRequests, [connection()], 'chat-owned cards reach voice through the authoritative feed');
  f.setPoll(async () => json({ cursor: 1, updates: [], tasks: [task('chat-connect')], connectionRequests: [] }));
  await f.tick();
  assert.deepEqual(voice.useVoice.getState().connectionRequests, [], 'the next authoritative empty list removes the button');
  assert.equal(voice.useVoice.getState().working[0].id, 'chat-connect', 'authorizing an account does not complete delegated work');
});

test('connection and approval snapshots are authoritative independently of updates, tolerate absent fields, and clear on hang-up', async t => {
  const f = await fixture(t);
  f.setPoll(async () => json({ cursor: 0, updates: [], tasks: [], connectionRequests: [connection(), connection(12, 'main')], approvals: [approval(), { ...approval(14), body: { ...approval(14).body, status: 'allowed' } }] }));
  await f.tick();
  assert.equal(voice.useVoice.getState().connectionRequests.length, 2, 'equal row sequences in different agent chats remain distinct');
  assert.deepEqual(voice.useVoice.getState().approvals, [approval()], 'resolved approval bodies are not actionable');
  f.setPoll(async () => json({ cursor: 0, updates: [], tasks: [] }));
  await f.tick();
  assert.equal(voice.useVoice.getState().connectionRequests.length, 2, 'absent fields are compatible and do not imply resolution');
  assert.equal(voice.useVoice.getState().approvals.length, 1);
  f.setPoll(async () => json({ error: 'Unavailable' }, 503));
  await f.tick();
  assert.equal(voice.useVoice.getState().approvals.length, 1, 'transient errors do not resolve approvals');
  f.setPoll(async () => json({ cursor: 0, updates: [], tasks: [], connectionRequests: [], approvals: [] }));
  await f.tick();
  assert.deepEqual(voice.useVoice.getState().connectionRequests, []);
  assert.deepEqual(voice.useVoice.getState().approvals, []);
  f.setPoll(async () => json({ cursor: 0, updates: [], tasks: [], connectionRequests: [connection()], approvals: [approval()] }));
  await f.tick();
  voice.endCall();
  assert.deepEqual(voice.useVoice.getState().connectionRequests, []);
  assert.deepEqual(voice.useVoice.getState().approvals, []);
  f.setPoll(async () => json({ cursor: 0, updates: [], tasks: [] }));
  await f.start();
  assert.deepEqual(voice.useVoice.getState().connectionRequests, []);
  assert.deepEqual(voice.useVoice.getState().approvals, []);
});

test('delegated app task IDs coexist with chat-owned approvals and clear only by task snapshot', async t => {
  const f = await fixture(t);
  f.setTool(async () => json({ output: 'Queued for the chat agent', taskId: 'approval-operation', taskBotId: 'research' }));
  f.ws.emit(toolEvent('delegate-app', 'send_task', { bot_id: 'research', request: 'Prepare the agenda email and ask me before sending' }));
  done(f.ws);
  await settle();
  assert.equal(voice.useVoice.getState().working.length, 1);
  assert.deepEqual(f.tools().map(r => r.body.name), ['send_task'], 'only the chat agent owns external execution');
  f.setPoll(async () => json({ cursor: 1, updates: [update(1, 'waiting')], tasks: [task('approval-operation', 'research', 'waiting')], approvals: [approval()] }));
  await f.tick();
  assert.equal(voice.useVoice.getState().working[0].id, 'approval-operation');
  assert.equal(voice.useVoice.getState().approvals[0].body.approvalId, approval().body.approvalId);
  f.setPoll(async () => json({ cursor: 1, updates: [], tasks: [task('approval-operation', 'research', 'running')], approvals: [] }));
  await f.tick();
  assert.deepEqual(voice.useVoice.getState().approvals, []);
  assert.equal(voice.useVoice.getState().working[0].id, 'approval-operation', 'approval disappearance does not imply operation completion');
  f.setPoll(async () => json({ cursor: 2, updates: [update(2, 'status')], tasks: [task('approval-operation', 'research', 'completed')], approvals: [] }));
  await f.tick();
  assert.deepEqual(voice.useVoice.getState().working, []);
});

test('busy-team backlog and task context stay bounded with explicit missed-status and recall markers', async t => {
  const f = await fixture(t);
  let cursor = 0;
  const tasks = Array.from({ length: 200 }, (_, i) => ({ ...task(`job-${i}`), request: 'r'.repeat(400) }));
  f.setPoll(async () => {
    const updates = Array.from({ length: 20 }, () => update(++cursor, cursor % 2 ? 'status' : 'message', 'research', 'x'.repeat(4000)));
    return json({ cursor, updates, tasks } satisfies VoiceUpdates);
  });
  for (let i = 0; i < 40; i++) await f.tick();
  assert.equal(notes(f.ws).length, 0, 'greeting or long speech can hold many pages of team updates');
  assert.equal(f.polls().at(-1)!.body.after, 780, 'server cursor replays each page on the next poll');
  assert.equal(voice.useVoice.getState().working.length, 200, 'prompt context cap does not truncate authoritative working state');
  done(f.ws);
  const text = notes(f.ws)[0], data = noteData(text);
  assert.ok(text.length < 80000, `bounded injection was ${text.length} characters`);
  assert.ok(data.updates.length < 20, 'old pending updates are evicted when the character cap is reached');
  assert.equal(data.updates.at(-1)?.id, 800);
  assert.ok(data.overflow!.omittedUpdatesByKind.status > 0, 'lost statuses are explicitly counted');
  assert.ok(data.overflow!.omittedTasks > 0);
  assert.match(data.overflow!.message, /get_agent or recall_text_messages/);
  assert.match(data.overflow!.message, /Do not assume omitted tasks completed or succeeded/);
});

test('failed hand-offs clear only their optimism and preserve tool error and hang-up flow', async t => {
  const f = await fixture(t);
  f.setPoll(async () => json({ cursor: 0, updates: [], tasks: [task('independent')] }));
  await f.tick();
  f.setTool(async () => json({ error: 'Rejected' }, 409));
  f.ws.emit(toolEvent('failed-send', 'send_task', { request: 'Rejected work' }));
  assert.equal(voice.useVoice.getState().working.length, 2);
  done(f.ws);
  await settle();
  assert.deepEqual(voice.useVoice.getState().working.map(t => t.id), ['independent']);
  assert.match(f.ws.sent.find(e => e.item?.type === 'function_call_output').item.output, /Tool error: Rejected/);
  voice.toggleMute();
  assert.equal(voice.useVoice.getState().muted, true);
  assert.ok(f.ws.sent.some(e => e.type === 'input_audio_buffer.clear'));
  f.ws.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'user-caption', transcript: 'Goodbye' });
  f.ws.emit(toolEvent('hang-up', 'end_the_call', {}));
  done(f.ws);
  await settle();
  assert.equal(voice.useVoice.getState().status, 'idle');
  const end = f.requests.find(r => r.path.endsWith('/end'))!;
  assert.deepEqual(end.body.transcript, [{ id: 'user-caption', role: 'user', text: 'Goodbye' }]);
  assert.equal(f.tools().length, 1, 'hang-up stays local');
});
