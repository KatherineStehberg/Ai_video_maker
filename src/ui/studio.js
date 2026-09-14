const $=id=>document.getElementById(id);let config,project,timer;
const msg=text=>{$('message').textContent=text || '';};
async function api(url,method='GET',data){const r=await fetch('/api/studio/'+url,{method,headers:{'content-type':'application/json','x-studio-request':'1'},...(data?{body:JSON.stringify(data)}:{})});const b=await r.json();if(!r.ok)throw Error(b.error);return b;}
const option=(value,text)=>{const o=document.createElement('option');o.value=value;o.textContent=text;return o;};
const fileUrl=p=>'/file?path='+encodeURIComponent(p);
function listOptions(el,items){el.replaceChildren(...items.map(([v,t])=>option(v,t)));}
async function init(){config=await api('config');for(const id of ['brand','edit-brand'])listOptions($(id),config.brands.map(b=>[b.id,b.name]));$('brand').value='personal';listOptions($('template'),config.templates.map(t=>[t.id,t.name]));for(const id of ['format','edit-format'])listOptions($(id),Object.entries(config.aspects).map(([id,a])=>[id,id+' · '+a.label]));$('format').value='9:16';
  listOptions($('voice'),[['none','Sin narración (explícito)'],...config.voices.map(v=>[v.provider+'|'+v.name,v.name+' · '+v.language])]);
  $('voice-note').textContent=config.voices.length?'La voz se genera en el backend. Zira es inglesa: pronunciación española provisional.':'No hay voz local disponible. Configura SAPI/Piper; elegir sin narración produce un video silencioso o sólo con música.';
  $('projects').replaceChildren(...config.projects.map(p=>{const b=document.createElement('button');b.textContent=p.title+' · '+p.status;b.onclick=()=>open(p.id).catch(e=>msg(e.message));return b;}));refreshImports();}
function refreshImports(){listOptions($('music'),[['','Sin música'],...config.imports.filter(a=>a.kind==='music').map(a=>[a.path,a.name])]);$('resources').replaceChildren(...config.imports.map(a=>{const li=document.createElement('li');li.textContent=`${a.name} · ${a.kind} · ${a.originalReference}`;return li;}));}
function field(label,element){const l=document.createElement('label');l.append(document.createTextNode(label),element);return l;}
function draw(){
  $('create').hidden=true;$('editor').hidden=false;$('project-title').textContent=project.title;$('project-state').textContent=project.status;
  $('edit-brand').value=project.brand;$('edit-format').value=project.aspectRatio;$('style').value=project.studio.style;
  $('voice').value=project.voice.enabled?project.voice.provider+'|'+project.voice.name:'none';$('music').value=project.music.path || '';$('music-volume').value=project.music.volume;$('captions').checked=project.captions.enabled;
  $('references').value=project.studio.references.map(r=>r.originalReference).join('\n');$('approve').checked=!!project.studio.approvedScriptHash;
  $('scenes').replaceChildren(...project.scenes.map((s,i)=>{
    const box=document.createElement('article');box.className='scene';box.dataset.id=s.id;const h=document.createElement('h3');h.textContent=`Escena ${i+1}`;
    const text=document.createElement('textarea');text.value=s.text;text.rows=3;text.dataset.field='text';text.oninput=()=>{$('approve').checked=false;};
    const title=document.createElement('input');title.value=s.onScreenTitle;title.dataset.field='onScreenTitle';
    const duration=document.createElement('input');duration.type='number';duration.min='.5';duration.max='300';duration.step='.1';duration.value=s.duration;duration.dataset.field='duration';
    const visual=document.createElement('select');visual.dataset.field='assetPath';listOptions(visual,[['','Gráfico local de marca · ilustrativo'],...config.imports.filter(a=>a.kind!=='music').map(a=>[a.path,a.name+' · '+a.kind])]);visual.value=s.assetPath || '';
    const caption=document.createElement('textarea');caption.dataset.field='caption';caption.value=s.caption ?? s.text;caption.rows=2;
    const tag=document.createElement('p');tag.className='tag';tag.textContent=`Procedencia: ${s.provenance.kind} · ${s.provenance.originalReference || 'sin referencia'}`;
    const regenerate=document.createElement('button');regenerate.className='secondary';regenerate.textContent='Regenerar sólo esta escena';regenerate.dataset.regenerate=s.id;regenerate.onclick=()=>operate('scene',s.id).catch(e=>msg(e.message));
    const grid=document.createElement('div');grid.className='grid';grid.append(field('Título visual',title),field('Duración (la voz puede ampliarla)',duration),field('Visual autorizado',visual));
    box.append(h,field('Texto narrado',text),grid,field('Subtítulo editable',caption),tag,regenerate);return box;
  }));
  $('manifest').href=`/api/studio/projects/${project.id}/manifest`;displayJob();displayOutputs();
}
function payload(){const v=$('voice').value.split('|');return {revision:project.studio.revision,brand:$('edit-brand').value,aspectRatio:$('edit-format').value,style:$('style').value,voice:{provider:v[0],name:v[1] || ''},music:{path:$('music').value,volume:Number($('music-volume').value)},captions:$('captions').checked,approveScript:$('approve').checked,references:$('references').value.split('\n').map(s=>s.trim()).filter(Boolean).map(url=>({kind:url.includes('drive.google')?'drive':url.includes('github.com')?'github':'other',originalReference:url})),scenes:[...document.querySelectorAll('.scene')].map(box=>Object.fromEntries([['id',box.dataset.id],...[...box.querySelectorAll('[data-field]')].map(el=>[el.dataset.field,el.dataset.field==='duration'?Number(el.value):el.value])]))};}
async function save(){project=await api('projects/'+project.id,'PATCH',payload());draw();msg('Ajustes guardados.');}
function displayJob(){const j=project.studio.job;const running=j?.status==='running';$('job').textContent=j?`${j.status} · ${j.message || j.action}${j.error?' · '+j.error:''}`:'';$('progress').value=j?.progress || 0;$('save').disabled=running;$('render').disabled=running;document.querySelectorAll('[data-regenerate]').forEach(b=>b.disabled=running);}
function displayOutputs(){const stale=project.studio.resultRevision!==project.studio.revision;const out=project.outputs[project.aspectRatio];$('preview-wrap').hidden=!out;if(out){$('preview-note').textContent=stale?'Esta versión es anterior a los ajustes. Genera el MP4 para actualizarlos.':'MP4 generado. Revisa voz, música y subtítulos antes de usarlo.';const url=fileUrl(out)+'&revision='+project.studio.resultRevision;if($('preview').getAttribute('src')!==url)$('preview').src=url;}
  $('downloads').replaceChildren(...(project.studio.export?.files || []).map(f=>{const a=document.createElement('a');a.textContent='Descargar '+f.format+(stale?' (versión anterior)':'');a.href=fileUrl(f.file)+'&download=1';return a;}));
  $('scene-preview-wrap').hidden=!project.studio.scenePreview;if(project.studio.scenePreview)$('scene-preview').src=fileUrl(project.studio.scenePreview)+'&revision='+project.studio.revision;
}
async function poll(){try{project=await api('projects/'+project.id);displayJob();if(project.studio.job.status==='running'){timer=setTimeout(poll,1000);return;}draw();msg(project.studio.job.error || 'Operación terminada. Revisa la previsualización.');}catch(e){msg(e.message);}}
async function open(id){clearTimeout(timer);project=await api('projects/'+id);localStorage.setItem('studioProject',id);draw();if(project.studio.job?.status==='running')poll();}
async function operate(action,sceneId){await save();project=await api('projects/'+project.id+'/run','POST',{action,sceneId});displayJob();msg('Procesando en este equipo…');poll();}
$('create-form').onsubmit=async e=>{e.preventDefault();try{project=await api('projects','POST',{title:$('title').value,script:$('script').value,brand:$('brand').value,template:$('template').value,aspectRatio:$('format').value});await init();await open(project.id);msg('Escenas creadas. Revisa y aprueba el guion antes de generar.');}catch(e){msg(e.message);}};
$('save').onclick=()=>save().catch(e=>msg(e.message));$('render').onclick=()=>operate('render').catch(e=>msg(e.message));
$('new').onclick=()=>{clearTimeout(timer);$('create').hidden=false;$('editor').hidden=true;};
$('import-form').onsubmit=e=>{e.preventDefault();const f=$('resource').files[0];if(!f || !$('authorized').checked)return;const xhr=new XMLHttpRequest();xhr.open('POST','/api/studio/import?'+new URLSearchParams({name:f.name,kind:$('resource-kind').value,reference:$('original-reference').value}));xhr.setRequestHeader('x-studio-request','1');xhr.setRequestHeader('x-resource-authorized','yes');xhr.upload.onprogress=e=>{if(e.lengthComputable)msg('Importando: '+Math.round(100*e.loaded/e.total)+'%');};xhr.onerror=()=>msg('Error al importar');xhr.onload=()=>{try{const a=JSON.parse(xhr.responseText);if(xhr.status!==201)throw Error(a.error);config.imports.push(a);const selectedMusic=$('music').value;refreshImports();$('music').value=selectedMusic;for(const select of document.querySelectorAll('[data-field=assetPath]'))if(a.kind!=='music')select.append(option(a.path,a.name+' · '+a.kind));msg('Copia importada; referencia original conservada.');$('authorized').checked=false;}catch(e){msg(e.message);}};xhr.send(f);};
try{await init();const last=localStorage.getItem('studioProject');if(last)await open(last);}catch(e){msg(e.message);}
