const $=id=>document.getElementById(id);
let current=null;
const status=message=>{$('status').textContent=message;};
try {
  const r=await fetch('/api/analysis/config');const c=await r.json();if(!r.ok)throw Error(c.error);
  $('gemini').disabled=!c.hasKey;
  $('config').textContent=`${c.hasKey?'Gemini disponible':'Sin clave Gemini: sólo análisis local, sin interpretación visual/musical ni sugerencias semánticas'}. Modelo: ${c.model}. Muestreo solicitado: ${c.requestedFps} FPS. Segmentos: ${c.segmentSeconds} s.`;
}catch(e){status(e.message);}
$('gemini').onchange=()=>{$('disclosure').hidden=!$('gemini').checked;$('consent').checked=false;};
$('file').onchange=()=>{$('consent').checked=false;};
function render(j){
  $('result').hidden=false;
  if(j.previewReady && !$('preview').getAttribute('src'))$('preview').src=`/api/analysis/${j.id}/preview`;
  $('metadata').textContent=j.metadata?`Duración ${j.metadata.duration.toFixed(3)} s · FPS promedio ${j.metadata.fps.toFixed(3)} · ${j.metadata.width} × ${j.metadata.height} · ${j.metadata.audio.length} pistas de audio (se analiza la primera).`:'';
  $('notes').textContent=(j.local?.notes || []).join(' ');
  $('interpretation').textContent=`Gemini: ${j.gemini.status}. ${j.gemini.error || j.gemini.reason || ''}\n`+(j.gemini.segments || []).map(s=>`${s.start}s: ${s.summary || ''}\nModelo ${s.model}, FPS solicitados ${s.requestedFps}; consumo ${JSON.stringify(s.usage)}; ${s.elapsedMs} ms`).join('\n');
  $('json').href=`/api/analysis/${j.id}/export`;$('csv').href=`/api/analysis/${j.id}/export?format=csv`;
  const fragment=document.createDocumentFragment();
  for(const c of j.cuts){const tr=document.createElement('tr');const td=document.createElement('td');const b=document.createElement('button');b.textContent=c.timestamp.toFixed(3);b.onclick=()=>{$('preview').currentTime=c.timestamp;$('preview').pause();};td.append(b);tr.append(td);
    for(const text of [c.source,c.reason,JSON.stringify(c.evidence),c.confidence ?? 'Sin calibrar']){const cell=document.createElement('td');cell.textContent=text;tr.append(cell);}fragment.append(tr);}
  if(!j.cuts.length){const tr=document.createElement('tr');const td=document.createElement('td');td.colSpan=5;td.textContent='No se detectaron candidatos de corte.';tr.append(td);fragment.append(tr);}
  $('cuts').replaceChildren(fragment);
}
async function poll(){
  try{const r=await fetch(`/api/analysis/${current}`);const j=await r.json();if(!r.ok)throw Error(j.error);$('progress').value=j.progress;status(j.error || `${j.stage} · ${j.progress.toFixed(0)}%`);
    if(j.status==='running'){setTimeout(poll,1000);return;}render(j);$('submit').disabled=false;
  }catch(e){status(`Error consultando análisis: ${e.message}. Recarga la página para recuperar el resultado.`);$('submit').disabled=false;}
}
$('form').onsubmit=event=>{
  event.preventDefault();const file=$('file').files[0];const external=$('gemini').checked;
  if(!file || file.size>2*1024**3){status('Selecciona un video de hasta 2 GiB');return;}
  if(external && !$('consent').checked){status('Confirma el envío externo antes de continuar.');return;}
  $('submit').disabled=true;$('result').hidden=true;$('preview').removeAttribute('src');
  const xhr=new XMLHttpRequest();xhr.open('POST',`/api/analysis?gemini=${external}`);xhr.setRequestHeader('x-analysis-upload','1');if(external)xhr.setRequestHeader('x-gemini-consent','yes');
  xhr.upload.onprogress=e=>{if(e.lengthComputable){$('progress').value=e.loaded/e.total*100;status(`Cargando al backend local: ${Math.round(e.loaded/e.total*100)}%`);}};
  xhr.onerror=()=>{status('Error de conexión durante la subida');$('submit').disabled=false;};
  xhr.onload=()=>{try{const j=JSON.parse(xhr.responseText);if(xhr.status!==202)throw Error(j.error);current=j.id;localStorage.setItem('analysisId',current);poll();}catch(e){status(e.message);$('submit').disabled=false;}};
  xhr.send(file);
};
current=localStorage.getItem('analysisId');if(current)poll();
