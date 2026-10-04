import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCourseQueue, sha256, validatePack } from '../src/course-production/queue.js';

function setup(t, options={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'avm-course-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const script='A complete prepared narration.';
  const item=id=>({id,title:id,language:'en',script,scriptSha256:sha256(script),sources:['https://gamma.app/docs/test'],scenes:[{text:script}],course:{courseId:'56397'}});
  const pack={version:'1.0.0',items:[item('RPM-001'),item('RPM-002')]};
  const jobs=new Map();const submitted=[];let serial=0;let resumes=0;
  const backend={
    preflight:async()=>({ok:true,voice:{provider:'sapi',name:'English'}}),
    submit:async i=>{submitted.push(i.id);const j={id:String(++serial),status:'generating',projectId:'project-'+serial,provider:{id:'pipeline'},generation:{file:'output/test.mp4'}};jobs.set(j.id,j);return j;},
    getJob:async id=>jobs.get(id),findJob:async()=>null,
    verify:async()=>({ok:true}),isBusy:e=>e.message==='busy',
    resumeJob:async id=>{resumes++;jobs.get(id).status='generating';},...options};
  const stateFile=path.join(dir,'state.json');
  const queue=createCourseQueue({pack,stateFile,backend});
  return {pack,backend,stateFile,queue,jobs,submitted,get resumes(){return resumes;}};
}

test('renders sequentially and survives restart without duplicate jobs',async t=>{
 const s=setup(t);await s.queue.tick();await s.queue.tick();assert.deepEqual(s.submitted,['RPM-001']);
 s.jobs.get('1').status='completed';await s.queue.tick();assert.deepEqual(s.submitted,['RPM-001','RPM-002']);
 assert.equal(s.queue.snapshot().entries[0].status,'review_ready');
 const restored=createCourseQueue(s);await restored.tick();assert.equal(s.submitted.length,2);
 assert.ok(restored.snapshot().entries.every(x=>x.publicationBlocked));
});
test('missing English voice blocks submission but recovers when available',async t=>{
 const s=setup(t,{preflight:async()=>({ok:false,reasons:['No English voice']})});
 await s.queue.tick();assert.equal(s.submitted.length,0);s.backend.preflight=async()=>({ok:true,voice:{name:'English'}});
 await s.queue.tick();assert.equal(s.submitted.length,1);
});
test('invalid technical result is blocked instead of offered for review',async t=>{
 const s=setup(t,{verify:async()=>({ok:false,reason:'Missing narration'})});await s.queue.tick();s.jobs.get('1').status='completed';await s.queue.tick();
 const e=s.queue.snapshot().entries[0];assert.equal(e.status,'blocked');assert.equal(e.reviewUrl,null);
});
test('interrupted submission is recovered by source identity',async t=>{
 const s=setup(t);const saved=JSON.parse(fs.readFileSync(s.stateFile));saved.entries['RPM-001'].status='submitting';fs.writeFileSync(s.stateFile,JSON.stringify(saved));
 s.jobs.set('existing',{id:'existing',status:'generating'});s.backend.findJob=async()=>({id:'existing'});
 const q=createCourseQueue(s);await q.tick();assert.equal(q.snapshot().entries[0].jobId,'existing');assert.equal(s.submitted.length,0);
});
test('unknown submission and changed script never silently re-submit',async t=>{
 const s=setup(t);const saved=JSON.parse(fs.readFileSync(s.stateFile));saved.entries['RPM-001'].status='submitting';saved.entries['RPM-002'].scriptSha256='old';fs.writeFileSync(s.stateFile,JSON.stringify(saved));
 const q=createCourseQueue(s);await q.tick();assert.equal(s.submitted.length,0);assert.ok(q.snapshot().entries.every(x=>x.status==='blocked'));
});
test('two bounded retries resume existing local project, then block failure',async t=>{
 const s=setup(t);await s.queue.tick();for(let i=0;i<3;i++){s.jobs.get('1').status='failed';await s.queue.tick();}
 assert.equal(s.resumes,2);assert.equal(s.queue.snapshot().entries[0].status,'blocked');assert.equal(s.submitted.filter(x=>x==='RPM-001').length,1);
});
test('concurrent ticks cannot submit twice',async t=>{
 const s=setup(t);await Promise.all([s.queue.tick(),s.queue.tick(),s.queue.tick()]);assert.equal(s.submitted.length,1);
});
test('corrupt state and narration tampering fail closed',t=>{
 const s=setup(t);fs.writeFileSync(s.stateFile,'not JSON');assert.throws(()=>createCourseQueue(s));
 s.pack.items[0].scenes[0].text='different';assert.throws(()=>validatePack(s.pack),/Narración incompleta/);
});
