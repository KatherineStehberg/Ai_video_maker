import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createServer } from '../src/server.js';
import { ffmpegRun } from '../src/lib/ffmpeg.js';
import { probe, analyzeLocal, onsetDetector, combine, cutsCsv } from '../src/analysis/local.js';
import { requestBody, parseResponse, interpret } from '../src/analysis/gemini.js';

const dir=path.resolve('.tmp/analysis-test');
const hash=async file=>{const h=createHash('sha256');for await(const b of createReadStream(file))h.update(b);return h.digest('hex');};
test('onsets across arbitrary PCM chunks; silence has no events',()=>{
  const silence=onsetDetector();silence.push(Buffer.alloc(32000));assert.equal(silence.events.length,0);
  const d=onsetDetector(), pcm=Buffer.alloc(32000);for(let i=8000;i<8160;i++)pcm.writeInt16LE(16000,i*2);
  for(let i=0;i<pcm.length;i+=137)d.push(pcm.subarray(i,i+137));
  assert.equal(d.events.length,1);assert.equal(d.events[0].timestamp,.5);
});
test('alignment preserves precise local evidence and keeps uncertain model times',()=>{
  const c=combine({scenes:[{timestamp:2,kind:'scene'}],onsets:[]},[{timestamp:2.1,reason:'Cambio',evidence:'visual'},{timestamp:4,reason:'Frase',evidence:'audio'}]);
  assert.equal(c[1].timestamp,2);assert.equal(c[1].modelTimestamp,2.1);assert.equal(c[2].timestamp,4);assert.equal(c[2].evidence.local,null);
  assert.match(cutsCsv([{timestamp:1,reason:'=malicious,"x"',evidence:{},source:'local'}]),/'=malicious,""x""/);
});
test('Gemini request/validation — mock contract, no live API',async()=>{
  const b=requestBody('AAAA',5,60);assert.equal(b.contents[0].parts[0].videoMetadata.fps,5);assert.equal(b.generationConfig.responseMimeType,'application/json');
  const response=timestamp=>({modelVersion:'mock-model',usageMetadata:{totalTokenCount:42},candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({summary:'MOCK: música y escena',cuts:[{timestamp,reason:'MOCK corte',evidence:'MOCK evidencia'}]})}]}}]});
  assert.throws(()=>parseResponse(response(60),60),/inválido/);assert.throws(()=>parseResponse({candidates:[{finishReason:'MAX_TOKENS'}]},60),/truncada/);
  await fs.mkdir(dir,{recursive:true});let calls=0;
  const result=await interpret('unused',dir,{duration:61,videoStream:0,audio:[]},()=>{},{config:{key:'mock-secret',model:'mock-model',fps:1,segmentSeconds:60},transcode:async args=>fs.writeFile(args.at(-1),'mock-video'),fetchImpl:async(url,init)=>{assert.match(url,/mock-model:generateContent$/);assert.equal(init.headers['x-goog-api-key'],'mock-secret');assert.equal(JSON.parse(init.body).contents[0].parts[0].videoMetadata.fps,1);calls++;return {ok:true,json:async()=>response(.5)};}});
  assert.equal(calls,2);assert.equal(result.suggestions[1].timestamp,60.5);assert.equal(result.segments[1].usage.totalTokenCount,42);assert.ok(!JSON.stringify(result).includes('mock-secret'));
  await assert.rejects(interpret('',dir,{},()=>{},{config:{key:''}}),/Sin GEMINI/);
});
test('HTTP end-to-end: synthetic 30 FPS video, precision, exports, preview and original integrity', {timeout:120000},async()=>{
  process.env.GEMINI_API_KEY='';
  await fs.mkdir(dir,{recursive:true});const fixture=path.join(dir,'synthetic.mp4');
  await ffmpegRun(['-f','lavfi','-i','color=c=red:s=320x180:r=30:d=2','-f','lavfi','-i','color=c=blue:s=320x180:r=30:d=2','-f','lavfi','-i',"aevalsrc=if(lt(mod(t+0.5\\,1)\\,0.03)\\,0.8*sin(2*PI*1000*t)\\,0):s=16000:d=4",'-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0[v]','-map','[v]','-map','2:a','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac',fixture]);
  const before=await hash(fixture);const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const health=await (await fetch(base+'/api/health')).json();assert.equal(health.ok,true);
    assert.equal((await fetch(base+'/api/templates')).status,200);
    assert.equal((await fetch(base+'/analysis.html')).status,200);
    const config=await(await fetch(base+'/api/analysis/config')).json();assert.equal(config.hasKey,false);assert.ok(!('key' in config));
    const upload=async(query='',headers={})=>fetch(base+'/api/analysis'+query,{method:'POST',headers:{'x-analysis-upload':'1',...headers},body:createReadStream(fixture),duplex:'half'});
    assert.equal((await upload('?gemini=true')).status,400);
    assert.equal((await upload('?gemini=true',{'x-gemini-consent':'yes'})).status,409);
    assert.equal((await upload('',{origin:'https://evil.example'})).status,403);
    const r=await upload();assert.equal(r.status,202);const {id}=await r.json();let j;
    for(let i=0;i<300;i++){j=await(await fetch(base+`/api/analysis/${id}`)).json();if(j.status!=='running')break;await new Promise(r=>setTimeout(r,100));}
    assert.equal(j.status,'complete',JSON.stringify(j));assert.equal(j.metadata.fps,30);assert.equal(j.metadata.width,320);assert.equal(j.metadata.audio.length,1);
    assert.equal(j.local.scenes.length,1);const sceneError=Math.abs(j.local.scenes[0].timestamp-2);assert.ok(sceneError<=1/30);
    const errors=[.5,1.5,2.5,3.5].map(t=>Math.min(...j.local.onsets.map(e=>Math.abs(e.timestamp-t))));assert.ok(errors.every(e=>e<=.03),JSON.stringify(j.local.onsets));
    assert.equal(j.gemini.status,'disabled');assert.equal(await hash(fixture),before);assert.equal(await hash(path.resolve('data/analyses',id,'original')),before);
    const preview=await fetch(base+`/api/analysis/${id}/preview`,{headers:{range:'bytes=0-99'}});assert.equal(preview.status,206);assert.equal((await preview.arrayBuffer()).byteLength,100);
    assert.equal((await fetch(base+`/api/analysis/${id}/preview`,{headers:{range:'nonsense'}})).status,416);
    const json=await(await fetch(base+`/api/analysis/${id}/export`)).json();assert.equal(json.cuts.length,j.cuts.length);
    const csv=await(await fetch(base+`/api/analysis/${id}/export?format=csv`)).text();assert.match(csv,/timestamp_seconds/);assert.ok(csv.includes('Cambio visual'));
    const previewMeta=await probe(path.resolve('data/analyses',id,'preview.mp4'));assert.ok(Math.abs(previewMeta.duration-4)<.1);
    await fs.writeFile(path.join(dir,'e2e-result.json'),JSON.stringify({id,sourceSHA256:before,sceneErrorSeconds:sceneError,onsetErrorsSeconds:errors,cutCount:j.cuts.length,gemini:'NOT CALLED',browser:'not tested here'},null,2));
    const bad=await fetch(base+'/api/analysis',{method:'POST',headers:{'x-analysis-upload':'1'},body:'not a video'});const bj=await bad.json();let state;
    for(let i=0;i<50;i++){state=await(await fetch(base+`/api/analysis/${bj.id}`)).json();if(state.status!=='running')break;await new Promise(r=>setTimeout(r,100));}assert.equal(state.status,'error');
  }finally{await new Promise(r=>server.close(r));}
});

test('61 second silent video: real segmentation and transcode, mocked Gemini transport', {timeout:120000},async()=>{
  await fs.mkdir(dir,{recursive:true});const file=path.join(dir,'long-silent.mp4');
  await ffmpegRun(['-f','lavfi','-i','color=c=black:s=160x90:r=30:d=61','-an','-c:v','libx264','-threads','1',file]);
  const metadata=await probe(file);const local=await analyzeLocal(file,metadata);assert.equal(local.onsets.length,0);assert.equal(local.scenes.length,0);assert.equal(metadata.audio.length,0);
  let count=0;const records=[];
  const output=await interpret(file,dir,metadata,()=>{},{config:{key:'MOCK',model:'mock-model',fps:1,segmentSeconds:60},onSegment:r=>records.push({...r}),fetchImpl:async(url,init)=>{
    const body=JSON.parse(init.body);const data=Buffer.from(body.contents[0].parts[0].inlineData.data,'base64');assert.ok(data.length>1000);assert.ok(data.length<8*1024*1024);
    const segment=await probe(path.join(dir,'gemini-segment.mp4'));assert.ok(Math.abs(segment.duration-(count===0?60:1))<.1);count++;
    return {ok:true,json:async()=>({candidates:[{finishReason:'STOP',content:{parts:[{text:'{"summary":"MOCK silent","cuts":[]}'}]}}],usageMetadata:{totalTokenCount:1}})};
  }});
  assert.equal(count,2);assert.equal(output.segments.length,2);assert.equal(output.segments[1].start,60);assert.ok(records.some(r=>r.status==='requesting'));
  await assert.rejects(fs.stat(path.join(dir,'gemini-segment.mp4')),/ENOENT/);
  const failed=[];
  await assert.rejects(interpret(file,dir,{...metadata,duration:1},()=>{},{config:{key:'MOCK',model:'mock',fps:1,segmentSeconds:60},onSegment:r=>failed.push({...r}),transcode:async args=>fs.writeFile(args.at(-1),'MOCK'),fetchImpl:async()=>({ok:false,status:429})}),/HTTP 429/);
  assert.equal(failed.at(-1).status,'error');assert.equal(failed.at(-1).usage,null);
});
