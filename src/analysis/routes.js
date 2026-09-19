import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { PATHS } from '../lib/paths.js';
import { ffmpegRun } from '../lib/ffmpeg.js';
import { probe, analyzeLocal, combine, cutsCsv } from './local.js';
import { geminiConfig, interpret } from './gemini.js';

const root=path.join(PATHS.data,'analyses'), maxBytes=2*1024**3;
let busy=false;
const jobs=new Map();
const reply=(res,status,data,type='application/json')=>{res.writeHead(status,{'content-type':type,'cache-control':'no-store'});res.end(type==='application/json'?JSON.stringify(data):data);};
const persist=j=>fs.writeFileSync(path.join(root,j.id,'analysis.json'),JSON.stringify(j,null,2));
export function get(id) {
  if (!/^[\da-f-]{36}$/.test(id)) return null;
  if (jobs.has(id)) return jobs.get(id);
  try {const j=JSON.parse(fs.readFileSync(path.join(root,id,'analysis.json'),'utf8')); if(j.status==='running'){j.status='interrupted';j.error='Servidor reiniciado; vuelve a cargar el original para reanalizar';} jobs.set(id,j); return j;} catch{return null;}
}
async function execute(j,file,dir,external) {
  const began=Date.now();
  const progress=(percent,stage)=>{j.progress=percent;j.stage=stage;};
  try {
    j.metadata=await probe(file); persist(j);
    if(j.metadata.duration>14400)throw new Error('Límite de duración: 4 horas; divide el material antes de analizar');
    j.local=await analyzeLocal(file,j.metadata,progress);j.cuts=combine(j.local,[],j.metadata);persist(j);
    progress(78,'Creando copia de previsualización compatible');
    await ffmpegRun(['-i',file,'-map',`0:${j.metadata.videoStream}`,...(j.metadata.audio.length?['-map',`0:${j.metadata.audio[0].index}`]:['-an']),'-vf','scale=640:-2','-c:v','libx264','-preset','ultrafast','-crf','28','-threads','1','-c:a','aac','-movflags','+faststart',path.join(dir,'preview.mp4')],{onProgress:t=>progress(78+6*Math.min(1,t/j.metadata.duration),'Creando previsualización')});
    j.previewReady=true;
    if(external) {
      try {j.gemini=await interpret(file,dir,j.metadata,progress,{onSegment:r=>{j.gemini.segments ??=[];const i=j.gemini.segments.findIndex(s=>s.start===r.start);if(i<0)j.gemini.segments.push(r);else j.gemini.segments[i]=r;persist(j);}});j.cuts=combine(j.local,j.gemini.suggestions,j.metadata);}
      catch(e){j.gemini={...j.gemini,status:'error',error:e.message};}
    }
    j.status='complete'; progress(100,'Análisis terminado');
  } catch(e){j.status='error';j.error=e.message;}
  finally {j.elapsedMs=Date.now()-began;j.finishedAt=new Date().toISOString();busy=false;try{persist(j);}catch{j.status='error';j.error='No se pudo guardar el análisis. Revisa el espacio y permisos del disco.';}}
}

export async function analysisRoute(req,res,url) {
  if(!url.pathname.startsWith('/api/analysis')) return false;
  if(!/^(::1|::ffff:127\.|127\.)/.test(req.socket.remoteAddress || '')){reply(res,403,{error:'Análisis disponible sólo desde este equipo'});return true;}
  // Require a same-origin custom header for every upload (prevents browser CSRF).
  const host=req.headers.host || '';
  if(!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {reply(res,403,{error:'Host local requerido'});return true;}
  const parts=url.pathname.split('/').filter(Boolean);
  try {
    if(req.method==='GET' && parts[2]==='config') {const c=geminiConfig();reply(res,200,{hasKey:!!c.key,model:c.model,requestedFps:c.fps,segmentSeconds:c.segmentSeconds,maxBytes});return true;}
    if(req.method==='POST' && parts.length===2) {
      if(req.headers['x-analysis-upload']!=='1' || (req.headers.origin && req.headers.origin!==`http://${host}`)) {reply(res,403,{error:'Origen de subida inválido'});return true;}
      const external=url.searchParams.get('gemini')==='true';
      if(external && req.headers['x-gemini-consent']!=='yes') {reply(res,400,{error:'Se requiere consentimiento explícito para enviar video y audio a Google Gemini'});return true;}
      if(external && !geminiConfig().key){reply(res,409,{error:'Sin clave Gemini. Selecciona análisis local.'});return true;}
      if(busy){reply(res,409,{error:'Hay un análisis o subida en curso; espera a que termine'});return true;}
      if(Number(req.headers['content-length'])>maxBytes){reply(res,413,{error:'Límite de subida: 2 GiB'});return true;}
      busy=true;const id=randomUUID(),dir=path.join(root,id),file=path.join(dir,'original');
      try {
        await fsp.mkdir(dir,{recursive:true});let bytes=0;
        await pipeline(req,new Transform({transform(chunk,enc,cb){bytes+=chunk.length;cb(bytes>maxBytes?new Error('Límite de subida: 2 GiB'):null,chunk);}}),fs.createWriteStream(file,{flags:'wx'}));
        if(!bytes)throw new Error('Video vacío');
        const j={id,status:'running',progress:0,stage:'Leyendo ffprobe',createdAt:new Date().toISOString(),bytes,consent:external?{service:'Google Gemini API',at:new Date().toISOString()}:null,gemini:{status:external?'pending':'disabled',reason:external?null:'Análisis local: sin interpretación audiovisual de Gemini'},cuts:[]};
        jobs.set(id,j);persist(j);reply(res,202,j);void execute(j,file,dir,external);
      }catch(e){busy=false;await fsp.rm(file,{force:true});throw e;}
      return true;
    }
    const j=get(parts[2] || '');if(!j){reply(res,404,{error:'Análisis no encontrado'});return true;}
    if(req.method!=='GET'){reply(res,405,{error:'Método no permitido'});return true;}
    if(parts[3]==='preview'){
      if(!j.previewReady){reply(res,409,{error:'Previsualización todavía no disponible'});return true;}
      const file=path.join(root,j.id,'preview.mp4'),size=fs.statSync(file).size,range=req.headers.range;
      let start=0,end=size-1;
      if(range){const m=/^bytes=(\d+)-(\d*)$/.exec(range);if(!m || Number(m[1])>=size || (m[2] && Number(m[2])<Number(m[1]))){res.writeHead(416,{'content-range':`bytes */${size}`});res.end();return true;}start=Number(m[1]);end=m[2]?Math.min(Number(m[2]),size-1):end;}
      res.writeHead(range?206:200,{'content-type':'video/mp4','accept-ranges':'bytes','content-length':end-start+1,...(range?{'content-range':`bytes ${start}-${end}/${size}`}:{})});fs.createReadStream(file,{start,end}).pipe(res);return true;
    }
    if(parts[3]==='export'){
      const csv=url.searchParams.get('format')==='csv';res.setHeader('content-disposition',`attachment; filename="analysis-${j.id}.${csv?'csv':'json'}"`);reply(res,200,csv?cutsCsv(j.cuts):j,csv?'text/csv; charset=utf-8':'application/json');return true;
    }
    reply(res,200,j);return true;
  }catch(e){if(!res.destroyed)reply(res,400,{error:e.message});return true;}
}
