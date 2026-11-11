// Local provider/SQLite regressions for inbound transcription routing. No live credentials.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-speech-routing-'));
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static') as string;
const cafPath = path.join(root, 'voice.caf');
const source = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3', '-c:a', 'libopus'];
execFileSync(ffmpeg, [...source, '-f', 'caf', cafPath]);
const caf = { data: fs.readFileSync(cafPath), mime: 'audio/x-caf' };
const ogg = { data: execFileSync(ffmpeg, [...source, '-f', 'ogg', 'pipe:1']), mime: 'audio/ogg; codecs=opus' };
type Upload = { path: string; key: string; mime: string; filename: string; data: Buffer; model?: string; fields: string[] };
const uploads: Upload[] = [];
const failures = new Map<string, number>();
let rejectOgg: number | null = null;
const upstream = createServer(async (req, res) => {
  const json = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    let upload: Upload;
    if (req.url === '/openrouter/audio/transcriptions') {
      const value = JSON.parse(body.toString());
      upload = { path: req.url, key: req.headers.authorization!, mime: value.input_audio.format, filename: '', data: Buffer.from(value.input_audio.data, 'base64'), model: value.model, fields: Object.keys(value) };
    } else if (req.url === '/xai/stt' || req.url === '/direct/stt') {
      const form = await new Response(body, { headers: { 'content-type': String(req.headers['content-type']) } }).formData();
      const file = form.get('file');
      assert.ok(file instanceof File);
      upload = { path: req.url, key: req.headers.authorization!, mime: file.type, filename: file.name, data: Buffer.from(await file.arrayBuffer()), model: form.get('model')?.toString(), fields: [...form.keys()] };
      assert.equal(upload.fields.at(-1), 'file', 'provider requires the file last');
    } else return json(404, { error: 'unexpected endpoint' });
    uploads.push(upload);
    if (failures.has(upload.path)) return json(failures.get(upload.path)!, { error: 'sensitive upstream body must never appear in logs' });
    if (rejectOgg && upload.path === '/xai/stt' && upload.data.subarray(0, 4).toString() === 'OggS') return json(rejectOgg, { error: 'codec rejected' });
    if (upload.data.subarray(0, 4).toString() === 'caff') return json(415, { error: 'CAF unsupported' });
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 'null', '-'], { input: upload.data, timeout: 5000 });
    return json(200, { text: `heard ${upload.path}` });
  } catch { return json(400, { error: 'invalid upload' }); }
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const address = upstream.address();
assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
Object.assign(process.env, {
  DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'speech-routing-test-only',
  APP_URL: base, SERVER_URL: base, COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', INKBOX_TUNNEL: '0',
  OPENROUTER_API_KEY: '', OPENROUTER_BASE_URL: `${base}/openrouter`,
  DIRECT_API_KEY: '', DIRECT_BASE_URL: `${base}/direct/`, XAI_API_KEY: '', XAI_BASE_URL: `${base}/xai`,
});
const { db } = await import('../server/src/db.js');
const { setEnvOverride } = await import('../server/src/env.js');
const { selectCli } = await import('../server/src/cli/store.js');
const { saveOpenRouterKey } = await import('../server/src/providers/openrouter.js');
const { withUsage } = await import('../server/src/usage-context.js');
const { transcribe, speechStatus, SpeechUnavailable, SUBSCRIPTION_VOICE_UNAVAILABLE } = await import('../server/src/lib/speech.js');
const userId = 'speech-owner';
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(userId, 'speech@example.com', 'Speech owner', Date.now());
const configured = (openrouter = '', voice = '', direct = '') => {
  setEnvOverride('OPENROUTER_API_KEY', openrouter);
  setEnvOverride('XAI_API_KEY', voice);
  setEnvOverride('DIRECT_API_KEY', direct);
};
const hear = (audio = caf) => withUsage({ userId }, () => transcribe(audio, { language: 'en' }));
const status = () => withUsage({ userId }, speechStatus);
const assertMp3 = (upload: Upload) => {
  assert.notEqual(upload.data.subarray(0, 4).toString(), 'caff');
  assert.ok(upload.data.length > 500);
  assert.equal(upload.mime, upload.path.startsWith('/openrouter') ? 'mp3' : 'audio/mpeg');
  if (!upload.path.startsWith('/openrouter')) assert.equal(upload.filename, 'voice.mp3');
};
beforeEach(() => {
  configured(); selectCli(userId, null); failures.clear(); rejectOgg = null; uploads.length = 0;
  db.exec('DELETE FROM provider_connections; DELETE FROM usage_events;');
});
after(async () => {
  await new Promise<void>(resolve => upstream.close(() => resolve()));
  db.close(); fs.rmSync(root, { recursive: true, force: true });
});

test('standalone CAF uses OpenRouter first and status leaves platform TTS unchanged', async () => {
  configured('shared-openrouter', 'platform-voice', 'legacy-direct');
  assert.equal(await hear(), 'heard /openrouter/audio/transcriptions');
  assert.equal(uploads.length, 1); assertMp3(uploads[0]);
  assert.equal(uploads[0].key, 'Bearer shared-openrouter');
  assert.deepEqual(status(), { transcription: 'openrouter', speech: 'xai', sttModel: 'openai/gpt-4o-mini-transcribe', ttsModel: 'xai-tts' });
});

test('OpenRouter failure falls through to xAI with converted CAF and sanitized status logging', async t => {
  configured('shared-openrouter', 'platform-voice', 'legacy-direct');
  failures.set('/openrouter/audio/transcriptions', 503);
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args));
  assert.equal(await hear(), 'heard /xai/stt');
  assert.deepEqual(uploads.map(u => u.path), ['/openrouter/audio/transcriptions', '/xai/stt']);
  uploads.forEach(assertMp3);
  assert.equal(uploads[1].key, 'Bearer platform-voice');
  assert.equal(uploads[1].model, undefined);
  assert.deepEqual(warnings, [['[speech] openrouter transcription failed: 503']]);
});

test('xAI 400 falls through to the distinct legacy direct key and normalized base URL', async t => {
  configured('', 'platform-voice', 'legacy-direct');
  failures.set('/xai/stt', 400);
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args));
  assert.equal(await hear(), 'heard /direct/stt');
  assert.deepEqual(uploads.map(u => u.path), ['/xai/stt', '/direct/stt']);
  uploads.forEach(assertMp3);
  assert.equal(uploads[1].key, 'Bearer legacy-direct');
  assert.equal(uploads[1].model, 'audio-transcribe-latest');
  assert.deepEqual(warnings, [['[speech] xai transcription failed: 400']]);
});

for (const rejection of [400, 415]) test(`xAI retries rejected OGG once as MP3 (${rejection})`, async () => {
  configured('shared-openrouter', 'platform-voice', 'legacy-direct');
  selectCli(userId, 'codex'); rejectOgg = rejection;
  assert.equal(await hear(ogg), 'heard /xai/stt');
  assert.deepEqual(uploads.map(u => u.path), ['/xai/stt', '/xai/stt']);
  assert.deepEqual(uploads[0].data, ogg.data);
  assert.equal(uploads[0].mime, 'audio/ogg');
  assertMp3(uploads[1]);
});

test('a rejected MP3 retry is bounded and then falls through to legacy direct', async () => {
  configured('', 'platform-voice', 'legacy-direct'); failures.set('/xai/stt', 400);
  assert.equal(await hear(ogg), 'heard /direct/stt');
  assert.deepEqual(uploads.map(u => u.path), ['/xai/stt', '/xai/stt', '/direct/stt']);
  assertMp3(uploads[1]);
  assert.equal(uploads[2].key, 'Bearer legacy-direct');
});

test('subscription owner transcribes CAF via shared voice and never shared text API keys', async () => {
  configured('shared-openrouter', 'platform-voice', 'legacy-direct'); selectCli(userId, 'codex');
  assert.equal(await hear(), 'heard /xai/stt');
  assert.deepEqual(uploads.map(u => u.path), ['/xai/stt']); assertMp3(uploads[0]);
  assert.equal(status().transcription, 'xai');
  failures.set('/xai/stt', 503); uploads.length = 0;
  await assert.rejects(hear(), /transcription failed \(503\)/);
  assert.deepEqual(uploads.map(u => u.path), ['/xai/stt']);
});

for (const rejection of [401, 429, 503]) test(`subscription OGG ${rejection} does not retry format or use shared text keys`, async () => {
  configured('shared-openrouter', 'platform-voice', 'legacy-direct'); selectCli(userId, 'codex');
  failures.set('/xai/stt', rejection);
  await assert.rejects(hear(ogg), new RegExp(`transcription failed \\(${rejection}\\)`));
  assert.deepEqual(uploads.map(u => u.path), ['/xai/stt']);
  assert.equal(uploads[0].key, 'Bearer platform-voice');
  assert.deepEqual(uploads[0].data, ogg.data);
});

test('personal OpenRouter never switches to the shared OpenRouter key on failure', async () => {
  configured('shared-openrouter', 'platform-voice', 'legacy-direct'); saveOpenRouterKey(userId, 'personal-openrouter', 'manual');
  failures.set('/openrouter/audio/transcriptions', 401);
  assert.equal(await hear(), 'heard /xai/stt');
  assert.deepEqual(uploads.map(u => u.key), ['Bearer personal-openrouter', 'Bearer platform-voice']);
});

test('missing providers report SpeechUnavailable and subscription-only never uses shared text keys', async () => {
  await assert.rejects(hear(), SpeechUnavailable);
  configured('shared-openrouter', '', 'legacy-direct'); selectCli(userId, 'codex');
  await assert.rejects(hear(), error => error instanceof SpeechUnavailable && error.message === SUBSCRIPTION_VOICE_UNAVAILABLE);
  assert.equal(status().transcription, null);
  assert.equal(uploads.length, 0);
});
