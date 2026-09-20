import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { makeProject, makeScene, loadProject } from '../src/core/project.js';
import { createStudio, updateStudio, startOperation, studioProject, importTarget, exportManifest } from '../src/studio/service.js';
import { probe } from '../src/analysis/local.js';
import { abs, workDir } from '../src/lib/paths.js';
import { CONFIG } from '../src/config.js';

async function done(id){for(let i=0;i<600;i++){const p=studioProject(id);if(p.studio.job.status!=='running'){assert.equal(p.studio.job.status,'complete',JSON.stringify(p.studio.job));return p;}await new Promise(r=>setTimeout(r,100));}throw Error('Timeout');}
test('persistence retains cache, provenance, references and subtitles',()=>{
  const s=makeScene({text:'Fixture técnico',narrationText:'Fixture técnico',narrationKey:'abc',durationLocked:true,provenance:{kind:'capture',authorized:true,originalReference:'https://drive.google.com/file/test'}});
  const p=makeProject({scenes:[s],captions:{file:'output/example.srt'},studio:{references:['reference-only']}});
  assert.equal(p.scenes[0].narrationKey,'abc');assert.equal(p.scenes[0].provenance.kind,'capture');assert.equal(p.captions.file,'output/example.srt');assert.deepEqual(p.studio.references,['reference-only']);
  assert.throws(()=>importTarget('x.png','capture','https://drive.google.com/test',false),/autorización/);
});
test('studio script-to-MP4, scene regeneration, render cache and approval safeguards', {timeout:180000},async()=>{
  CONFIG.render.threads=1;
  let p=createStudio({title:'TEST técnico de estudio',script:'## Prueba técnica uno.\n## Prueba técnica dos.',brand:'personal',aspectRatio:'1:1'});
  assert.throws(()=>startOperation(p.id,'render'),/Aprueba/);
  p=updateStudio(p.id,{revision:p.studio.revision,scenes:p.scenes.map(s=>({...s,duration:.6,onScreenTitle:'TEST técnico'})),style:'minimal',approveScript:true,references:[{kind:'drive',originalReference:'https://drive.google.com/file/d/reference-only'}]});
  assert.equal(p.studio.references[0].access,'reference-only');
  assert.throws(()=>updateStudio(p.id,{revision:0}),/cambió/);
  assert.throws(()=>updateStudio(p.id,{revision:p.studio.revision,voice:{provider:'paid-provider'}}),/locales/);
  startOperation(p.id,'render');p=await done(p.id);
  const media=await probe(abs(p.outputPath));assert.equal(media.width,1080);assert.equal(media.height,1080);assert.ok(media.duration>=1.1);assert.equal(media.audio.length,0);
  assert.ok(p.studio.export.files.some(f=>f.format==='srt'));assert.ok(p.studio.export.files.some(f=>f.format==='1:1'));
  const clipsDir=path.join(workDir(p.id),'clips_1x1');const clips=(await fs.readdir(clipsDir)).filter(f=>/^\d.*\.mp4$/.test(f)).sort();assert.equal(clips.length,2);
  const stamps=await Promise.all(clips.map(f=>fs.stat(path.join(clipsDir,f)).then(s=>s.mtimeMs)));
  const secondText=p.scenes[1].text;
  p=updateStudio(p.id,{revision:p.studio.revision,scenes:p.scenes.map((s,i)=>({...s,onScreenTitle:i===0?'Título ajustado':s.onScreenTitle})),style:'minimal',approveScript:true});
  startOperation(p.id,'scene',p.scenes[0].id);p=await done(p.id);assert.equal(p.scenes[1].text,secondText);assert.ok(p.studio.scenePreview);
  assert.equal((await fs.stat(path.join(clipsDir,clips[1]))).mtimeMs,stamps[1]);
  startOperation(p.id,'render');p=await done(p.id);
  assert.ok((await fs.stat(path.join(clipsDir,clips[0]))).mtimeMs>stamps[0]);assert.equal((await fs.stat(path.join(clipsDir,clips[1]))).mtimeMs,stamps[1]);
  const manifest=exportManifest(p.id);assert.equal(manifest.contractVersion,'ksl.video.v1');assert.equal(manifest.resultRevision,manifest.revision);
  p=updateStudio(p.id,{revision:p.studio.revision,scenes:p.scenes.map((s,i)=>({...s,text:i===0?'Texto nuevo sin aprobar':s.text}))});assert.equal(p.studio.approvedScriptHash,null);assert.throws(()=>startOperation(p.id,'render'),/Aprueba/);
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  try{assert.match(await(await fetch(base)).text(),/Estudio personal/);assert.equal((await fetch(base+'/api/studio/projects',{method:'POST',body:'{}'})).status,403);
    const result=await(await fetch(base+`/api/studio/projects/${p.id}/manifest`)).json();assert.equal(result.projectId,p.id);
  }finally{await new Promise(r=>server.close(r));}
  await fs.mkdir('.tmp/studio-test',{recursive:true});await fs.writeFile('.tmp/studio-test/result.json',JSON.stringify({projectId:p.id,mp4:manifest.results.files.find(f=>f.format==='1:1').file,width:media.width,height:media.height,seconds:media.duration,cacheSecondScenePreserved:true,sceneRegeneration:true,narration:'explicitly disabled technical fixture',approvedDemo:false},null,2));
});
