import fs from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { capabilities, createStudio, updateStudio, studioProject, startOperation, importTarget, exportManifest } from './service.js';
const send=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(body));};
async function json(req){let text='';for await(const b of req){text+=b;if(text.length>250000)throw new Error('Solicitud demasiado grande');}return JSON.parse(text || '{}');}
export async function studioRoute(req,res,url){
  if(!url.pathname.startsWith('/api/studio'))return false;
  if(!/^(::1|::ffff:127\.|127\.)/.test(req.socket.remoteAddress || '')){send(res,403,{error:'Sólo acceso local'});return true;}
  if(req.method!=='GET' && (req.headers['x-studio-request']!=='1'||(req.headers.origin && req.headers.origin!==`http://${req.headers.host}`))){send(res,403,{error:'Solicitud de estudio no autorizada'});return true;}
  const s=url.pathname.split('/').filter(Boolean).slice(2);
  try{
    if(req.method==='GET'&&s[0]==='config'){send(res,200,await capabilities());return true;}
    if(req.method==='POST'&&s[0]==='import'){
      const target=importTarget(url.searchParams.get('name') || '',url.searchParams.get('kind'),url.searchParams.get('reference'),req.headers['x-resource-authorized']==='yes');let size=0;
      try{await pipeline(req,new Transform({transform(b,e,cb){size+=b.length;cb(size>250*1024**2?new Error('Máximo 250 MiB por recurso'):null,b);}}),fs.createWriteStream(target.file,{flags:'wx'}));if(!size)throw new Error('Recurso vacío');fs.writeFileSync(target.file+'.json',JSON.stringify(target.manifest,null,2));send(res,201,target.manifest);}
      catch(e){fs.rmSync(target.file,{force:true});throw e;}return true;
    }
    if(s[0]==='projects'){
      if(req.method==='POST'&&!s[1]){send(res,201,createStudio(await json(req)));return true;}
      if(req.method==='GET'){send(res,200,s[2]==='manifest'?exportManifest(s[1]):studioProject(s[1]));return true;}
      if(req.method==='PATCH'){send(res,200,updateStudio(s[1],await json(req)));return true;}
      if(req.method==='POST'&&s[2]==='run'){const b=await json(req);send(res,202,startOperation(s[1],b.action,b.sceneId));return true;}
    }
    send(res,404,{error:'Ruta de estudio no encontrada'});
  }catch(e){if(!res.destroyed)send(res,400,{error:e.message});}return true;
}
