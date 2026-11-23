// Real components, temporary SQLite, DEV_LOGIN and local model/toolkit fixtures.
// Run: node tests/visual-polish-ui.mjs. Capture baseline with VISUAL_PHASE=before.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const temp = await mkdtemp(path.join(os.tmpdir(), 'swarm-visual-'));
const evidence = path.join(root, 'artifacts/visual-polish');
await mkdir(evidence, { recursive: true });
async function port() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
const apiPort = await port(), uiPort = await port(), mockPort = await port();
const apiBase = `http://127.0.0.1:${apiPort}`, origin = `http://127.0.0.1:${uiPort}`;
// Deliberately omit inherited app credentials and local .env files.
const env = {
  PATH: process.env.PATH, TMPDIR: temp, NODE_ENV: 'test', SWARM_ROLE: 'standalone',
  DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'),
  CLI_PROFILES_DIR: path.join(temp, 'cli'), SESSION_SECRET: 'visual-test-only',
  DEV_LOGIN: '1', PORT: String(apiPort), APP_URL: origin, SERVER_URL: origin,
  COMPUTER_PROVIDER: 'local', SWARM_NO_SCHEDULER: '1', MEMORY_CONSOLIDATE_IDLE_MINUTES: '0',
  INKBOX_TUNNEL: '0', WHATSAPP_DISABLED: '1', COMPOSIO_API_KEY: 'visual-test-project',
  DIRECT_API_KEY: 'mock-key', DIRECT_BASE_URL: `http://127.0.0.1:${mockPort}/v1`, LLM_PROVIDER: 'direct',
};
const children = [], logs = [];
let browser;
function start(args, cwd = root, extra = {}) {
  const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => logs.push(String(data)));
  return child;
}
async function ready(url) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await fetch(url).then(response => response.ok, () => false)) return;
    if (children.some(child => child.exitCode !== null)) throw new Error(logs.join(''));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out starting local server: ${logs.join('')}`);
}

try {
  start(['tests/mock-provider.mjs', String(mockPort)]);
  await ready(`http://127.0.0.1:${mockPort}/v1/models`);
  start(['--import', 'tsx', '--input-type=module', '-e', `
    const localFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === '127.0.0.1') return localFetch(input, init);
      if (url.hostname === 'backend.composio.dev') return Response.json({ items: [] });
      if (url.hostname === 'registry.npmjs.org') return Response.json({ version: '0.28.0' });
      if (url.hostname === 'telemetry.composio.dev') return Response.json({});
      throw new Error('Unexpected external request: ' + url.hostname);
    };
    const { composio } = await import('./server/src/composio.ts');
    composio().connectedAccounts.list = async () => ({ items: [] });
    await import('./server/src/index.ts');
  `]);
  await ready(`${apiBase}/api/health`);
  start([path.join(root, 'web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: apiBase });
  await ready(origin);
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });


  // Measure the rendered colors, including translucent backgrounds over ancestors.
  const contrast = locator => locator.evaluate(element => {
    const rgba = value => { const parts = value.match(/[\d.]+/g).map(Number); return [parts[0], parts[1], parts[2], parts[3] ?? 1]; };
    const blend = (front, back) => front.slice(0, 3).map((c, i) => c * front[3] + back[i] * (1 - front[3])).concat(1);
    let bg = [255, 255, 255, 1];
    for (const node of [element, ...function* () { for (let p = element.parentElement; p; p = p.parentElement) yield p; }()].reverse()) bg = blend(rgba(getComputedStyle(node).backgroundColor), bg);
    const fg = blend(rgba(getComputedStyle(element).color), bg);
    const luminance = color => color.slice(0, 3).map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
    const a = luminance(fg), b = luminance(bg); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
  });
  const styles = (locator, keys) => locator.evaluate((element, keys) => Object.fromEntries(keys.map(key => [key, getComputedStyle(element)[key]])), keys);
  const close = (a, b, label, tolerance = 1) => assert.ok(Math.abs(a - b) <= tolerance, `${label}: ${a} vs ${b}`);
  const center = box => box.y + box.height / 2;
  const phase = process.env.VISUAL_PHASE || 'after';
  for (const width of [390, 1280]) for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const response = await context.request.post(`${origin}/api/auth/dev`, { data: { email: `visual-${width}-${theme}@example.test`, name: 'Test account' } });
    assert.ok(response.ok());
    const { user } = await (await context.request.get(`${origin}/api/auth/me`)).json();
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const bot = { id: 'visual-bot', name: 'Test Bot', label: 'Personal assistant', mode: 'personal', kind: 'bot',
      avatarShape: 'blob', avatarColor: 'blue', model: 'claude/sonnet', effort: 'medium', generation: 1, unread: 0, isPrimary: false };
    const row = (seq, body) => ({ seq, botId: bot.id, generation: 1, createdAt: 1806012000000 + seq * 1000, body });
    const rows = [row(1, { type: 'message', role: 'assistant', text: 'I can help with your inbox.' }),
      row(2, { type: 'message', role: 'user', text: "What's my latest emails" }), row(3, { type: 'notice', text: 'Stopped.' })];
    const account = { id: 'fake-account', toolkit: 'gmail', status: 'ACTIVE', accountLabel: 'inbox@example.test', displayStatus: 'active', connectedAt: '2026-11-20T12:00:00Z', isDefault: true, isDisabled: false };
    const app = { accounts: [account], slug: 'gmail', name: 'Gmail', connected: true, description: 'Read, organize, search and manage all your email conversations, attachments, labels and drafts from a single connected workspace.', categories: ['communication'] };
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      const respond = json => route.fulfill({ json });
      if (url.pathname === '/api/models') return respond({ provider: 'claude-cli', billing: 'plan', plan: 'max', canFast: false, defaultModel: bot.model, favourites: [bot.model],
        models: [{ id: bot.model, name: 'Sonnet', short: 'Sonnet', author: 'anthropic', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', reasoning: true, vision: true, billing: 'plan' }] });
      if (url.pathname === '/api/cli') return respond({ runtime: 'server', serverLoginAvailable: true, selected: null, connected: true,
        providers: { claude: { installed: true, authenticated: false, subscription: false }, codex: { installed: true, authenticated: false, subscription: false } } });
      if (url.pathname === '/api/apps') return respond({ apps: [app], connected: ['gmail'], connectedApps: [app], categories: [], total: 1, nextOffset: null });
      if (url.pathname === '/api/apps/connections') return respond({ connections: [account] });
      if (url.pathname === '/api/auth/me') return route.continue();
      if (url.pathname.startsWith('/api/')) return respond({ exchanges: [], nextBefore: null, setups: [], suggestions: [], rows: [], routines: [], tasks: [] });
      return route.continue();
    });
    await page.route('**/src/main.tsx', route => route.fulfill({ contentType: 'application/javascript', body: `
import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import {ChatView} from '/src/components/ChatView.tsx';
import {SignIn} from '/src/components/SignIn.tsx';
import {ReauthPrompt} from '/src/components/config/ReauthPrompt.tsx';
import {SubscriptionSettings} from '/src/components/config/SubscriptionSettings.tsx';
import {AppSettings} from '/src/components/config/AppSettings.tsx';
import {ConnectAppsModal} from '/src/components/modals/ConnectAppsModal.tsx';
import {useStore} from '/src/store.ts';
import {useVoice} from '/src/voice/call.ts';
import {useConfigUI} from '/src/configStore.ts';
import '/src/styles/tokens.css';import '/src/styles/base.css';
import '/src/AuthenticatedShell.tsx';
document.documentElement.dataset.theme=${JSON.stringify(theme)};
const bot=${JSON.stringify(bot)}, rows=${JSON.stringify(rows)};
useStore.setState({user:${JSON.stringify(user)},devLogin:true,googleLogin:true,appleLogin:true,bots:[bot],botsLoaded:true,mobile:innerWidth<760,selectedBotId:bot.id,detailsOpen:false,
 transcripts:{[bot.id]:{generation:1,loaded:true,bySeq:Object.fromEntries(rows.map(r=>[r.seq,r]))}}});
window.fixture={store:useStore,voice:useVoice,rows,bot};
function Harness(){ const [screen,setScreen]=React.useState('chat');window.showScreen=setScreen;
 if(screen==='signin') return React.createElement(SignIn);
 if(screen==='connect'||screen==='reauth') return React.createElement('div',{className:'access-settings',style:{height:'100%',overflow:'auto'}},React.createElement('div',{className:'app-settings__page',style:{maxWidth:784,margin:'auto'}},
 screen==='connect'?React.createElement(SubscriptionSettings):React.createElement('div',{className:'subscription-settings'},React.createElement(ReauthPrompt,{accountEmail:'test@example.test',reason:'Your session has expired.',resume:{section:'keys',provider:'claude',action:'login'},retryLabel:'Connect plan',terminalActive:false,onCancel:()=>{}}))));
 if(screen==='accounts') return React.createElement(AppSettings);
 return React.createElement('div',{className:'app'+(innerWidth<760?' is-mobile':''),style:{height:'100%'}},React.createElement(ChatView),screen==='connections'?React.createElement(ConnectAppsModal):null);
}
window.showAccounts=()=>useConfigUI.getState().openAppSettings('apps');
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
` }));
    await page.goto(origin);
    await page.locator('.bubble.is-user').waitFor();
    const show = async screen => { await page.evaluate(screen => window.showScreen(screen), screen); await page.evaluate(() => document.fonts.ready); };
    const shot = async screen => { await page.screenshot({ path: path.join(evidence, `${phase}-${screen}-${width}${theme === 'dark' ? '' : '-light'}.png`), fullPage: true }); };
    await page.locator('.model-pill__name').filter({ hasText: 'Sonnet' }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    if (phase === 'after') {
      const details = await page.locator('.chat__details').boundingBox(), name = await page.locator('.chat__pill-anchor').boundingBox();
      assert.ok(details.height >= 44 && details.height <= 48 && details.width < 90);
      close(center(details), center(name), 'Details centers on the name and role');
      assert.equal(await page.locator('.chat__details').evaluate(el => getComputedStyle(el, '::before').top), '6px');
      const chip = page.locator('.model-pill');
      const parts = await Promise.all(['.model-pill__name', '.model-billing', '.model-pill__effort'].map(selector => chip.locator(selector).boundingBox()));
      for (const part of parts) { close(center(part), center(parts[0]), 'Model chip shares one baseline', 2); assert.ok(part.width > 25); }
      assert.equal(await chip.locator('.model-pill__name').evaluate(el => el.scrollWidth <= el.clientWidth), true, 'Sonnet stays readable');
      const input = await page.locator('.composer__input').boundingBox(), chipBox = await chip.boundingBox();
      assert.ok(input.x + input.width <= chipBox.x || input.y + input.height <= chipBox.y, 'Placeholder and model chip do not collide');
      const userBubble = page.locator('.bubble.is-user'), agentBubble = page.locator('.bubble.is-agent');
      const [userBox, agentBox, column] = await Promise.all([userBubble.boundingBox(), agentBubble.boundingBox(), page.locator('.transcript__col').boundingBox()]);
      const textWidth = await userBubble.locator('.bubble__plain').evaluate(el => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect().width; });
      assert.ok(userBox.width < column.width * .8 && userBox.width - textWidth <= 32.5, 'Short messages hug their text');
      close(agentBox.x - column.x, column.x + column.width - userBox.x - userBox.width, 'Both sides share gutters');
      assert.deepEqual(await styles(userBubble.locator('.bubble__sender'), ['fontSize','fontWeight','lineHeight','marginBottom']), await styles(agentBubble.locator('.bubble__sender'), ['fontSize','fontWeight','lineHeight','marginBottom']));
      assert.equal((await styles(userBubble.locator('.bubble__sender'), ['fontSize'])).fontSize, '12px');
      assert.equal(await page.locator('.first-response__mark').count(), 0, 'Stopped run has no stranded avatar');
      await page.evaluate(() => { const {store,bot,rows}=window.fixture; store.setState({live:{[bot.id]:{isRunning:true,startedAt:rows[1].createdAt,activity:{kind:'working'}}}}); });
      await page.getByRole('status', { name: 'Working', exact: true }).waitFor();
      const mark = await page.locator('.first-response__mark').boundingBox();
      close(mark.width,32,'Small pending mark'); close(mark.height,32,'Small pending mark height'); close(mark.x,agentBox.x,'Pending mark aligns with Bot messages');
      await page.evaluate(() => window.fixture.store.setState({live:{}}));
      await page.locator('.first-response__mark').waitFor({state:'detached'});
      // Force real scrolling and measure clearance from the scrollbar track.
      await page.evaluate(() => { const {store,bot,rows}=window.fixture; store.getState().upsertRows(bot.id,1,Array.from({length:20},(_,i)=>({...rows[0],seq:i+10,createdAt:rows[2].createdAt+i*1000,body:{type:'message',role:i%2?'user':'assistant',text:'Long local layout fixture. '.repeat(12)}}))); });
      await page.waitForFunction(() => {const el=document.querySelector('.transcript');return el.scrollHeight>el.clientHeight;});
      const gutter = await page.locator('.transcript').evaluate(el => ({width:el.clientWidth,scroll:el.scrollWidth,style:getComputedStyle(el).scrollbarGutter,clearance:Math.min(...Array.from(el.querySelectorAll('.bubble')).map(b=>el.getBoundingClientRect().right-b.getBoundingClientRect().right))}));
      assert.equal(gutter.style,'stable both-edges'); assert.ok(gutter.clearance >= 8); assert.equal(gutter.scroll,gutter.width);
      await page.evaluate(() => {const {store,bot,rows}=window.fixture;store.setState({transcripts:{[bot.id]:{generation:1,loaded:true,bySeq:Object.fromEntries(rows.map(r=>[r.seq,r]))}}});});
    }
    await shot('chat');
    await page.evaluate(() => { const { voice, store, bot, rows } = window.fixture;
      voice.setState({ status: 'connecting', botId: bot.id, callId: 'local-fixture' });
      store.getState().upsertRows(bot.id, 1, [{...rows[2],seq:4,body:{type:'event',text:'Voice call with Test Bot started'}}]);
    });
    await page.locator('.vcall').waitFor();
    await page.locator('.vcall').evaluate(el=>Promise.all(el.getAnimations().map(animation=>animation.finished)));
    if (phase === 'after') {
      const call = await page.locator('.vcall').boundingBox(), composer = await page.locator('.composer').boundingBox();
      assert.ok(composer.y - call.y - call.height >= 12, 'Call card and composer have a clean gap');
      close(call.x,composer.x,'Call and composer align'); close(call.width,composer.width,'Call and composer widths');
      const end = page.getByRole('button',{name:'End call',exact:true}).first();
      assert.ok(await contrast(end)>=4.5,'End text has accessible contrast');
      assert.ok(await contrast(page.locator('.composer__voice.is-in-call'))>=4.5,'Composer End control has accessible contrast');
      await end.hover(); assert.ok(await contrast(end)>=4.5,'End hover has accessible contrast');
      await end.focus(); assert.equal((await styles(end,['outlineStyle'])).outlineStyle,'solid');
      const keys=['fontSize','lineHeight','letterSpacing','padding','borderRadius','textAlign','alignSelf'];
      assert.deepEqual(await styles(page.locator('.system-event'),keys),await styles(page.locator('.notice'),keys),'Call event matches system pill');
      await page.mouse.move(0,0); await end.evaluate(el=>el.blur());
    }
    await shot('call');
    await page.evaluate(() => window.fixture.voice.setState({ status: 'idle', botId: null }));
    await show('connections');
    const [catalogResponse] = await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname==='/api/apps'),page.getByRole('button', { name: '1 connected' }).click()]);
    await catalogResponse.finished();
    await page.getByRole('heading',{name:'Connected',exact:true}).waitFor();
    await page.locator('.app-row__status').waitFor();
    await page.locator('.apps-modal').evaluate(el=>Promise.all(el.getAnimations().map(animation=>animation.finished)));
    if (phase === 'after') {
      const row = page.locator('.app-row--connected');
      const [name,status,action]=await row.evaluate(el=>['.app-row__name','.app-row__status','button'].map(selector=>el.querySelector(selector).getBoundingClientRect().toJSON()));
      close(center(name),center(status),'Connected badge stays next to name',2);
      assert.ok(status.x >= name.x + name.width && status.x + status.width < action.x, JSON.stringify({name,status,action}));
      close(action.y,name.y,'Disconnect is top aligned',2);
      const details=row.locator('.connected-account-details');
      assert.ok((await details.innerText()).includes('inbox@example.test'));
      assert.ok((await details.innerText()).includes('Connected 20 Nov 2026'));
      const detailsBox=await details.boundingBox();
      assert.ok(detailsBox.y>=name.y+name.height && detailsBox.x+detailsBox.width<=action.x,'Existing account details fit below the title');
      const desc = await row.locator('.app-row__desc').evaluate(el=>({height:el.getBoundingClientRect().height,line:parseFloat(getComputedStyle(el).lineHeight),overflow:getComputedStyle(el).textOverflow,nowrap:getComputedStyle(el).whiteSpace}));
      assert.ok(desc.height<=desc.line+1); assert.equal(desc.overflow,'ellipsis'); assert.equal(desc.nowrap,'nowrap');
      const divider = await row.evaluate(el=>getComputedStyle(el).borderBottomWidth);
      const footer = page.locator('.access-apps__mcp');
      assert.equal(divider,'0px'); assert.equal((await styles(footer,['borderTopWidth'])).borderTopWidth,'1px','Only footer draws the divider');
      for (const button of [row.locator('button'),footer.getByRole('button')]) {
        assert.equal(await button.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
        assert.equal((await styles(button,['whiteSpace'])).whiteSpace,'nowrap');
      }
    }
    await shot('connections');
    const providers = async container => {
      const controls = page.locator(`${container} .auth-button`), boxes = await controls.evaluateAll(els=>els.map(el=>el.getBoundingClientRect().toJSON()));
      assert.equal(boxes.length,4);
      for(const box of boxes) { close(box.width,boxes[0].width,'All provider widths match'); close(box.x,boxes[0].x,'All provider left edges match'); assert.ok(box.height>=48); }
      const links = page.locator(`${container} a.auth-button`), linkBoxes=await links.evaluateAll(els=>els.map(el=>el.getBoundingClientRect().toJSON()));
      for(let i=1;i<linkBoxes.length;i++) close(linkBoxes[i].y-linkBoxes[i-1].y-linkBoxes[i-1].height,12,'Provider gap');
      const primary=await styles(controls.first(),['backgroundColor']);
      for(let i=0;i<3;i++) {assert.notEqual((await styles(links.nth(i),['backgroundColor'])).backgroundColor,primary.backgroundColor);assert.equal((await styles(links.nth(i),['borderTopWidth'])).borderTopWidth,'1px');assert.ok(await contrast(links.nth(i))>=4.5);}
      assert.equal(await controls.evaluateAll(els=>new Set(els.map(el=>getComputedStyle(el).fontSize)).size),1,'Providers share text size');
    };
    await show('signin'); await page.locator('.signin__apple').waitFor();
    if(phase==='after') await providers('.signin');
    await shot('signin');
    await show('connect'); await page.getByRole('tab', { name: 'Codex', exact: true }).waitFor();
    let headingStyle;
    if(phase==='after') {
      const tabs=page.getByRole('tablist'), inactive=page.getByRole('tab',{name:'Codex',exact:true});
      const parent=await page.locator('.subscription-settings').boundingBox(), group=await tabs.boundingBox();
      close(parent.width,group.width,'Provider group spans width');
      close((await inactive.boundingBox()).width,(await page.getByRole('tab',{name:'Claude Code',exact:true}).boundingBox()).width,'Provider choices share width');
      assert.ok(await contrast(inactive)>=4.5,'Inactive tab meets 4.5:1 contrast');
      await inactive.evaluate(el=>{el.disabled=true;});
      assert.ok(await contrast(inactive)>=4.5,'Disabled inactive tab stays readable');
      await inactive.evaluate(el=>{el.disabled=false;});
      await page.getByRole('tab',{name:'Claude Code',exact:true}).focus();
      for(const key of ['ArrowLeft','ArrowRight','Home','End']) {await page.keyboard.press(key);assert.equal(await tabs.locator('[aria-selected="true"]').evaluate(el=>el===document.activeElement),true);assert.equal(await tabs.locator('[tabindex="0"]').count(),1);}
      headingStyle=await styles(page.locator('.subscription-settings h1'),['fontFamily','fontWeight','letterSpacing','lineHeight']);
      assert.equal(headingStyle.fontWeight,'600'); assert.equal(headingStyle.letterSpacing,'normal');
    }
    await shot('connect');
    // #183 replaced subscription reauth with recovery; key reauth retains provider buttons.
    await show('reauth'); await page.locator('.signin__apple').waitFor();
    if(phase==='after') {
      await providers('.subscription-reauth');
      const heading=await styles(page.locator('.subscription-reauth h3'),['fontFamily','fontWeight','letterSpacing','fontSize']);
      for(const key of ['fontFamily','fontWeight','letterSpacing']) assert.equal(heading[key],headingStyle[key],`Heading ${key} stays consistent`);
      assert.equal(heading.fontSize,'17px');
    }
    await shot('reauth');
    if(phase==='after') {
      await page.evaluate(()=>window.showAccounts()); await show('accounts');
      const row=page.getByRole('region',{name:'Your apps',exact:true}).locator('.access-apps-settings__row');
      await row.waitFor();
      const name=await row.locator('.cfg-row__title').boundingBox(),badge=await row.locator('.cfg-chip').boundingBox();
      close(center(name),center(badge),'Settings app badge shares title line',2);
      assert.ok((await row.locator('.connected-account-details').innerText()).includes('inbox@example.test'));
      assert.equal((await styles(row.locator('.access-apps-settings__description'),['whiteSpace'])).whiteSpace,'nowrap');
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${phase}: ${phase === 'after' ? 'items 1 to 12 and screenshots' : 'baseline screenshots'}, ${width}px ${theme}`);
    await context.close();
  }
} finally {
  await browser?.close();
  for (const child of children.reverse()) child.kill();
  await Promise.all(children.map(child => new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve))));
  await rm(temp, { recursive: true, force: true });
}
