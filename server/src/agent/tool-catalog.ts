/**
 * Native TypeScript adaptation of Hermes tools/tool_search_catalog.py and tool_search.py
 * at f0e7b68e439f8c1962fcf9dcb0341aadf1e2a898 (Nous Research, MIT).
 * Retains BM25, rarest-term admission, coverage floor, exact-name priority and
 * search -> describe -> resolve. Swarm owns schemas, scope and authorization.
 * See THIRD_PARTY_NOTICES.md. Tokenization uses Unicode words and conservative
 * plural normalization instead of Hermes's English Snowball dependency.
 */
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { ToolDef } from './tools.js';

export interface FunctionSchema {
  type: 'function'; name: string; description?: string;
  parameters: Record<string, unknown>; [key: string]: unknown;
}
const BRIDGES = new Set(['tool_search', 'tool_describe', 'tool_call']);
const CORE = new Set(['ask_user', 'get_platform_state', 'remember', 'recall', 'search_history',
  'read_history', 'session_search', 'search_skills', 'read_skill', 'list_skills', 'propose_skill',
  'list_app_connections', 'search_apps', 'request_app_connection', 'SWARM_APPS_SEARCH',
  'SWARM_APPS_EXECUTE', 'save_file', 'execute_code', 'save_agent_setup']);
export const TOOL_VALIDATION_LIMITS = Object.freeze({ schemaBytes: 256_000, argumentBytes: 1_000_000, depth: 32, nodes: 50_000, timeoutMs: 1500, concurrent: 4, queued: 64 });

/** Iterative host-side JSON bounds only: no schema interpretation or regex.
 * Bounds apply before stringify, hashing, structured cloning or worker startup. */
function boundedJson(value: unknown, maxBytes: number, label: string): string {
  const todo: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0, bytes = 0;
  const addString = (s: string) => {
    if (s.length > maxBytes) throw new Error(`${label} exceeds its size limit.`);
    bytes += Buffer.byteLength(JSON.stringify(s));
  };
  while (todo.length) {
    const { value: v, depth } = todo.pop()!;
    if (++nodes > TOOL_VALIDATION_LIMITS.nodes || depth > TOOL_VALIDATION_LIMITS.depth) throw new Error(`${label} exceeds its depth or complexity limit.`);
    if (v === null) bytes += 4;
    else if (typeof v === 'string') addString(v);
    else if (typeof v === 'boolean') bytes += v ? 4 : 5;
    else if (typeof v === 'number' && Number.isFinite(v)) bytes += String(v).length;
    else if (typeof v === 'object') {
      const isArray = Array.isArray(v);
      if (!isArray && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new Error(`${label} must contain only JSON values.`);
      const keys = Object.keys(v);
      if (isArray && (v.length !== keys.length || keys.some((key, i) => key !== String(i)))) throw new Error(`${label} must contain dense JSON arrays.`);
      if (nodes + todo.length + keys.length > TOOL_VALIDATION_LIMITS.nodes) throw new Error(`${label} exceeds its complexity limit.`);
      bytes += 2 + Math.max(0, keys.length - 1);
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
        if (!('value' in descriptor)) throw new Error(`${label} cannot contain accessors.`);
        if (!isArray) { addString(key); bytes++; }
        todo.push({ value: descriptor.value, depth: depth + 1 });
        if (bytes > maxBytes) throw new Error(`${label} exceeds its size limit.`);
      }
    } else throw new Error(`${label} must contain only JSON values.`);
    if (bytes > maxBytes) throw new Error(`${label} exceeds its size limit.`);
  }
  const text = JSON.stringify(value);
  if (!text || Buffer.byteLength(text) > maxBytes) throw new Error(`${label} exceeds its size limit.`);
  return text;
}

// Trusted bootstrap only. Untrusted schema regex/ref compilation and execution
// stay in this disposable worker. Parent termination can interrupt both phases.
const VALIDATION_WORKER = String.raw`
(() => {
const { parentPort, workerData } = require('node:worker_threads');
try {
  const { Ajv } = require('ajv');
  const ajv = new Ajv({ strict:false, allErrors:false, validateFormats:false,
    addUsedSchema:false, ownProperties:true, inlineRefs:false, loopRequired:100, loopEnum:100 });
  let validate;
  try { validate = ajv.compile(JSON.parse(workerData.schema)); }
  catch { parentPort.postMessage({ok:false,error:'This tool schema cannot be validated. Refresh the connection before executing.'}); return; }
  const ok = validate(JSON.parse(workerData.args));
  parentPort.postMessage(ok ? {ok:true} : {ok:false,error:'Invalid tool arguments: '+ajv.errorsText(validate.errors).slice(0,700)});
} catch { parentPort.postMessage({ok:false,error:'Tool schema validation failed safely.'}); }
})();
`;
let activeValidators = 0;
const validationQueue: { start: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];
function validatorSlot(): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const start = () => {
      activeValidators++;
      let released = false;
      resolve(() => {
        if (released) return; released = true; activeValidators--;
        const queued = validationQueue.shift();
        if (queued) { clearTimeout(queued.timer); queued.start(); }
      });
    };
    if (activeValidators < TOOL_VALIDATION_LIMITS.concurrent) return start();
    if (validationQueue.length >= TOOL_VALIDATION_LIMITS.queued) return reject(new Error('Tool validation is busy. Retry shortly.'));
    const entry = { start, reject, timer: undefined as unknown as ReturnType<typeof setTimeout> };
    entry.timer = setTimeout(() => {
      const index = validationQueue.indexOf(entry); if (index >= 0) validationQueue.splice(index, 1);
      reject(new Error('Tool validation queue time limit exceeded.'));
    }, TOOL_VALIDATION_LIMITS.timeoutMs);
    validationQueue.push(entry);
  });
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as any)[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function toolSchemaHash(tool: FunctionSchema): string {
  if (typeof tool.name !== 'string' || tool.name.length > 1000) throw new Error('Tool name is unavailable or too large.');
  const schema = JSON.parse(boundedJson(tool.parameters, TOOL_VALIDATION_LIMITS.schemaBytes, 'Tool schema'));
  return createHash('sha256').update(canonical({ name: tool.name, parameters: schema })).digest('hex');
}
const tokens = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map(t => t.length > 4 && t.endsWith('ies') ? `${t.slice(0, -3)}y` : t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t);
const functions = (tools: any[]): FunctionSchema[] => tools.filter(t => t?.type === 'function' && typeof t.name === 'string' && !BRIDGES.has(t.name));

export function searchToolCatalog(tools: any[], query: string, limit = 5) {
  const entries = functions(tools).map(tool => ({ tool, words: tokens(`${tool.name.replace(/^mcp_/, '').replace(/[_:.-]/g, ' ')} ${tool.description ?? ''} ${Object.keys((tool.parameters?.properties ?? {}) as object).join(' ')}`) }));
  const terms = tokens(query.slice(0, 1000));
  if (!terms.length) return [];
  const df = new Map<string, number>();
  for (const entry of entries) for (const term of new Set(entry.words)) df.set(term, (df.get(term) ?? 0) + 1);
  const count = entries.length, avg = Math.max(1, entries.reduce((n, e) => n + e.words.length, 0) / Math.max(1, count));
  const idf = (term: string) => Math.log(1 + (count - (df.get(term) ?? 0) + .5) / ((df.get(term) ?? 0) + .5));
  const answerable = [...new Set(terms)].filter(t => df.has(t));
  if (!answerable.length) return [];
  const rarest = [...answerable].sort((a, b) => idf(b) - idf(a))[0];
  const required = answerable.length < 4 ? 1 : Math.ceil(answerable.length / 2);
  return entries.map(({ tool, words }) => {
    if (tool.name.toLowerCase() === query.trim().toLowerCase()) return { tool, score: Infinity };
    const tf = new Map<string, number>();
    for (const word of words) tf.set(word, (tf.get(word) ?? 0) + 1);
    if (!tf.has(rarest) || answerable.filter(t => tf.has(t)).length < required) return { tool, score: 0 };
    const score = terms.reduce((sum, term) => {
      const frequency = tf.get(term) ?? 0;
      return sum + (frequency ? idf(term) * frequency * 2.5 / (frequency + 1.5 * (.25 + .75 * words.length / avg)) : 0);
    }, 0);
    return { tool, score };
  }).filter(e => e.score > 0).sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, Math.min(20, Math.max(1, limit))).flatMap(({ tool }) => {
      try { return [{ name: tool.name, description: (tool.description ?? '').slice(0, 500), schema_hash: toolSchemaHash(tool) }]; }
      catch { return []; } // One malformed schema must not hide other tool results.
    });
}

/** Bounded manifest. Large MCP catalogs remain searchable without eager schemas. */
export function assembleToolCatalog(all: any[]): { tools: any[]; manifest: string } {
  const callable = functions(all);
  const defer = callable.length > 40 || JSON.stringify(callable).length > 32_000;
  if (!defer) return { tools: all, manifest: '' };
  const hidden = callable.filter(t => !CORE.has(t.name));
  const visible = all.filter(t => t.type !== 'function' || CORE.has(t.name) || BRIDGES.has(t.name));
  const groups = new Map<string, number>();
  for (const tool of hidden) {
    const key = tool.name.startsWith('mcp_') ? tool.name.split('_').slice(0, 3).join('_') : 'Swarm';
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const lines = hidden.map(t => `- ${t.name}: ${(t.description ?? '').replace(/\s+/g, ' ').slice(0, 100)}`).sort();
  const listing = lines.join('\n');
  const bounded = listing.length <= 6500 ? listing : [...groups].sort().map(([name, n]) => `- ${name}: ${n} tools`).join('\n').slice(0, 6500);
  return { tools: visible, manifest: `Additional tools are available on demand. Use tool_search for the action, tool_describe for its exact schema, then tool_call with that schema_hash. Discovery never grants permission.\n${bounded}` };
}

export async function validateToolArguments(tool: FunctionSchema, args: unknown): Promise<void> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
  const schema = boundedJson(tool.parameters, TOOL_VALIDATION_LIMITS.schemaBytes, 'Tool schema');
  const input = boundedJson(args, TOOL_VALIDATION_LIMITS.argumentBytes, 'Tool arguments');
  const release = await validatorSlot();
  let worker: Worker | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (error?: Error) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(); };
      const timer = setTimeout(() => finish(new Error('Tool schema validation time limit exceeded.')), TOOL_VALIDATION_LIMITS.timeoutMs);
      try {
        worker = new Worker(VALIDATION_WORKER, { eval: true, execArgv: [], workerData: { schema, args: input }, resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 } });
        worker.once('message', (message: { ok?: boolean; error?: string }) => finish(message?.ok === true ? undefined : new Error(String(message?.error ?? 'Tool schema validation failed safely.').slice(0, 900))));
        worker.once('error', () => finish(new Error('Tool schema validation exceeded its resource limits.')));
        worker.once('exit', () => finish(new Error('Tool schema validator exited before completing.')));
      } catch { finish(new Error('Tool schema validator could not start.')); }
    });
  } finally {
    // Do not admit another validator until the terminated worker has exited.
    try { await worker?.terminate(); } finally { release(); }
  }
}

export async function resolveToolCall(all: any[], input: unknown) {
  const a = input as any;
  if (!a || typeof a !== 'object' || Array.isArray(a) || typeof a.tool_name !== 'string' || BRIDGES.has(a.tool_name)
    || Object.keys(a).some(k => !['tool_name', 'arguments', 'schema_hash'].includes(k))) throw new Error('Request one described tool with its exact arguments and schema_hash.');
  const tool = functions(all).find(t => t.name === a.tool_name);
  if (!tool) throw new Error('This tool is no longer available to this Bot. Search again.');
  if (a.schema_hash !== toolSchemaHash(tool)) throw new Error('The tool schema changed. Describe it again before executing.');
  await validateToolArguments(tool, a.arguments);
  return { name: tool.name, args: a.arguments as Record<string, unknown> };
}

const object = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
export const DISCOVERY_TOOLS: ToolDef[] = [
  { name: 'tool_search', description: 'Search additional authorized Swarm and MCP tools by task. Returns names and descriptions; call tool_describe before tool_call.', parameters: object({ query: { type: 'string', maxLength: 1000 }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, ['query']), activity: 'working', label: 'Finding tools',
    impl: async (a, ctx) => ({ output: JSON.stringify(searchToolCatalog(await ctx.availableTools!(), String(a.query), Number(a.limit) || 5)) }) },
  { name: 'tool_describe', description: 'Read the current exact schema of an authorized tool. Use its schema_hash and arguments with tool_call. Re-describe after a connection changes.', parameters: object({ tool_name: { type: 'string' } }, ['tool_name']), activity: 'working', label: 'Reading tool details',
    impl: async (a, ctx) => { const tool = functions(await ctx.availableTools!()).find(t => t.name === a.tool_name); if (!tool) throw new Error('Tool not available.'); return { output: JSON.stringify({ ...tool, schema_hash: toolSchemaHash(tool) }) }; } },
  { name: 'tool_call', description: 'Execute one described tool. The underlying action retains all account, schema, revision, approval and audit checks. Nested wrappers and batches are not accepted.', parameters: object({ tool_name: { type: 'string' }, arguments: { type: 'object', additionalProperties: true }, schema_hash: { type: 'string' } }, ['tool_name', 'arguments', 'schema_hash']), activity: 'working', label: 'Using selected tool',
    impl: async () => { throw new Error('Deferred calls must pass through the action dispatcher.'); } },
];
