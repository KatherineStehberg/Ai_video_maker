import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../src/lib/paths.js';
import { loadPack, courseSpec, preflight } from '../src/course-production/index.js';
import { validatePack } from '../src/course-production/queue.js';
const pack=validatePack(loadPack());
const voice={provider:'sapi',name:'validation-only'};
for(const item of pack.items)courseSpec(item,voice);
const environment=await preflight();
const stateFile = path.join(process.env.AIVM_COURSE_QUEUE_DIR || path.join(PATHS.data,'course-production'),'state.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile,'utf8')) : {entries:{}};
const entries = pack.items.map(item => ({id:item.id,status:'pending',...state.entries[item.id]}));
const ready = entries.filter(e => {
  if (e.status !== 'review_ready' || !e.proof?.fullyDecoded || !e.videoUrl) return false;
  const file = new URL(e.videoUrl, 'http://127.0.0.1').searchParams.get('path');
  return file && fs.existsSync(file) && fs.statSync(file).size === e.proof.bytes;
});
console.log(JSON.stringify({scriptsValidated:pack.items.length,scenes:pack.items.reduce((n,i)=>n+i.scenes.length,0),
  recordingsProduced:ready.length > 0,reviewReady:ready.length,rendering:entries.filter(e=>e.status==='rendering').map(e=>e.id),
  pending:entries.filter(e=>e.status==='pending').length,blocked:entries.filter(e=>e.status==='blocked').map(e=>({id:e.id,error:e.error})),environment},null,2));
