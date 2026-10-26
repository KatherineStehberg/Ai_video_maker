import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {resolveSafeAsset} from '../core/asset-manager.js';
export const hashFile = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function courseFingerprint(p) {
 return createHash('sha256').update(JSON.stringify({title:p.title,brand:p.brand,aspect:p.aspectRatio,voice:p.voice,music:p.music,captions:p.captions,
 assets:p.assets,cta:p.cta,sfx:p.sfx,originalAudio:p.originalAudio,scenes:p.scenes})).digest('hex');
}
const checked=new Map();
function checkedHash(file){const stat=fs.statSync(file);const key=file+'|'+stat.size+'|'+stat.mtimeMs;if(!checked.has(key)){if(checked.size>32)checked.clear();checked.set(key,hashFile(file));}return checked.get(key);}
export function preparedCourseVideo(p) {
 const proof=p?.metadata?.courseRenderProof;
 if(!proof?.ok || proof.speechTimingVerified !== true || proof.projectFingerprint!==courseFingerprint(p) || !proof.fullyDecoded || !proof.audio || !proof.motionVerified) return null;
 const file=resolveSafeAsset(proof.file);if(!file||!fs.existsSync(file))return null;
 const stat=fs.statSync(file);if(!stat.isFile()||stat.size!==proof.bytes)return null;
 if(p.scenes.some(s=>!s.assetPath||!s.narrationPath||![s.assetPath,s.narrationPath].every(r=>{const a=resolveSafeAsset(r);return a&&fs.existsSync(a);})))return null;
 if(!p.captions?.file || !fs.existsSync(resolveSafeAsset(p.captions.file)||''))return null;
 if(checkedHash(file)!==proof.sha256)return null;
 if(!proof.captionsSha256 || checkedHash(resolveSafeAsset(p.captions.file))!==proof.captionsSha256)return null;
 if(!proof.scenes || p.scenes.some((scene,i)=>{const evidence=proof.scenes[i];return !evidence||evidence.id!==scene.id||checkedHash(resolveSafeAsset(scene.assetPath))!==evidence.assetSha256||checkedHash(resolveSafeAsset(scene.narrationPath))!==evidence.audioSha256;}))return null;
 return {proof,videoUrl:'/file?path='+encodeURIComponent(proof.file)};
}
