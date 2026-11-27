// Integration handoff: fixed-size composer code and alignment assertions belong to UC-E/UC-H.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { clientFixture,signedInPage,patch } from './client-fixture.mjs';
import { inspectAlignment } from '../../layout-alignment-ui.mjs';
const output=path.resolve('.context/ui-custom/scale-matrix');fs.mkdirSync(output,{recursive:true});
const server=await clientFixture(),browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});const report=[];
try{
  const {page}=await signedInPage(browser,server);
  for(const width of [390,1280])for(const scale of ['default','xlarge'])for(const density of ['compact','default','comfortable']){
    await page.setViewportSize({width,height:900});await patch(page,[{op:'replace',path:'/theme/font/scale',value:scale},{op:'replace',path:'/theme/density',value:density}]);
    await page.goto(`${server.base}/#bot/${server.fixture.bot.id}`);await page.locator('.composer__input:not([disabled])').waitFor();await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(400);
    const lines=await page.evaluate(()=>{const input=document.querySelector('.composer__input:not([disabled])'),root=getComputedStyle(document.documentElement);return {actual:parseFloat(getComputedStyle(input).lineHeight),expected:24*Number(root.getPropertyValue('--font-scale'))};});
    const issues=[];if(lines.actual!==lines.expected)issues.push(`Composer line height ${lines.actual}px, expected ${lines.expected}px`);
    const input=page.locator('.composer__input:not([disabled])');await input.fill('First line\nSecond line');await page.waitForTimeout(60);const height=await input.evaluate(el=>el.getBoundingClientRect().height);if(Math.abs(height-lines.expected*2)>1)issues.push(`Composer two-line height ${height}px, expected ${lines.expected*2}px`);
    await page.goto(`${server.base}/#bots`);await page.locator('.pb-bot-card').first().waitFor();await page.waitForTimeout(200);issues.push(...await page.evaluate(inspectAlignment,{}));
    report.push({width,scale,density,issues});console.log(`${issues.length?'FAIL':'PASS'} scale matrix ${width} ${scale} ${density}: ${issues.join('; ')||'0 issues'}`);
  }
}finally{await browser.close();await server.close();fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));}
const passed=report.filter(result=>!result.issues.length).length;console.log(`Scale matrix: ${passed}/${report.length} passed`);if(passed!==report.length)process.exitCode=1;
