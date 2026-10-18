import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium} from '../.tmp/browser-tools/node_modules/playwright-core/index.mjs';
const base='http://127.0.0.1:4321';const out='output/drafts/vid_course_RPM-2026-001/preparation';
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
try {
 await page.goto(base+'/course-production.html');await page.waitForFunction(()=>document.querySelectorAll('#items section').length===15);
 assert.match(await page.locator('#environment').innerText(),/pausada/);
 const state=await (await page.request.get(base+'/api/course-production')).json();
 assert.equal(state.productionEnabled,false);const first=state.entries.find(e=>e.id==='RPM-2026-001');
 assert.equal(first.status,'review_ready');assert.ok(first.videoUrl);assert.ok(state.entries.filter(e=>e.id!=='RPM-2026-001').every(e=>e.status==='pending'&&!e.videoUrl));
 assert.equal(await page.getByRole('link',{name:'Ver video',exact:true}).count(),1);
 await page.screenshot({path:out+'/courses-ready.png',fullPage:true});
 await page.locator('#items section').filter({hasText:'RPM-2026-001'}).getByRole('link',{name:'Editar proyecto',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#titulo').value.length>0);
 const id=first.projectId;const original=await (await page.request.get(base+'/api/project-editor/projects/'+id)).json();
 assert.equal(original.derivado.escenas.length,6);assert.ok(original.derivado.escenas.every(s=>s.tieneNarracion&&!s.faltaRecurso&&s.recurso.kind==='video'));
 await page.reload();await page.waitForFunction(()=>document.querySelector('#titulo').value.length>0);
 const reopened=await (await page.request.get(base+'/api/project-editor/projects/'+id)).json();assert.deepEqual(reopened.derivado.escenas,original.derivado.escenas);for(const key of ['captions','voice','outputs','editor'])assert.deepEqual(reopened.proyecto[key],original.proyecto[key]);
 await page.screenshot({path:out+'/editor-prepared.png',fullPage:true});
 await page.evaluate(url=>{const v=document.createElement('video');v.id='qa-playback';v.src=url;v.controls=true;v.preload='auto';v.style='position:fixed;inset:0;width:100%;height:100%;background:white;z-index:10000';document.body.append(v);},base+first.videoUrl);
 await page.waitForFunction(()=>document.querySelector('#qa-playback').readyState>=2);
 const playback=await page.evaluate(async()=>{
  const v=document.querySelector('#qa-playback');v.muted=false;v.volume=1;
  const ctx=new AudioContext();const a=ctx.createAnalyser();ctx.createMediaElementSource(v).connect(a);a.connect(ctx.destination);await ctx.resume();
  let peak=0;const samples=new Float32Array(a.fftSize);
  await v.play();for(let i=0;i<40;i++){a.getFloatTimeDomainData(samples);for(const x of samples)peak=Math.max(peak,Math.abs(x));await new Promise(r=>setTimeout(r,50));}
  v.pause();v.currentTime=43;await new Promise(r=>v.addEventListener('seeked',r,{once:true}));
  return {width:v.videoWidth,height:v.videoHeight,duration:v.duration,peak,decodedFrames:v.getVideoPlaybackQuality().totalVideoFrames};
 });
 assert.equal(playback.width,1920);assert.equal(playback.height,1080);assert.ok(playback.peak>.01);
 await page.screenshot({path:out+'/mp4-with-captions.png'});
 await page.evaluate(async()=>{const v=document.querySelector('#qa-playback');v.currentTime=0;v.playbackRate=8;await v.play();});
 await page.waitForFunction(()=>document.querySelector('#qa-playback').ended,{},{timeout:60000});
 assert.deepEqual(errors,[]);
 const report={editUrl:base+first.editUrl,videoUrl:base+first.videoUrl,playback,ended:true,errors,persisted:true};
 fs.writeFileSync(out+'/browser-verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} finally {await browser.close();}
