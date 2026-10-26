// Stage a revision away from live projects; publish only after real media/browser QA.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {loadProject,makeProject,saveProject,projectFile} from '../src/core/project.js';
import {preparedCourseVideo,hashFile} from '../src/course-production/prepared.js';
import {abs} from '../src/lib/paths.js';
const id='vid_course_RPM-2026-001';
const revision='output/revisions/RPM-2026-001-sapi-sync-v2';
const second='vid_course_RPM-2026-002';
function inventory(paths){const result={};const visit=file=>{if(!fs.existsSync(file))return;if(fs.statSync(file).isDirectory()){for(const name of fs.readdirSync(file))visit(path.join(file,name));}else result[file.split(path.sep).join('/')]=hashFile(file);};paths.forEach(visit);return result;}
function checkInventory(records){for(const [file,hash] of Object.entries(records))assert.equal(hashFile(file),hash,'Protected file changed: '+file);}
if(process.argv[2]==='init'){
 const p=loadProject(id);assert.ok(p?.outputPath);assert.ok(fs.existsSync(abs(p.outputPath)));
 fs.mkdirSync('output/revisions',{recursive:true});fs.mkdirSync(revision);
 fs.mkdirSync(revision+'/backup');fs.mkdirSync(revision+'/projects');
 fs.copyFileSync(projectFile(id),revision+'/backup/project-before.json',fs.constants.COPYFILE_EXCL);
 fs.copyFileSync(abs(p.outputPath),revision+'/backup/video-before.mp4',fs.constants.COPYFILE_EXCL);
 const protectedFiles=inventory([projectFile(second),'data/assets/images/lc-chile-courses/prepared-RPM-2026-002','output/drafts/'+second,loadProject(second).outputPath]);
 const originals={projectFile:projectFile(id),projectHash:hashFile(projectFile(id)),videoFile:p.outputPath,videoHash:hashFile(abs(p.outputPath))};
 fs.writeFileSync(revision+'/protected.json',JSON.stringify({originals,second:protectedFiles},null,2));
 p.outputs={};p.outputPath=null;p.status='draft';p.error=null;
 p.metadata={...p.metadata};delete p.metadata.courseRenderProof;
 p.editor={...p.editor,revision:(p.editor?.revision||1)+1,exportedRevision:null,job:null};
 fs.writeFileSync(revision+'/projects/'+id+'.json',JSON.stringify(p,null,2),{flag:'wx'});
 console.log(JSON.stringify({revision,projects:revision+'/projects',output:revision+'/media',queue:revision+'/queue'}));
}else if(process.argv[2]==='publish'){
 const records=JSON.parse(fs.readFileSync(revision+'/protected.json','utf8'));
 checkInventory(records.second);assert.equal(hashFile(records.originals.projectFile),records.originals.projectHash,'Live project changed during preparation');assert.equal(hashFile(abs(records.originals.videoFile)),records.originals.videoHash);
 const p=makeProject(JSON.parse(fs.readFileSync(revision+'/projects/'+id+'.json','utf8')));
 assert.ok(preparedCourseVideo(p),'Revision lacks current verification');assert.equal(p.metadata.courseRenderProof.syncEvidence?.samples.length,3,'Three synchronization checks required');
 const browser=JSON.parse(fs.readFileSync(revision+'/media/drafts/'+id+'/preparation/browser-verification.json','utf8'));
 assert.ok(browser.ended&&browser.persisted&&browser.errors.length===0,'Browser QA incomplete');
 assert.notEqual(p.outputPath,records.originals.videoFile);saveProject(p);checkInventory(records.second);
 assert.equal(hashFile(revision+'/backup/project-before.json'),records.originals.projectHash);assert.equal(hashFile(revision+'/backup/video-before.mp4'),records.originals.videoHash);
 fs.writeFileSync(revision+'/published.json',JSON.stringify({projectId:id,output:p.outputPath,oldVideoPreserved:true,secondUnchanged:true,verifiedAt:new Date().toISOString()},null,2));
 console.log(JSON.stringify({published:id,output:p.outputPath,secondUnchanged:true}));
}else throw Error('Use init or publish');
