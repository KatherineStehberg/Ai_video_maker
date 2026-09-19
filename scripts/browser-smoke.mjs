// Optional real-browser smoke test. Install playwright-core in .tmp/browser-tools.
import { chromium } from '../.tmp/browser-tools/node_modules/playwright-core/index.mjs';
import { createServer } from '../src/server.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
process.env.GEMINI_API_KEY=''; // Never make a paid API call from this smoke test.
const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;
try{
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/analysis.html`);
  await page.waitForFunction(()=>document.querySelector('#config').textContent.includes('Sin clave'));
  assert.equal(await page.locator('#gemini').isDisabled(),true);
  await page.locator('#file').setInputFiles(path.resolve('.tmp/analysis-test/synthetic.mp4'));
  await page.locator('#submit').click();await page.locator('#result').waitFor({state:'visible',timeout:60000});
  assert.equal(await page.locator('#cuts tr').count(),5);
  // Ritmo y frames renderizados en la página, no sólo en el JSON.
  assert.match(await page.locator('#metadata').textContent(),/CFR/);
  const tempoText=await page.locator('#tempo').textContent();assert.match(tempoText,/Tempo inferido 6\d\.\d\d BPM/);
  assert.match(await page.locator('#sync').textContent(),/datos-insuficientes|Sincronía no descrita/);
  assert.equal(await page.locator('#cuts tr').first().locator('td').count(),6);
  // Filas ordenadas por tiempo: onset 0.5 s -> frame 15; corte visual 2.0 s -> frame 60 (30 FPS CFR).
  assert.equal(await page.locator('#cuts tr').first().locator('td').nth(1).textContent(),'15');
  assert.equal(await page.locator('#cuts tr').filter({hasText:'Cambio visual'}).locator('td').nth(1).textContent(),'60');
  await page.waitForFunction(()=>document.querySelector('video').readyState>=2);
  await page.locator('#cuts button').filter({hasText:'2.000'}).click();
  await page.waitForFunction(()=>Math.abs(document.querySelector('video').currentTime-2)<.02);
  await page.locator('video').evaluate(v=>v.play());await page.waitForFunction(()=>document.querySelector('video').currentTime>2.1);await page.locator('video').evaluate(v=>v.pause());
  for(const format of ['json','csv']){const download=page.waitForEvent('download');await page.locator('#'+format).click();const d=await download;await d.saveAs(path.resolve('.tmp/analysis-test/browser-export.'+format));}
  await page.screenshot({path:'.tmp/analysis-test/browser.png',fullPage:true});
  // UI consent contract with a mocked config/upload; no external requests.
  await page.route('**/api/analysis/config',route=>route.fulfill({json:{hasKey:true,model:'MOCK',requestedFps:1,segmentSeconds:60}}));
  let submissions=0;
  await page.route('**/api/analysis?gemini=true',route=>{submissions++;assert.equal(route.request().headers()['x-gemini-consent'],'yes');return route.fulfill({status:400,json:{error:'MOCK: consent verified, no upload'}});});
  await page.reload();await page.locator('#gemini').check();
  assert.equal(await page.locator('#disclosure').isVisible(),true);
  await page.locator('#file').setInputFiles(path.resolve('.tmp/analysis-test/synthetic.mp4'));
  await page.locator('#submit').click();assert.match(await page.locator('#status').textContent(),/Confirma/);assert.equal(submissions,0);
  await page.locator('#consent').check();await page.locator('#submit').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('MOCK: consent verified'));assert.equal(submissions,1);
  assert.deepEqual(errors,[]);
  const result={browser:await browser.version(),upload:true,previewDecode:true,seek:true,playback:true,rows:5,exports:['json','csv'],tempo:tempoText.trim(),frameColumn:'60',pageErrors:errors,consentUI:'verified with mock config and upload',gemini:'not called'};
  await fs.writeFile('.tmp/analysis-test/browser-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
