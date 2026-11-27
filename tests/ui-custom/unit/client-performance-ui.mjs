import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright';
import {clientFixture,signedInPage,patch} from './client-fixture.mjs';
const output=path.resolve('.context/ui-custom/client-performance');fs.mkdirSync(output,{recursive:true});
const server=await clientFixture(),browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
try {
  const {page}=await signedInPage(browser,server);
  const report=await page.evaluate(async()=>{
    const {applyAppearance}=await import('/src/customization/applier.ts');const {useCustomization}=await import('/src/customization/store.ts');const {useConfigUI}=await import('/src/configStore.ts');
    const doc=structuredClone(useCustomization.getState().saved);doc.theme.colors.light.primary='#0F766E';doc.theme.font.ui='serif';doc.theme.font.scale='xlarge';doc.theme.density='comfortable';doc.theme.radius='round';
    const timings=[];for(let i=0;i<50;i++){const start=performance.now();applyAppearance(doc);timings.push(performance.now()-start);}timings.sort((a,b)=>a-b);
    window.__tokenShellUpdates=0;window.__stopTokenShellUpdates=useConfigUI.subscribe(()=>window.__tokenShellUpdates++);
    return {p95:timings[Math.floor(timings.length*.95)],variables:document.documentElement.style.length,configBytes:new TextEncoder().encode(JSON.stringify(doc)).length};
  });
  await patch(page,[{op:'add',path:'/theme/colors/light/primary',value:'#0F766E'}]);
  const updates=await page.evaluate(()=>{window.__stopTokenShellUpdates();return window.__tokenShellUpdates;});
  assert.equal(updates,0,'color-only change does not notify the shell config store');assert.ok(report.p95<4,`Apply p95 ${report.p95}ms`);assert.ok(report.configBytes<4096);
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({...report,shellUpdates:updates,passed:3},null,2));
  console.log(`PASS token application p95 ${report.p95.toFixed(2)}ms`);console.log(`PASS typical config ${report.configBytes} bytes`);console.log('PASS color patches do not rerender the shell through configStore');console.log('Client performance: 3/3 passed');
}finally{await browser.close();await server.close();}
