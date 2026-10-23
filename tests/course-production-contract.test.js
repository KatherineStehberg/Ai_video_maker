import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPack, courseSpec } from '../src/course-production/index.js';
import { validatePack } from '../src/course-production/queue.js';
import { makeProject } from '../src/core/project.js';
import { resolveVoices } from '../src/core/lang.js';

test('all fifteen scripts survive the production contract with no missing narration',()=>{
 const pack=validatePack(loadPack());assert.equal(pack.items.length,15);
 for(const item of pack.items){
  const spec=courseSpec(item,{provider:'sapi',name:'English voice'});
  assert.equal(spec.script,item.script);assert.equal(spec.escenas.map(e=>e.text).join('\n\n'),item.script);
  assert.equal(spec.format,'16:9');assert.equal(spec.duration,null);assert.equal(spec.voice.provider,'sapi');
  assert.equal(spec.subtitles.language,'en');assert.ok(spec.subtitles.enabled&&spec.subtitles.burnIn);
  const project=makeProject({language:spec.subtitles.language,voice:spec.voice});
  const selected=resolveVoices(project,[{name:'English voice',language:'en-US'},{name:'Spanish voice',language:'es-CL'}]);
  assert.equal(selected.base,'English voice');assert.equal(selected.baseLang,'en');
 }
});
