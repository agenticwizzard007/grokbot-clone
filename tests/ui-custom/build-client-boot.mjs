// Regenerate the small classic pre-paint script and its content-addressed URL.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { transform } from 'esbuild';
import { tsImport } from 'tsx/esm/api';
const { TOKENS } = await tsImport('../../server/src/ui-config/registry-tokens.ts', import.meta.url);
const { FONTS } = await tsImport('../../server/src/ui-config/registry-fonts.ts', import.meta.url);
const names = TOKENS.flatMap(token => token.cssVars).map(name => name.slice(8)).join('|');
const source = `(()=>{try {
 const root=document.documentElement, store=localStorage;
 let mode=store.getItem('swarm.theme');
 const safe=new URLSearchParams(location.search).get('ui')==='safe'||sessionStorage.getItem('swarm.ui.safe');
 const cache=JSON.parse(store.getItem('swarm.ui.v1')||'null');
 if(!safe&&cache&&cache.userId===store.getItem('swarm.ui.user')&&cache.doc.version===1){
  mode=cache.doc.theme.mode;
  const dark=mode==='dark'||mode==='system'&&matchMedia('(prefers-color-scheme: dark)').matches;
  const phone=matchMedia('(max-width: 760px)').matches;
  const values=cache.boot[phone?(dark?'phoneDark':'phoneLight'):(dark?'dark':'light')];
  const fonts=${JSON.stringify(FONTS.map(font => font.stack))};
  for(const [key,value] of Object.entries(values)){
   const color=/^--color-(${names})$/.test(key)&&/^#[0-9a-f]{6}$/i.test(value)&&!matchMedia('(forced-colors: active)').matches;
   const font=(key==='--font-stack'||key==='--font-heading')&&(fonts.includes(value)||key==='--font-heading'&&value==='var(--font-stack)');
   const size=key==='--font-scale'&&['1','1.125','1.25'].includes(value);
   if(color||font||size)root.style.setProperty(key,value);
  }
 }
 if(safe)mode='system';
 mode=mode==='dark'||mode!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';
 root.dataset.theme=mode;root.style.colorScheme=mode;
}catch{}})();`;
const { code } = await transform(source, { minify: true, target: 'es2022' });
fs.writeFileSync('web/public/ui-boot.js', code);
const hash = createHash('sha256').update(code).digest('hex').slice(0,16);
const html = fs.readFileSync('web/index.html','utf8').replace(/\s*<script src="\/ui-boot\.js[^\"]*"><\/script>/, '').replace('    <title>', `    <script src="/ui-boot.js?v=${hash}"></script>\n    <title>`);
fs.writeFileSync('web/index.html',html);
console.log(`Boot script: ${Buffer.byteLength(code)} bytes, URL /ui-boot.js?v=${hash}`);
