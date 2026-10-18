import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {resolveSafeAsset} from '../core/asset-manager.js';
export const hashFile = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function courseFingerprint(p) {
 return createHash('sha256').update(JSON.stringify({title:p.title,brand:p.brand,aspect:p.aspectRatio,voice:p.voice,music:p.music,captions:p.captions,
 scenes:p.scenes.map(s=>({id:s.id,text:s.text,caption:s.caption,duration:s.duration,assetPath:s.assetPath,narrationPath:s.narrationPath,narrationKey:s.narrationKey,captionTimings:s.captionTimings,excluida:s.excluida,transition:s.transition,kenBurns:s.kenBurns,showOnScreenText:s.showOnScreenText,onScreenTitle:s.onScreenTitle}))})).digest('hex');
}
const checked=new Map();
export function preparedCourseVideo(p) {
 const proof=p?.metadata?.courseRenderProof;
 if(!proof?.ok || proof.projectFingerprint!==courseFingerprint(p) || !proof.fullyDecoded || !proof.audio || !proof.motionVerified) return null;
 const file=resolveSafeAsset(proof.file);if(!file||!fs.existsSync(file))return null;
 const stat=fs.statSync(file);if(!stat.isFile()||stat.size!==proof.bytes)return null;
 if(p.scenes.some(s=>!s.assetPath||!s.narrationPath||![s.assetPath,s.narrationPath].every(r=>{const a=resolveSafeAsset(r);return a&&fs.existsSync(a);})))return null;
 if(!p.captions?.file || !fs.existsSync(resolveSafeAsset(p.captions.file)||''))return null;
 const key=file+'|'+stat.size+'|'+stat.mtimeMs;
 if(!checked.has(key)){checked.clear();checked.set(key,hashFile(file));}
 if(checked.get(key)!==proof.sha256)return null;
 return {proof,videoUrl:'/file?path='+encodeURIComponent(proof.file)};
}
