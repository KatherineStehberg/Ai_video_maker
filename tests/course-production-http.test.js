import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

test('real server exposes the prepared queue and dashboard without starting production in tests',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'avm-courses-http-'));
 process.env.AIVM_COURSE_QUEUE_DIR=dir;
 const {createServer}=await import('../src/server.js');
 const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}`;
 const response=await fetch(base+'/api/course-production');assert.equal(response.status,200);
 const state=await response.json();assert.equal(state.entries.length,15);assert.ok(state.entries.every(e=>e.status==='pending'));
 const dashboard=await fetch(base+'/course-production.html');assert.equal(dashboard.status,200);assert.match(await dashboard.text(),/Revisar edición/);
 const post=await fetch(base+'/api/course-production',{method:'POST'});assert.equal(post.status,405);
 const wrongHost=await new Promise((resolve,reject)=>{
   http.get(base+'/api/course-production',{headers:{Host:'example.com'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject);
 });assert.equal(wrongHost,403);
});
