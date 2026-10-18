import fs from 'node:fs';
import {spawn} from 'node:child_process';
const root='data/assets/images/lc-chile-courses/prepared-RPM-2026-001';
for(let i=1;i<=6;i++) {
 const out=root+'/render-'+i;
 if(fs.existsSync(out+'/qa.json')&&JSON.parse(fs.readFileSync(out+'/qa.json')).rendered) {console.log('Reuse verified animation',i);continue;}
 if(fs.existsSync(out))throw Error('Incomplete output exists; preserve it and choose a new output directory: '+out);
 console.log('Render animation',i,'of 6');
 await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['.agents/skills/lc-course-animations/scripts/render.cjs',root+'/scene-'+i+'.html',out],{stdio:'inherit',windowsHide:true});
  child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('Animation '+i+' failed: '+code)));
 });
}
