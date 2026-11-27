import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { clientFixture } from './client-fixture.mjs';
const output = path.resolve('.context/ui-custom/production');fs.mkdirSync(output,{recursive:true});
const built=spawnSync('npm',['run','build','-w','web'],{encoding:'utf8'});fs.writeFileSync(path.join(output,'build.log'),built.stdout+built.stderr);assert.equal(built.status,0,built.stderr);
const server=await clientFixture({production:true}),browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
try {
  const response=await fetch(server.base),html=await response.text(),src=html.match(/<script src="([^\"]*ui-boot\.js[^\"]*)"><\/script>/)?.[1];assert.ok(src);
  assert.equal(new URL(src,server.base).origin,server.base);assert.match(response.headers.get('cache-control'),/no-cache/);assert.match(response.headers.get('content-security-policy'),/script-src 'self'/);
  const bootResponse=await fetch(new URL(src,server.base)),boot=await bootResponse.text();assert.equal(bootResponse.status,200);assert.match(bootResponse.headers.get('content-type'),/javascript/);assert.equal(boot,fs.readFileSync('web/public/ui-boot.js','utf8'));
  const hash=createHash('sha256').update(boot).digest('hex').slice(0,16);assert.equal(new URL(src,server.base).searchParams.get('v'),hash);assert.ok(Buffer.byteLength(boot)<2048);
  const page=await browser.newPage({viewport:{width:390,height:844},colorScheme:'light'});await page.context().addCookies([{name:'swarm_session',value:'layout-test-token',url:server.base}]);const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(`${server.base}/#bots`);await page.locator('.pb-bots').waitFor();
  await page.screenshot({path:path.join(output,'built-bots-390.png')});assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({passed:3,src,bytes:Buffer.byteLength(boot),htmlCache:response.headers.get('cache-control'),bootCache:bootResponse.headers.get('cache-control'),csp:response.headers.get('content-security-policy')},null,2));
  console.log('PASS production CSP allows same-origin blocking boot');console.log('PASS no-cache HTML references content-versioned boot bytes');console.log('PASS built client renders without runtime errors');console.log('Production boot: 3/3 passed');
}finally{await browser.close();await server.close();}
