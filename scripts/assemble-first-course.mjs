import {courseTarget} from './course-target.mjs';
const {courseId,projectId,assetRoot,item:courseItem}=courseTarget(process.argv[2]);
import fs from 'node:fs';
import path from 'node:path';
import {loadProject,saveProject} from '../src/core/project.js';
import {ffmpegRun,probeDuration} from '../src/lib/ffmpeg.js';
import {runPipeline} from '../src/core/pipeline.js';
import {abs,rel} from '../src/lib/paths.js';
const p=loadProject(projectId);
if(p.outputPath && fs.existsSync(abs(p.outputPath)))throw Error('An export already exists; preserve it and use the editor to make intentional revisions.');
const root=assetRoot;
const manifest=JSON.parse(fs.readFileSync(root+'/render-manifest.json'));
if(Object.keys(manifest).length!==p.scenes.length)throw Error('Verified animations required for all course scenes');
for(const value of Object.values(manifest)){const qa=JSON.parse(fs.readFileSync(value+'/qa.json'));if(!qa.rendered)throw Error('Unverified animation');}
const montage=root+'/scene-1-composite.mp4';
if(!fs.existsSync(montage)) {
 const cover=root+'/cover-intro.mp4',stock=root+'/typing-intro.mp4';
 if(!fs.existsSync(cover))await ffmpegRun(['-loop','1','-i','data/assets/images/lc-chile-courses/remote-work-cover.png','-t','1','-vf','scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1','-r','24','-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-an',cover]);
 if(!fs.existsSync(stock))await ffmpegRun(['-i','data/assets/images/lc-chile-courses/remote-work/typing-7706630.mp4','-t','6','-vf','scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1,fade=t=in:st=0:d=0.25,fade=t=out:st=5.75:d=0.25','-r','24','-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-an',stock]);
 const list=root+'/intro-concat.txt';fs.writeFileSync(list,[cover,stock,manifest[1]+'/animation.mp4'].map(v=>"file '"+abs(v).split(path.sep).join('/')+"'").join('\n'));
 await ffmpegRun(['-f','concat','-safe','0','-i',list,'-t',String(p.scenes[0].duration),'-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-an','-movflags','+faststart',montage]);
}
const credit={proveedor:'lc-course-animations',autor:'Language Center Chile',licencia:'Original educational animation; GSAP standard license retained in HTML',fuente:'Local HTML/GSAP sources and PR #3 course illustrations',stock:{id:'7706630',author:'MART PRODUCTION',source:'https://www.pexels.com/video/person-working-on-a-laptop-7706630/',license:'https://www.pexels.com/license/'}};
for(let i=0;i<p.scenes.length;i++){
 const file=i===0?montage:manifest[i+1]+'/animation.mp4';
 const duration=await probeDuration(abs(file));if(duration+0.05<p.scenes[i].duration)throw Error('Visual too short');
 const sidecar=file+'.json';if(!fs.existsSync(sidecar))fs.writeFileSync(sidecar,JSON.stringify({...credit,animationSource:root+'/scene-'+(i+1)+'.html'},null,2));
 Object.assign(p.scenes[i],{assetPath:file,assetKind:'video',assetProvider:'lc-course-animations',assetCredit:credit,kenBurns:'none',provenance:{kind:'animated-lesson',authorized:true,originalReference:'local:'+root+'/scene-'+(i+1)+'.html',notSoftwareEvidence:true},notes:'Editable HTML/GSAP source: '+root+'/scene-'+(i+1)+'.html. Simulated examples use fictional data.'});
}
p.editor ||= {version:1,revision:1,exportedRevision:null,savedAt:null,job:null};
saveProject(p);
const report=await runPipeline(p,{steps:['subtitles','render'],onProgress:e=>console.log(e.step,e.pct,e.message)});
p.editor.exportedRevision=p.editor.revision;p.editor.savedAt=new Date().toISOString();saveProject(p);
console.log(JSON.stringify({output:p.outputPath,errors:report.errors,warnings:report.warnings}));
