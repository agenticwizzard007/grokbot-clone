import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { tsImport } from 'tsx/esm/api';
import { DEFAULT_CONFIG } from '../../../server/src/ui-config/schema.ts';
import { TOKENS } from '../../../server/src/ui-config/registry-tokens.ts';
import { FONTS } from '../../../server/src/ui-config/registry-fonts.ts';
import { parseScreen, screenHash, parentScreen, screenTitle, routeDashboard, dashboardSlug } from '../../../web/src/lib/navigation.ts';
const options = { parentURL: import.meta.url, tsconfig: 'web/tsconfig.json' };
const store = await tsImport('../../../web/src/customization/store.ts', options);
const { safeToken, TOKEN_NAMES } = await tsImport('../../../web/src/customization/applier.ts', options);
const values = new Map<string,string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key,value), removeItem: (key: string) => values.delete(key) } });
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; store.setUiUser(null); });
const body = (doc = DEFAULT_CONFIG, revision = 0) => ({ doc, revision, status: 'ready' });
async function reset(doc = DEFAULT_CONFIG, revision = 0) {
  store.setUiUser(null); values.clear(); globalThis.fetch = async () => Response.json(body(doc, revision));
  store.setUiUser('QA-Temp-Alpha'); await store.refreshUiConfig();
}
test('only registered CSS names and exact registry values reach the applier', () => {
  for (const token of TOKENS) for (const name of token.cssVars) assert.ok(TOKEN_NAMES.includes(name) && safeToken(name, '#12ABCD'));
  for (const value of ['red','url(https://example.test)','var(--other)','#FFF','#FFFFFF00','expression(alert(1))']) assert.equal(safeToken('--color-primary', value),false);
  assert.equal(safeToken('--color-bot-orange','#123456'),false); assert.equal(safeToken('--unknown','#123456'),false);
  for (const font of FONTS) assert.ok(safeToken('--font-stack',font.stack));
  assert.equal(safeToken('--font-stack','"Remote font"'),false); assert.equal(safeToken('--control-h','2px'),false);
});
test('cache is schema validated, revision validated and account scoped', async () => {
  await reset(); values.set(store.CACHE_KEY,JSON.stringify({userId:'QA-Temp-Alpha',revision:3,doc:DEFAULT_CONFIG}));
  assert.equal(store.readCachedConfig('QA-Temp-Alpha').revision,3); assert.equal(store.readCachedConfig('QA-Temp-Beta'),null);
  for(const doc of [{...DEFAULT_CONFIG,theme:{...DEFAULT_CONFIG.theme,colors:{light:{pane:'url(evil)'},dark:{}}}}, {...DEFAULT_CONFIG,unknown:true}]) {
    values.set(store.CACHE_KEY,JSON.stringify({userId:'QA-Temp-Alpha',revision:3,doc})); assert.equal(store.readCachedConfig('QA-Temp-Alpha'),null);
  }
});
test('startup validates cached revisions with a full response', async () => {
  await reset(); store.setUiUser(null);
  values.set(store.CACHE_KEY, JSON.stringify({ userId: 'QA-Temp-Alpha', revision: 4, doc: DEFAULT_CONFIG }));
  const requests: unknown[] = [];
  globalThis.fetch = async (_url, init) => { requests.push(init?.headers); return Response.json({ ...body(DEFAULT_CONFIG, 4), status: 'invalid_stored' }); };
  store.setUiUser('QA-Temp-Alpha'); await store.refreshUiConfig();
  assert.equal(requests[0]['If-None-Match'], undefined);
  assert.equal(store.useCustomization.getState().invalidStored, true);
});
test('patch sends If-Match and returns structured validation errors', async () => {
  await reset(DEFAULT_CONFIG,3); let headers;
  globalThis.fetch = async (_url,init) => { headers=init?.headers; return Response.json({code:'accessibility',message:'Low contrast.',details:[{path:'/theme/colors/light/primary',code:'accessibility',message:'Low contrast.'}]},{status:422}); };
  const result=await store.patchUiConfig([{op:'add',path:'/theme/colors/light/primary',value:'#FFFFFF'}]);
  assert.equal(headers['If-Match'],'"3"'); assert.equal(result.ok,false); assert.equal(result.errors[0].code,'accessibility'); assert.equal(store.useCustomization.getState().revision,3);
});
test('a revision conflict refreshes without silently retrying the write', async () => {
  await reset(DEFAULT_CONFIG,3); const methods:string[]=[];
  globalThis.fetch=async (_url,init)=>{methods.push(init?.method??'GET');return init?.method==='PATCH'?Response.json({code:'stale_revision',message:'Read the latest revision.'},{status:409}):Response.json(body(DEFAULT_CONFIG,4));};
  const result=await store.patchUiConfig([{op:'replace',path:'/theme/mode',value:'dark'}]);
  assert.equal(result.ok,false); assert.deepEqual(methods,['PATCH','GET']);assert.equal(store.useCustomization.getState().revision,4);
});
test('late responses from a signed-out account cannot change the next account', async () => {
  await reset(); let complete:(response:Response)=>void=()=>{};
  globalThis.fetch=async()=>new Promise(resolve=>{complete=resolve;});
  const pending=store.patchUiConfig([{op:'replace',path:'/theme/mode',value:'dark'}]);
  store.setUiUser(null); globalThis.fetch=async()=>Response.json(body());store.setUiUser('QA-Temp-Beta');await store.refreshUiConfig();
  complete(Response.json({ok:true,...body({...DEFAULT_CONFIG,theme:{...DEFAULT_CONFIG.theme,mode:'dark'}},1)}));
  assert.equal((await pending).ok,false);assert.equal(store.useCustomization.getState().saved.theme.mode,'system');assert.equal(store.useCustomization.getState().userId,'QA-Temp-Beta');
});
test('disabled ignores the cache and fetch failures preserve the saved config',async()=>{
  const doc={...DEFAULT_CONFIG,theme:{...DEFAULT_CONFIG.theme,mode:'dark' as const}};await reset(doc,2);
  globalThis.fetch=async()=>{throw new Error('offline');};await store.refreshUiConfig();assert.equal(store.useCustomization.getState().status,'offline');assert.equal(store.useCustomization.getState().saved.theme.mode,'dark');
  globalThis.fetch=async()=>Response.json({code:'disabled',message:'Disabled.'},{status:404});await store.refreshUiConfig();assert.equal(store.useCustomization.getState().status,'disabled');assert.equal(values.has(store.CACHE_KEY),false);assert.equal(store.useCustomization.getState().effective.theme.mode,'system');
});
test('phone overlay and safe mode preserve the saved document',async()=>{
  const doc={...DEFAULT_CONFIG,theme:{...DEFAULT_CONFIG.theme,density:'compact' as const},device:{phone:{scale:'xlarge' as const}}};await reset(doc);
  store.setUiPhone(true);assert.equal(store.useCustomization.getState().effective.theme.density,'default');assert.equal(store.useCustomization.getState().effective.theme.font.scale,'xlarge');
  store.setUiSafe(true);assert.equal(store.useCustomization.getState().effective.theme.font.scale,'default');assert.equal(store.useCustomization.getState().saved.theme.density,'compact');store.setUiSafe(false);store.setUiPhone(false);
});
test('dashboard ids and readable slugs round trip with structural Back and titles',()=>{
  const dashboard={id:'d_12345678',name:'My week'};for(const reference of [dashboard.id,dashboardSlug(dashboard),'old-name-'+dashboard.id]){const screen=parseScreen('#dash/'+reference);assert.ok(screen);assert.equal(screenHash(screen),'#dash/'+reference);assert.deepEqual(parentScreen(screen),{kind:'bots'});assert.equal(routeDashboard(reference,[dashboard]),dashboard);assert.equal(screenTitle(screen),'Dashboard · Swarm');}
  for(const route of ['#dash/%','#dash/a/b','#dash/%3Cscript%3E','#dash/'])assert.equal(parseScreen(route),null);
  assert.deepEqual(parseScreen('#settings/appearance'),{kind:'settings',section:'appearance'});
});
const boot=fs.readFileSync('web/public/ui-boot.js','utf8');
function runBoot({user='QA-Temp-Alpha',cachedUser=user,forced=false,safe=false,version=1,tokens={}}:{user?:string;cachedUser?:string;forced?:boolean;safe?:boolean;version?:number;tokens?:Record<string,string>}={}){
  const properties:Record<string,string>={},root={dataset:{},style:{setProperty:(name:string,value:string)=>{properties[name]=value;}}};
  const cache={userId:cachedUser,doc:{version,theme:{mode:'dark'}},boot:{dark:tokens}};
  vm.runInNewContext(boot,{document:{documentElement:root},localStorage:{getItem:(key:string)=>key==='swarm.ui.user'?user:key==='swarm.ui.v1'?JSON.stringify(cache):'light'},sessionStorage:{getItem:()=>null},location:{search:safe?'?ui=safe':''},URLSearchParams,matchMedia:(query:string)=>({matches:forced&&query.includes('forced-colors')})});return {properties,root};
}
test('blocking boot is under 2 KB, content versioned and has no inline script',()=>{
  assert.ok(Buffer.byteLength(boot)<2048); const hash=createHash('sha256').update(boot).digest('hex').slice(0,16);const html=fs.readFileSync('web/index.html','utf8');assert.ok(html.includes(`/ui-boot.js?v=${hash}`));assert.match(html,/<script src="\/ui-boot.js[^\"]+"><\/script>/);assert.doesNotMatch(html,/<script[^>]*>[^<\s]/);
});
test('pre-paint cache accepts allowlisted colors and fonts, rejects CSS injection and identity colors',()=>{
  const tokens={'--color-bg-pane':'#123456','--font-stack':FONTS[2].stack,'--font-scale':'1.25','--color-bot-orange':'#000000','--color-primary':'url(https://example.test)','--other':'red'};
  assert.deepEqual(runBoot({tokens}).properties,{'--color-bg-pane':'#123456','--font-stack':FONTS[2].stack,'--font-scale':'1.25'});
});
test('pre-paint cache ignores a different account, safe mode, forced colors and unknown versions',()=>{
  const tokens={'--color-bg-pane':'#123456'};for(const extra of [{cachedUser:'QA-Temp-Beta'},{safe:true},{forced:true},{version:99}])assert.deepEqual(runBoot({tokens,...extra}).properties,{});
});
test('customization source contains no HTML evaluation or forbidden copy punctuation',()=>{
  for(const file of fs.readdirSync('web/src/customization',{recursive:true}).filter(file=>/\.(ts|tsx)$/.test(String(file)))){
    const source=fs.readFileSync(`web/src/customization/${file}`,'utf8');assert.doesNotMatch(source,/dangerouslySetInnerHTML|\binnerHTML\b|insertAdjacentHTML|new Function|[\u2013\u2014]/,String(file));
  }
});
