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
const frameText=e=>e.frame===null||e.frame===undefined?'—':(e.frameExact?'':'~')+e.frame;
function rows(target,list,build,empty){
  const fragment=document.createDocumentFragment();
  for(const item of list){const tr=document.createElement('tr');for(const cell of build(item)){const td=document.createElement('td');
    if(cell instanceof Node)td.append(cell);else td.textContent=cell;tr.append(td);}fragment.append(tr);}
  if(!list.length){const tr=document.createElement('tr');const td=document.createElement('td');td.colSpan=6;td.textContent=empty;tr.append(td);fragment.append(tr);}
  $(target).replaceChildren(fragment);
}
function seek(timestamp){const b=document.createElement('button');b.textContent=timestamp.toFixed(3);
  b.onclick=()=>{$('preview').currentTime=timestamp;$('preview').pause();};return b;}
function renderRhythm(local){
  const t=local.tempo;
  $('tempo').textContent=t
    ? `Tempo inferido ${t.bpm.toFixed(2)} BPM (periodo ${t.period.toFixed(4)} s) · ${local.beats.length} beats en la rejilla · fuerza vectorial ${t.vectorStrength.toFixed(2)}, respaldo ${t.support.toFixed(2)}, puntuación ${t.score.toFixed(2)} (sin calibrar, no es probabilidad) · ${t.onsetsUsed} onsets en ${t.spanSeconds.toFixed(2)} s · tolerancia ${(t.toleranceSeconds*1000).toFixed(0)} ms. Rejilla isócrona única: no sigue cambios de tempo.`
    : `Sin rejilla rítmica. ${local.tempoReason || ''}`;
  const s=local.sync || {};
  $('sync').textContent=s.status==='sincronizado'||s.status==='parcial'||s.status==='no-sincronizado'
    ? `Sincronía cortes↔beats: ${s.status} · ${s.onBeat}/${s.cuts} cortes visuales dentro de ${(s.toleranceSeconds*1000).toFixed(0)} ms de un beat (${(s.ratio*100).toFixed(0)} %) · desvío absoluto mediano ${(s.medianAbsDeltaSeconds*1000).toFixed(0)} ms, desvío medio con signo ${(s.meanSignedDeltaSeconds*1000).toFixed(0)} ms · reparto mod 4 [${(s.beatPositionsMod4||[]).join(', ')}]. ${s.note||''}`
    : `Sincronía no descrita: ${s.reason || 'sin datos'}`;
  $('rampnote').textContent=local.ramps?.length
    ? 'Propuestas calculadas para que cada segmento dure un número entero de beats. No se ha renderizado ni validado ninguna; el factor es el cambio de velocidad de reproducción y setpts su multiplicador para FFmpeg.'
    : `Sin rampas propuestas. ${local.rampReason || ''}`;
  rows('ramps',local.ramps||[],r=>[seek(r.start),`${r.startFrame} → ${r.endFrame} (${r.currentFrames} → ${r.targetFrames})`,
    `${r.currentDuration.toFixed(3)} s → ${r.targetDuration.toFixed(3)} s (${r.deltaSeconds>0?'+':''}${(r.deltaSeconds*1000).toFixed(0)} ms)`,
    `${r.speedFactor.toFixed(4)}× (${r.direction}) · setpts ${r.setptsFactor.toFixed(4)}`,r.reason],
    'No se proponen rampas de velocidad.');
}
function render(j){
  $('result').hidden=false;
  if(j.previewReady && !$('preview').getAttribute('src'))$('preview').src=`/api/analysis/${j.id}/preview`;
  $('metadata').textContent=j.metadata?`Duración ${j.metadata.duration.toFixed(3)} s · FPS promedio ${j.metadata.fps.toFixed(3)} (nominal ${j.metadata.nominalFps.toFixed(3)}, ${j.metadata.frameRateMode.toUpperCase()}) · códec ${j.metadata.codec} · ${j.metadata.width} × ${j.metadata.height} · ${j.metadata.audio.length} pistas de audio (se analiza la primera).`:'';
  $('notes').textContent=(j.local?.notes || []).join(' ');
  renderRhythm(j.local || {});
  $('interpretation').textContent=`Gemini: ${j.gemini.status}. ${j.gemini.error || j.gemini.reason || ''}\n`+(j.gemini.segments || []).map(s=>`${s.start}s: ${s.summary || ''}\nModelo ${s.model}, FPS solicitados ${s.requestedFps}; consumo ${JSON.stringify(s.usage)}; ${s.elapsedMs} ms`).join('\n');
  $('json').href=`/api/analysis/${j.id}/export`;$('csv').href=`/api/analysis/${j.id}/export?format=csv`;
  rows('cuts',j.cuts,c=>[seek(c.timestamp),frameText(c),c.source,c.reason,JSON.stringify(c.evidence),c.confidence ?? 'Sin calibrar'],
    'No se detectaron candidatos de corte.');
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
