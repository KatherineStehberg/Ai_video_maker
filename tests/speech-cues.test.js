import test from 'node:test';
import assert from 'node:assert/strict';
import {speechCues} from '../src/core/speech-cues.js';
import {buildCues,verifyCaptionCoverage} from '../src/core/subtitles.js';
import {makeProject} from '../src/core/project.js';
import {courseFingerprint,preparedCourseVideo} from '../src/course-production/prepared.js';
test('actual speech boundaries preserve every word and replace proportional timing',()=>{
 const text='One message. A much longer second sentence with context.';
 const marks=[{time:.2,offset:0},{time:1,offset:4},{time:4,offset:13},{time:4.3,offset:15},{time:4.7,offset:20},{time:5.2,offset:27},{time:5.6,offset:34},{time:6,offset:43},{time:6.3,offset:48}];
 const cues=speechCues(text,marks,7,30);
 assert.equal(cues.map(c=>c.text).join(' '),text);assert.equal(cues[0].start,0);assert.equal(cues.at(-1).end,7);
 const p=makeProject({aspectRatio:'16:9',scenes:[{text,duration:7,captionTimingText:text,captionTimings:cues}]});
 const actual=buildCues(p);assert.equal(actual.at(-1).end,7);assert.ok(verifyCaptionCoverage(p).ok);
 p.scenes[0].text='A manually changed narration.';assert.equal(buildCues(p).map(c=>c.text.replace(/\n/g,' ')).join(' '),p.scenes[0].text);
});
test('invalid marks fail and a changed project cannot inherit an old verified video',()=>{
 assert.throws(()=>speechCues('Text',[],2));assert.throws(()=>speechCues('Text',[{time:4,offset:0}],2));
 const p=makeProject({scenes:[{text:'A lesson',duration:3}]});const hash=courseFingerprint(p);
 p.metadata={courseRenderProof:{ok:true,projectFingerprint:hash,fullyDecoded:true,audio:true,motionVerified:true,file:'output/missing.mp4'}};
 assert.equal(preparedCourseVideo(p),null);p.scenes[0].text='An edited lesson';assert.notEqual(courseFingerprint(p),hash);assert.equal(preparedCourseVideo(p),null);
});
