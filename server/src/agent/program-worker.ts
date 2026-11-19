/** Trusted worker bootstrap. User code is evaluated only in the QuickJS WASM VM,
 * never by Node eval/vm. No filesystem, network, process, imports or credentials
 * are installed in the guest. The single host capability is a bounded tool RPC.
 */
export const PROGRAM_WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const { newAsyncContext } = await import('quickjs-emscripten');
  const vm = await newAsyncContext();
  const pending = new Map();
  let next = 0, printed = 0;
  const deadline = Date.now() + workerData.timeoutMs;
  vm.runtime.setMemoryLimit(32 * 1024 * 1024);
  vm.runtime.setMaxStackSize(512 * 1024);
  vm.runtime.setInterruptHandler(() => Date.now() > deadline);
  parentPort.on('message', message => {
    const settle = pending.get(message.id);
    if (settle) { pending.delete(message.id); settle(message); }
  });
  vm.newString(JSON.stringify(workerData.inputs)).consume(h => vm.setProp(vm.global, '__inputs', h));
  vm.newFunction('__print', value => {
    const text = vm.getString(value);
    printed += Buffer.byteLength(text);
    if (printed > 32000) throw new Error('Program output limit exceeded. Return a summary and save a file.');
    parentPort.postMessage({ type: 'stdout', text });
  }).consume(h => vm.setProp(vm.global, '__print', h));
  vm.newAsyncifiedFunction('__call', async (nameHandle, argsHandle) => {
    const name = vm.getString(nameHandle), args = vm.getString(argsHandle), id = next++;
    if (id >= workerData.maxCalls || args.length > 1000000) throw new Error('Program tool-call limit exceeded.');
    const response = await new Promise(resolve => { pending.set(id, resolve); parentPort.postMessage({ type: 'call', id, name, args }); });
    if (response.error) throw new Error(response.error);
    return vm.newString(response.value);
  }).consume(h => vm.setProp(vm.global, '__call', h));
  const seed = workerData.seed >>> 0, epoch = workerData.createdAt;
  const prelude = '(function(){ "use strict"; const inputs = JSON.parse(__inputs);' +
    'const tools = Object.freeze({call(name,args){return JSON.parse(__call(String(name),JSON.stringify(args)));}});' +
    'const print = (...values) => __print(values.map(v => typeof v === "string" ? v : JSON.stringify(v)).join(" "));' +
    'const console = Object.freeze({log:print});' +
    'let seed = ' + seed + '; Math.random = () => { seed = (Math.imul(seed,1664525)+1013904223)>>>0; return seed/4294967296; };' +
    'const NativeDate = Date; globalThis.Date = class extends NativeDate { constructor(...a){super(...(a.length?a:[' + epoch + ']));} static now(){return ' + epoch + ';} };\n';
  try {
    const evaluated = await vm.evalCodeAsync(prelude + workerData.code + '\n})()', 'swarm-program.js');
    if (evaluated.error) { const error = vm.dump(evaluated.error); evaluated.error.dispose(); throw new Error(error.message || String(error)); }
    const value = vm.dump(evaluated.value); evaluated.value.dispose();
    const json = JSON.stringify(value ?? null);
    if (Buffer.byteLength(json) > 64000) throw new Error('Program result exceeds 64 KB. Save a file and return a summary.');
    parentPort.postMessage({ type: 'result', value: JSON.parse(json) });
  } finally { vm.dispose(); }
})().catch(error => parentPort.postMessage({ type: 'error', error: String(error.message || error).slice(0, 2000) }));
`;
