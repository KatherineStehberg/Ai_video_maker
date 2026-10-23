import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { makeProject, makeScene, loadProject, saveProject, listProjects } from '../core/project.js';
import { planScenes } from '../core/scene-planner.js';
import { proponerTextosDestacados, normalizeOnScreenStyle, POSICIONES_DESTACADO, ANIMACIONES_DESTACADO } from '../core/on-screen-text.js';
import { normalizeCaptionStyle, captionStyleOptions } from '../core/captions-style.js';
import { narrateProject } from '../core/tts.js';
import { runPipeline } from '../core/pipeline.js';
import { renderProject } from '../core/renderer.js';
import { buildExportPackage } from '../core/export.js';
import { loadBrand, listBrands } from '../core/brands.js';
import { getTemplate, listTemplates } from '../templates/index.js';
import { ASPECTS } from '../config.js';
import { PATHS, abs, rel } from '../lib/paths.js';
import { ffmpegRun } from '../lib/ffmpeg.js';
import { resolveSafeAsset } from '../core/asset-manager.js';
import { listAllVoices } from '../providers/tts/index.js';
import { LANGUAGES, DEFAULT_VOICES, normalizeLanguage, resolveVoices } from '../core/lang.js';

const importsDir=path.join(PATHS.data,'studio-imports');
export const styles=['clean','dynamic','minimal'];
const active=new Set();
export const scriptHash=p=>createHash('sha256').update(p.scenes.map(s=>s.text).join('\n')).digest('hex');
export function studioProject(id){
  if(!/^vid_[a-zA-Z0-9_-]+$/.test(id))throw new Error('ID de proyecto inválido');
  const p=loadProject(id);if(!p?.studio)throw new Error('Proyecto de estudio no encontrado');
  if(p.studio.job?.status==='running' && !active.has(id)){p.studio.job.status='interrupted';p.studio.job.error='Servidor reiniciado; revisa y vuelve a solicitar la operación';saveProject(p);}
  return p;
}
function available(p){if(active.has(p.id))throw new Error('Proyecto en procesamiento; espera antes de editar');}
function reference(value){
  const v=String(value || '').trim();if(v && !/^(https?:\/\/|local:)/.test(v))throw new Error('Referencia debe ser URL http(s) o local:archivo');return v || null;
}
export function createStudio(input){
  if(!String(input.script || '').trim())throw new Error('Escribe primero un guion; la expansión automática de ideas aún requiere proveedor');
  if(String(input.script).length>20000)throw new Error('Guion demasiado largo para este primer flujo');
  const template=getTemplate(input.template);
  const p=makeProject({title:input.title || 'Mi video',brand:input.brand || 'personal',template:template.id,script:String(input.script),aspectRatio:input.aspectRatio || '9:16',language:normalizeLanguage(input.language),voice:{provider:'none',enabled:false},captions:{...template.captions,enabled:true,burnIn:true},
    studio:{version:1,style:'clean',revision:1,approvedScriptHash:null,references:[],commissionId:input.commissionId || null,job:null,resultRevision:null,networkPolicy:'local-only'}});
  // El rotulo NO va en todas las escenas. Antes se escribia «1. Titulo»,
  // «2. Titulo»… encima de cada imagen, que es exactamente lo que los
  // subtitulos ya hacen y ademas tapa la foto. Ahora se PROPONE solo donde
  // aporta (portada, secciones, cifras y cierre) y la usuaria decide.
  p.scenes=proponerTextosDestacados(
    planScenes(p).map(s=>({...s,kenBurns:'none',transition:'none',provenance:{kind:'generated-graphic',authorized:true,originalReference:'local:procedural-brand-background',generator:'FFmpeg',notSoftwareEvidence:true}})),
    {titulo:p.title}
  );
  saveProject(p);return p;
}
function importedAsset(assetPath){
  const file=resolveSafeAsset(assetPath);if(!file || !file.startsWith(importsDir+path.sep))throw new Error('Usa un recurso importado y autorizado en el estudio');
  const manifest=JSON.parse(fs.readFileSync(file+'.json','utf8'));if(!manifest.authorized)throw new Error('Recurso no autorizado');return manifest;
}
export function updateStudio(id,input){
  const p=studioProject(id);available(p);
  if(input.revision!==p.studio.revision)throw new Error('El proyecto cambió; recarga antes de guardar');
  if(input.title!==undefined)p.title=String(input.title).slice(0,120);
  if(input.brand!==undefined){if(!listBrands().some(b=>b.id===input.brand))throw new Error('Marca inválida');p.brand=input.brand;}
  if(input.aspectRatio!==undefined){if(!ASPECTS[input.aspectRatio])throw new Error('Formato inválido');p.aspectRatio=input.aspectRatio;p.exportFormats=[input.aspectRatio];}
  if(input.style!==undefined){if(!styles.includes(input.style))throw new Error('Estilo inválido');p.studio.style=input.style;}
  if(input.language!==undefined){if(!LANGUAGES.includes(input.language))throw new Error('Idioma inválido');p.language=input.language;}
  if(input.voice){if(!['sapi','piper','none'].includes(input.voice.provider))throw new Error('Este estudio sólo permite voces locales');p.voice={provider:input.voice.provider,name:String(input.voice.name || ''),enabled:input.voice.provider!=='none',rate:Math.max(-10,Math.min(10,Number(input.voice.rate)||0)),volume:100,en:String(input.voice.en || ''),es:String(input.voice.es || '')};}
  if(input.references)p.studio.references=input.references.map(r=>({kind:['drive','github','other'].includes(r.kind)?r.kind:'other',originalReference:reference(r.originalReference),access:'reference-only',label:String(r.label || '').slice(0,200)}));
  if(input.scenes){
    if(!Array.isArray(input.scenes)||!input.scenes.length||input.scenes.length>40)throw new Error('Se requieren entre 1 y 40 escenas');
    const previous=new Map(p.scenes.map(s=>[s.id,s]));const seen=new Set();
    p.scenes=input.scenes.map(s=>{
      if(!previous.has(s.id)||seen.has(s.id))throw new Error('Escena inválida o duplicada');seen.add(s.id);
      const old=previous.get(s.id);
      // Texto destacado: los cinco campos viajan desde la tarjeta de escena.
      // Tocar el texto a mano marca `onScreenTextManual`, para que una
      // propuesta automatica posterior no lo pise.
      const tituloNuevo=s.onScreenTitle===undefined?old.onScreenTitle:String(s.onScreenTitle).slice(0,100);
      const manual=old.onScreenTextManual || (s.onScreenTitle!==undefined && tituloNuevo!==old.onScreenTitle);
      const n=makeScene({...old,text:String(s.text ?? old.text).slice(0,4000),duration:s.duration ?? old.duration,
        onScreenTitle:tituloNuevo,
        showOnScreenText:s.showOnScreenText===undefined?old.showOnScreenText:Boolean(s.showOnScreenText),
        onScreenPosition:POSICIONES_DESTACADO.includes(s.onScreenPosition)?s.onScreenPosition:old.onScreenPosition,
        onScreenAnimation:ANIMACIONES_DESTACADO.includes(s.onScreenAnimation)?s.onScreenAnimation:old.onScreenAnimation,
        onScreenStyle:normalizeOnScreenStyle(s.onScreenStyle,old.onScreenStyle),
        onScreenTextManual:manual,
        caption:s.caption ?? null,kenBurns:p.studio.style==='dynamic'?'in':'none',transition:p.studio.style==='minimal'?'none':'fade'});
      if(s.assetPath){const manifest=importedAsset(s.assetPath);if(!['own','capture','generated-image'].includes(manifest.kind))throw new Error('Recurso no visual');n.assetPath=s.assetPath;n.provenance=manifest;}
      else {n.assetPath=null;n.provenance={kind:'generated-graphic',authorized:true,originalReference:'local:procedural-brand-background',generator:'FFmpeg',notSoftwareEvidence:true};}
      return n;
    });
    p.script=p.scenes.map(s=>'## '+s.text).join('\n');
  }
  if(input.music){
    const musicPath=input.music.path || null;const provenance=musicPath?importedAsset(musicPath):null;
    if(provenance && provenance.kind!=='music')throw new Error('Recurso no musical');
    p.music={...p.music,path:musicPath,enabled:!!musicPath,volume:Math.max(0,Math.min(1,Number(input.music.volume ?? .12))),provenance};
  }
  if(input.captions!==undefined)p.captions={...p.captions,enabled:!!input.captions,burnIn:!!input.captions};
  // Estilo global de subtitulos: preset, tipografia, color, fondo, opacidad,
  // contorno, posicion y alineacion. Se guarda con el proyecto.
  if(input.captionStyle!==undefined)p.captions={...p.captions,style:normalizeCaptionStyle(input.captionStyle,p.captions.style)};
  if(input.approveScript===true)p.studio.approvedScriptHash=scriptHash(p);
  if(p.studio.approvedScriptHash!==scriptHash(p))p.studio.approvedScriptHash=null;
  p.studio.revision++;p.status='draft';saveProject(p);return p;
}
export function imports(){if(!fs.existsSync(importsDir))return [];return fs.readdirSync(importsDir).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(importsDir,f),'utf8')));}
export function importTarget(name,kind,originalReference,authorized){
  if(authorized!==true)throw new Error('Confirma que tienes autorización para usar el recurso');
  const ext=path.extname(name).toLowerCase();const allowed=kind==='music'?['.wav','.mp3','.m4a','.ogg']:['.png','.jpg','.jpeg','.webp','.mp4','.mov','.webm'];
  if(!['own','capture','generated-image','music'].includes(kind)||!allowed.includes(ext))throw new Error('Tipo de recurso no permitido');
  fs.mkdirSync(importsDir,{recursive:true});const file=path.join(importsDir,randomUUID()+ext);
  return {file,manifest:{path:rel(file),name:path.basename(name),kind,authorized:true,originalReference:reference(originalReference)||`local:${path.basename(name)}`,access:'local-import',importedAt:new Date().toISOString()}};
}
export async function capabilities(){return {brands:listBrands(),templates:listTemplates(),aspects:ASPECTS,styles,captionStyle:captionStyleOptions(),onScreen:{positions:POSICIONES_DESTACADO,animations:ANIMACIONES_DESTACADO},voices:await listAllVoices(),languages:LANGUAGES,defaultVoices:DEFAULT_VOICES,providers:{mode:'local-only',paidGenerationEnabled:false},imports:imports(),projects:listProjects().filter(p=>loadProject(p.id)?.studio)};}
async function background(p,task){
  try{await task();p.studio.job.status='complete';p.studio.job.progress=100;}
  catch(e){p.studio.job.status='failed';p.studio.job.error=e.message;p.status='failed';}
  finally{p.studio.job.finishedAt=new Date().toISOString();active.delete(p.id);saveProject(p);}
}
export function startOperation(id,action,sceneId){
  const p=studioProject(id);available(p);if(active.size)throw new Error('Hay otra operación de estudio en curso');
  if(p.studio.approvedScriptHash!==scriptHash(p))throw new Error('Aprueba el guion actualizado antes de generar');
  const selected=sceneId?p.scenes.find(s=>s.id===sceneId):null;
  if(action==='scene'&&!selected)throw new Error('Escena no encontrada');
  if(!['render','scene'].includes(action))throw new Error('Operación desconocida');
  p.studio.job={id:randomUUID(),status:'running',action,sceneId,progress:0,startedAt:new Date().toISOString()};active.add(id);saveProject(p);
  const progress=e=>{p.studio.job.progress=e.pct || 0;p.studio.job.message=e.message || e.step;saveProject(p);};
  void background(p,async()=>{
    if(action==='scene'){
      const subset={...p,scenes:[selected]};const audio=await narrateProject(subset,{force:true});
      if(p.voice.enabled && (audio.provider==='none'||audio.errors?.length))throw new Error('No se pudo regenerar la voz de esta escena');
      if(audio.narrations[0]){selected.narrationPath=audio.narrations[0];selected.duration=Number((audio.durations[0]+.45).toFixed(2));}
      // Preview uses the existing renderer on just one scene, in its own work dir.
      const previewProject={...p,id:`${p.id}_preview_${selected.id}`,scenes:[selected],voice:{enabled:false},music:{enabled:false},assets:{},cta:'',captions:{enabled:false,burnIn:false}};
      const visual=await renderProject(previewProject,loadBrand(p.brand),{onProgress:progress});
      if(p.voice.enabled && selected.narrationPath){const target=abs(visual.file).replace(/\.mp4$/,'_voice.mp4');await ffmpegRun(['-i',abs(visual.file),'-i',abs(selected.narrationPath),'-c:v','copy','-af','apad','-t',String(selected.duration),'-c:a','aac',target]);p.studio.scenePreview=rel(target);}else p.studio.scenePreview=visual.file;
      p.studio.revision++;p.status='draft';
    }else{
      // Skip script/scene/asset provider stages: preserve approved edits and never auto-fetch resources.
      const r=await runPipeline(p,{steps:['narration','subtitles','render','metadata'],onProgress:progress});
      p.studio.warnings=r.warnings;p.studio.resultRevision=p.studio.revision;
      p.studio.export=buildExportPackage(p);
    }
  });return p;
}
export function exportManifest(id){const p=studioProject(id);return {contractVersion:'ksl.video.v1',commissionId:p.studio.commissionId,projectId:p.id,script:p.script,scriptApproved:p.studio.approvedScriptHash===scriptHash(p),references:p.studio.references,resources:p.scenes.map(s=>({sceneId:s.id,path:s.assetPath,provenance:s.provenance})),music:p.music,state:p.status,job:p.studio.job,revision:p.studio.revision,resultRevision:p.studio.resultRevision,results:p.studio.export || null};}
