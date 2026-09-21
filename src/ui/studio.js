const $=id=>document.getElementById(id);let config,project,timer;
/** Etiquetas de los controles del rótulo. Los valores son los del backend. */
const cfgOpciones={
  posiciones:[['top','Arriba del todo'],['upper-third','Tercio superior'],['center','Centro'],['lower-third','Tercio inferior'],['bottom','Abajo']],
  tamanos:[['small','Pequeño'],['medium','Mediano'],['large','Grande'],['xlarge','Enorme']],
  fondos:[['box','Caja semitransparente'],['outline','Sólo contorno'],['none','Sin fondo']],
  animaciones:[['fade','Aparece suave'],['slide-up','Sube al entrar'],['pop','Entrada seca'],['none','Sin animación']],
};
const msg=text=>{$('message').textContent=text || '';};
async function api(url,method='GET',data){const r=await fetch('/api/studio/'+url,{method,headers:{'content-type':'application/json','x-studio-request':'1'},...(data?{body:JSON.stringify(data)}:{})});const b=await r.json();if(!r.ok)throw Error(b.error);return b;}
const option=(value,text)=>{const o=document.createElement('option');o.value=value;o.textContent=text;return o;};
const fileUrl=p=>'/file?path='+encodeURIComponent(p);
function listOptions(el,items){el.replaceChildren(...items.map(([v,t])=>option(v,t)));}
async function init(){config=await api('config');for(const id of ['brand','edit-brand'])listOptions($(id),config.brands.map(b=>[b.id,b.name]));$('brand').value='personal';listOptions($('template'),config.templates.map(t=>[t.id,t.name]));for(const id of ['format','edit-format'])listOptions($(id),Object.entries(config.aspects).map(([id,a])=>[id,id+' · '+a.label]));$('format').value='9:16';
  listOptions($('voice'),[['none','Sin narración (explícito)'],...config.voices.map(v=>[v.provider+'|'+v.name,v.name+' · '+v.language])]);
  const byLang=code=>config.voices.filter(v=>String(v.language || '').slice(0,2).toLowerCase()===code);
  for(const [id,code] of [['voice-en','en'],['voice-es','es']]){
    const voces=byLang(code);
    listOptions($(id),voces.length?voces.map(v=>[v.name,v.name+' · '+v.language]):[['','(ninguna voz '+code+' instalada)']]);
    const porDefecto=config.defaultVoices?.[code];
    if(porDefecto && voces.some(v=>v.name===porDefecto))$(id).value=porDefecto;
  }
  $('voice-note').textContent=config.voices.length?'La voz se genera en el backend. El idioma del proyecto decide la voz por defecto; las marcas [en]/[es] cambian de voz dentro de una escena.':'No hay voz local disponible. Configura SAPI/Piper; elegir sin narración produce un video silencioso o sólo con música.';
  montarSubs(config.captionStyle);
  $('projects').replaceChildren(...config.projects.map(p=>{const b=document.createElement('button');b.textContent=p.title+' · '+p.status;b.onclick=()=>open(p.id).catch(e=>msg(e.message));return b;}));refreshImports();}
function refreshImports(){listOptions($('music'),[['','Sin música'],...config.imports.filter(a=>a.kind==='music').map(a=>[a.path,a.name])]);$('resources').replaceChildren(...config.imports.map(a=>{const li=document.createElement('li');li.textContent=`${a.name} · ${a.kind} · ${a.originalReference}`;return li;}));}
let estiloSubs={preset:'redes-sociales'},presetsSubs=[];
const BASE_SUBS={'9:16':64,'16:9':48,'1:1':58,'4:5':61};
/** Lee los controles globales de subtítulos. */
function leerEstiloSubs(){return {preset:estiloSubs.preset,fontFamily:$('subs-font').value,fontScale:Number($('subs-scale').value),color:$('subs-color').value,background:$('subs-bg').value,backgroundColor:$('subs-bgcolor').value,backgroundOpacity:Number($('subs-bgopacity').value),outlineScale:Number($('subs-outline').value),position:$('subs-pos').value,alignment:$('subs-align').value};}
function pintarEstiloSubs(e){estiloSubs={...estiloSubs,...e};const set=(id,v)=>{if(v!==undefined&&v!==null)$(id).value=String(v);};
  set('subs-font',e.fontFamily);set('subs-scale',e.fontScale);set('subs-color',e.color);set('subs-bg',e.background);
  set('subs-bgcolor',e.backgroundColor);set('subs-bgopacity',e.backgroundOpacity);set('subs-outline',e.outlineScale);
  set('subs-pos',e.position);set('subs-align',e.alignment);refrescarSubs();}
function refrescarSubs(){
  const on=$('captions').checked;$('subs-detalle').hidden=!on;
  $('subs-resumen').textContent=on?'Se subtitula el video entero, de principio a fin, con la narración exacta.':'Sin subtítulos: no aparecerá ningún texto de narración.';
  if(!on){$('subs-medida').textContent='';return;}
  const fmt=$('edit-format').value||'9:16';const px=Math.round((BASE_SUBS[fmt]??64)*Number($('subs-scale').value||1));
  $('subs-medida').textContent=`En ${fmt} la letra medirá unos ${px} px, en dos líneas como máximo, dentro de la zona segura.`;
  $('subs-preset-desc').textContent=presetsSubs.find(p=>p.id===estiloSubs.preset)?.description||'';
  for(const b of $('subs-presets').querySelectorAll('button'))b.setAttribute('aria-pressed',String(b.dataset.preset===estiloSubs.preset));
}
function montarSubs(opciones){
  presetsSubs=opciones?.presets||[];
  $('subs-presets').replaceChildren(...presetsSubs.map(p=>{const b=document.createElement('button');b.type='button';b.className='secondary';b.textContent=p.label;b.dataset.preset=p.id;b.title=p.description||'';
    b.onclick=()=>{estiloSubs={preset:p.id};pintarEstiloSubs(p.style||{});};return b;}));
  listOptions($('subs-font'),(opciones?.fonts||[{id:'Arial',label:'Arial'}]).map(f=>[f.id,f.label]));
  for(const id of ['captions','subs-font','subs-scale','subs-color','subs-bg','subs-bgcolor','subs-bgopacity','subs-outline','subs-pos','subs-align'])$(id).addEventListener('change',refrescarSubs);
  $('edit-format').addEventListener('change',refrescarSubs);
  refrescarSubs();
}
function field(label,element){const l=document.createElement('label');l.append(document.createTextNode(label),element);return l;}
function select(opciones,valor,dataField){const sel=document.createElement('select');sel.dataset.field=dataField;listOptions(sel,opciones);sel.value=valor;return sel;}
/**
 * Bloque «Agregar texto destacado sobre la imagen» de una tarjeta de escena.
 *
 * El rótulo es DISTINTO del subtítulo: el subtítulo lleva toda la narración en
 * todas las escenas; esto es un texto corto en unas pocas. Al desactivarlo la
 * escena conserva imagen, voz y subtítulos, y el texto escrito NO se borra.
 */
function bloqueDestacado(s){
  const caja=document.createElement('details');caja.className='destacado';
  const activo=!!(s.showOnScreenText && String(s.onScreenTitle||'').trim());caja.open=activo;
  const sum=document.createElement('summary');
  const on=document.createElement('input');on.type='checkbox';on.checked=activo;on.dataset.field='showOnScreenText';
  const estado=document.createElement('span');estado.className='muted';
  sum.append(on,document.createTextNode(' Agregar texto destacado sobre la imagen '),estado);caja.append(sum);
  const panel=document.createElement('div');panel.className='destacado-panel';
  const texto=document.createElement('input');texto.dataset.field='onScreenTitle';texto.value=s.onScreenTitle||'';texto.maxLength=60;
  const estilo=s.onScreenStyle||{};
  const pos=select(cfgOpciones.posiciones,s.onScreenPosition||'upper-third','onScreenPosition');
  const size=select(cfgOpciones.tamanos,estilo.size||'large','onScreenSize');
  const bg=select(cfgOpciones.fondos,estilo.background||'box','onScreenBackground');
  const anim=select(cfgOpciones.animaciones,s.onScreenAnimation||'fade','onScreenAnimation');
  const color=document.createElement('input');color.type='color';color.dataset.field='onScreenColor';color.value=estilo.color||'#ffffff';
  const rejilla=document.createElement('div');rejilla.className='grid';
  rejilla.append(field('Posición',pos),field('Tamaño',size),field('Fondo',bg),field('Entrada',anim),field('Color',color));
  // Vista previa: proporción del encuadre, el rótulo donde caería y la franja
  // de subtítulos, para ver de un vistazo que no chocan.
  const previa=document.createElement('div');previa.className='previa';
  const rotulo=document.createElement('span');rotulo.className='previa-rotulo';
  const franja=document.createElement('span');franja.className='previa-subtitulo';franja.textContent='subtítulos';
  previa.append(rotulo,franja);
  const aviso=document.createElement('p');aviso.className='muted';
  panel.append(field('Texto (2–8 palabras)',texto),rejilla,previa,aviso);caja.append(panel);
  const refrescar=()=>{
    panel.hidden=!on.checked;
    const t=texto.value.trim();const n=t?t.split(/\s+/).length:0;
    estado.textContent=on.checked?(t?`· ${n} palabra${n===1?'':'s'}`:'· sin texto todavía'):'· desactivado';
    aviso.textContent=(on.checked&&n>8)?`Son ${n} palabras: al generar se recortará a 8. El subtítulo sigue llevando la narración completa.`:'';
    rotulo.textContent=t||'Tu texto aquí';rotulo.dataset.vacio=t?'no':'si';rotulo.style.color=color.value;
    previa.dataset.pos=pos.value;previa.dataset.size=size.value;previa.dataset.bg=bg.value;
  };
  for(const c of [on,pos,size,bg,anim,color])c.addEventListener('change',refrescar);
  texto.addEventListener('input',refrescar);
  on.addEventListener('click',ev=>{ev.stopPropagation();if(on.checked)caja.open=true;});
  refrescar();return caja;
}
function draw(){
  $('create').hidden=true;$('editor').hidden=false;$('project-title').textContent=project.title;$('project-state').textContent=project.status;
  $('edit-brand').value=project.brand;$('edit-format').value=project.aspectRatio;$('style').value=project.studio.style;
  $('edit-language').value=project.language || 'es';
  if(project.voice.en)$('voice-en').value=project.voice.en;
  if(project.voice.es)$('voice-es').value=project.voice.es;
  $('voice-rate').value=project.voice.rate ?? 0;
  $('lang-voices').hidden=!project.voice.enabled;
  $('voice').value=project.voice.enabled?project.voice.provider+'|'+project.voice.name:'none';$('music').value=project.music.path || '';$('music-volume').value=project.music.volume;$('captions').checked=project.captions.enabled;if(project.captions.style)pintarEstiloSubs(project.captions.style);
  $('references').value=project.studio.references.map(r=>r.originalReference).join('\n');$('approve').checked=!!project.studio.approvedScriptHash;
  $('scenes').replaceChildren(...project.scenes.map((s,i)=>{
    const box=document.createElement('article');box.className='scene';box.dataset.id=s.id;const h=document.createElement('h3');h.textContent=`Escena ${i+1}`;
    const text=document.createElement('textarea');text.value=s.text;text.rows=3;text.dataset.field='text';text.oninput=()=>{$('approve').checked=false;};
    const duration=document.createElement('input');duration.type='number';duration.min='.5';duration.max='300';duration.step='.1';duration.value=s.duration;duration.dataset.field='duration';
    const visual=document.createElement('select');visual.dataset.field='assetPath';listOptions(visual,[['','Gráfico local de marca · ilustrativo'],...config.imports.filter(a=>a.kind!=='music').map(a=>[a.path,a.name+' · '+a.kind])]);visual.value=s.assetPath || '';
    const caption=document.createElement('textarea');caption.dataset.field='caption';caption.value=s.caption ?? s.text;caption.rows=2;
    const tag=document.createElement('p');tag.className='tag';tag.textContent=`Procedencia: ${s.provenance.kind} · ${s.provenance.originalReference || 'sin referencia'}`;
    const regenerate=document.createElement('button');regenerate.className='secondary';regenerate.textContent='Regenerar sólo esta escena';regenerate.dataset.regenerate=s.id;regenerate.onclick=()=>operate('scene',s.id).catch(e=>msg(e.message));
    const grid=document.createElement('div');grid.className='grid';grid.append(field('Duración (la voz puede ampliarla)',duration),field('Visual autorizado',visual));
    box.append(h,field('Texto narrado',text),grid,field('Subtítulo editable',caption),bloqueDestacado(s),tag,regenerate);return box;
  }));
  $('manifest').href=`/api/studio/projects/${project.id}/manifest`;displayJob();displayOutputs();
}
function payload(){const v=$('voice').value.split('|');return {revision:project.studio.revision,brand:$('edit-brand').value,aspectRatio:$('edit-format').value,style:$('style').value,language:$('edit-language').value,voice:{provider:v[0],name:v[1] || '',en:$('voice-en').value,es:$('voice-es').value,rate:Number($('voice-rate').value)},music:{path:$('music').value,volume:Number($('music-volume').value)},captions:$('captions').checked,approveScript:$('approve').checked,references:$('references').value.split('\n').map(s=>s.trim()).filter(Boolean).map(url=>({kind:url.includes('drive.google')?'drive':url.includes('github.com')?'github':'other',originalReference:url})),scenes:[...document.querySelectorAll('.scene')].map(box=>{
  const v={};for(const el of box.querySelectorAll('[data-field]'))v[el.dataset.field]=el.type==='checkbox'?el.checked:el.value;
  const titulo=String(v.onScreenTitle||'').trim();
  return {id:box.dataset.id,text:v.text,caption:v.caption,duration:Number(v.duration),assetPath:v.assetPath,
    // Los cinco campos del rótulo viajan siempre, también apagado: desactivar
    // no puede borrar el texto que la usuaria escribió.
    onScreenTitle:titulo,showOnScreenText:Boolean(v.showOnScreenText)&&Boolean(titulo),
    onScreenPosition:v.onScreenPosition,onScreenAnimation:v.onScreenAnimation,
    onScreenStyle:{size:v.onScreenSize,background:v.onScreenBackground,color:v.onScreenColor}};
}),captionStyle:leerEstiloSubs()};}
async function save(){project=await api('projects/'+project.id,'PATCH',payload());draw();msg('Ajustes guardados.');}
function displayJob(){const j=project.studio.job;const running=j?.status==='running';$('job').textContent=j?`${j.status} · ${j.message || j.action}${j.error?' · '+j.error:''}`:'';$('progress').value=j?.progress || 0;$('save').disabled=running;$('render').disabled=running;document.querySelectorAll('[data-regenerate]').forEach(b=>b.disabled=running);}
function displayOutputs(){const stale=project.studio.resultRevision!==project.studio.revision;const out=project.outputs[project.aspectRatio];$('preview-wrap').hidden=!out;if(out){$('preview-note').textContent=stale?'Esta versión es anterior a los ajustes. Genera el MP4 para actualizarlos.':'MP4 generado. Revisa voz, música y subtítulos antes de usarlo.';const url=fileUrl(out)+'&revision='+project.studio.resultRevision;if($('preview').getAttribute('src')!==url)$('preview').src=url;}
  $('downloads').replaceChildren(...(project.studio.export?.files || []).map(f=>{const a=document.createElement('a');a.textContent='Descargar '+f.format+(stale?' (versión anterior)':'');a.href=fileUrl(f.file)+'&download=1';return a;}));
  $('scene-preview-wrap').hidden=!project.studio.scenePreview;if(project.studio.scenePreview)$('scene-preview').src=fileUrl(project.studio.scenePreview)+'&revision='+project.studio.revision;
}
async function poll(){try{project=await api('projects/'+project.id);displayJob();if(project.studio.job.status==='running'){timer=setTimeout(poll,1000);return;}draw();msg(project.studio.job.error || 'Operación terminada. Revisa la previsualización.');}catch(e){msg(e.message);}}
async function open(id){clearTimeout(timer);project=await api('projects/'+id);localStorage.setItem('studioProject',id);draw();if(project.studio.job?.status==='running')poll();}
async function operate(action,sceneId){await save();project=await api('projects/'+project.id+'/run','POST',{action,sceneId});displayJob();msg('Procesando en este equipo…');poll();}
$('create-form').onsubmit=async e=>{e.preventDefault();try{project=await api('projects','POST',{title:$('title').value,script:$('script').value,brand:$('brand').value,template:$('template').value,language:$('language').value,aspectRatio:$('format').value});await init();await open(project.id);msg('Escenas creadas. Revisa y aprueba el guion antes de generar.');}catch(e){msg(e.message);}};
$('save').onclick=()=>save().catch(e=>msg(e.message));$('render').onclick=()=>operate('render').catch(e=>msg(e.message));
$('new').onclick=()=>{clearTimeout(timer);$('create').hidden=false;$('editor').hidden=true;};
$('import-form').onsubmit=e=>{e.preventDefault();const f=$('resource').files[0];if(!f || !$('authorized').checked)return;const xhr=new XMLHttpRequest();xhr.open('POST','/api/studio/import?'+new URLSearchParams({name:f.name,kind:$('resource-kind').value,reference:$('original-reference').value}));xhr.setRequestHeader('x-studio-request','1');xhr.setRequestHeader('x-resource-authorized','yes');xhr.upload.onprogress=e=>{if(e.lengthComputable)msg('Importando: '+Math.round(100*e.loaded/e.total)+'%');};xhr.onerror=()=>msg('Error al importar');xhr.onload=()=>{try{const a=JSON.parse(xhr.responseText);if(xhr.status!==201)throw Error(a.error);config.imports.push(a);const selectedMusic=$('music').value;refreshImports();$('music').value=selectedMusic;for(const select of document.querySelectorAll('[data-field=assetPath]'))if(a.kind!=='music')select.append(option(a.path,a.name+' · '+a.kind));msg('Copia importada; referencia original conservada.');$('authorized').checked=false;}catch(e){msg(e.message);}};xhr.send(f);};
try{await init();const last=localStorage.getItem('studioProject');if(last)await open(last);}catch(e){msg(e.message);}
