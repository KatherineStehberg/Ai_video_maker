/**
 * Orquestador de la interfaz: une estado, API, timeline, segmentos,
 * reproductores y mensajes.
 *
 * Separación de responsabilidades (no la mezcles al editar):
 *   api.js       -> todo lo que habla con el backend
 *   state.js     -> qué se puede hacer en cada momento (sin DOM)
 *   format.js    -> convertir datos en texto legible (sin DOM)
 *   timeline.js  -> dibujar la línea de tiempo
 *   segments.js  -> dibujar y leer el panel de segmentos
 *   messages.js  -> estado, errores y advertencias
 *   main.js      -> este archivo: sólo coordina
 *
 * Aquí NO hay lógica de FFmpeg ni de análisis: todo eso vive en el backend.
 */
import { createApi, uploadVideo, poll, ApiError } from './api.js';
import { initialState, reduce, canAnalyze, canPropose, canApprove, canExport, exportBlockedReason } from './state.js';
import { fileSummary, rhythmSummary, collectWarnings, summaryCards, proposalHeadline, seconds, frame, rampRow } from './format.js';
import { renderTimeline } from './timeline.js';
import { renderSegments, readSegments, validateSelection, hasChanges } from './segments.js';
import { createMessages } from './messages.js';
import { createPlayer } from './player.js';

const $ = id => document.getElementById(id);
const api = createApi();
let state = initialState();
let analysisPoll = null;
let pendingSegments = null;   // selección del panel aún sin aplicar

const messages = createMessages({ statusEl: $('status'), stateEl: $('state-pill'), errorEl: $('error'), warningsEl: $('warnings') });
const sourcePlayer = createPlayer($('source-player'), { emptyEl: $('source-empty') });
const exportPlayer = createPlayer($('export-player'), { emptyEl: $('export-empty') });

/** Única puerta de entrada al estado: reduce y repinta. */
function dispatch(action) {
  state = reduce(state, action);
  render();
}

// ============================================================ PINTADO

function render() {
  messages.setState(state.state);
  messages.setError(state.error);
  $('progress').value = state.progress || 0;
  $('progress').classList.toggle('trabajando', state.busy);

  $('btn-analyze').disabled = !canAnalyze(state);
  $('btn-propose').disabled = !canPropose(state);
  $('btn-approve').disabled = !canApprove(state);
  $('btn-export').disabled = !canExport(state);
  $('export-blocked').textContent = exportBlockedReason(state) || '';

  renderSteps();
  renderFacts();
  renderSummary();
  renderTables();
  messages.setWarnings(collectWarnings(state.proposal, state.exportResult));
  renderTimeline($('timeline'), state.analysis, state.proposal, { onSeek: t => sourcePlayer.seek(t) });
  renderDownloads();
}

/** Marca los 5 pasos de la cabecera según dónde estamos. */
function renderSteps() {
  const hecho = {
    video: Boolean(state.file) && !state.error,
    analisis: state.analysis?.status === 'complete',
    propuesta: Boolean(state.proposal),
    aprobacion: Boolean(state.proposal) && (!state.proposal.approvalRequired || state.proposal.approval?.status === 'aprobada'),
    exportacion: Boolean(state.exportResult),
  };
  const activo = {
    listo: 'video', cargando: 'video',
    analizando: 'analisis', 'analisis-completado': 'propuesta',
    'creando-propuesta': 'propuesta', 'aprobacion-pendiente': 'aprobacion',
    aprobado: 'exportacion', exportando: 'exportacion', exportado: 'exportacion',
  }[state.state];

  for (const li of $('pasos').querySelectorAll('.paso')) {
    const paso = li.dataset.paso;
    li.dataset.hecho = hecho[paso] ? 'si' : 'no';
    li.dataset.activo = !hecho[paso] && paso === activo ? 'si' : 'no';
    li.dataset.error = state.state === 'error' && paso === activo ? 'si' : 'no';
  }
}

function renderFacts() {
  const fragment = document.createDocumentFragment();
  for (const [clave, valor] of fileSummary(state.file, state.analysis?.metadata)) {
    const dt = document.createElement('dt'); dt.textContent = clave;
    const dd = document.createElement('dd'); dd.textContent = valor;
    fragment.append(dt, dd);
  }
  $('file-facts').replaceChildren(fragment);

  const ritmo = rhythmSummary(state.analysis?.local);
  $('tempo-summary').textContent = ritmo.tempo;
  $('sync-summary').textContent = ritmo.sync;
}

function renderSummary() {
  const fragment = document.createDocumentFragment();
  for (const card of summaryCards(state.analysis, state.proposal)) {
    const caja = document.createElement('div');
    caja.className = 'resumen-dato';
    const valor = document.createElement('div'); valor.className = 'resumen-valor'; valor.textContent = card.valor;
    const etiqueta = document.createElement('div'); etiqueta.textContent = card.etiqueta;
    const detalle = document.createElement('div'); detalle.className = 'resumen-detalle'; detalle.textContent = card.detalle;
    caja.append(valor, etiqueta, detalle);
    fragment.append(caja);
  }
  if (!fragment.childNodes.length) {
    const vacio = document.createElement('p');
    vacio.className = 'texto-ayuda';
    vacio.textContent = 'Analiza un video para ver aquí sus datos principales.';
    fragment.append(vacio);
  }
  $('resumen').replaceChildren(fragment);
  $('proposal-summary').textContent = proposalHeadline(state.proposal);

  const p = state.proposal;
  $('approval-hint').textContent = !p
    ? 'Primero crea una propuesta.'
    : (!p.approvalRequired || p.approval?.status === 'aprobada')
      ? 'Propuesta aprobada. Ya puedes exportar.'
      : 'Revisa la línea de tiempo y las advertencias antes de aprobar.';

  // Panel de segmentos: sólo cuando hay propuesta.
  $('segments-card').hidden = !p;
  if (p && !pendingSegments) {
    renderSegments($('segments-list'), p, { onChange: onSegmentsChanged });
    // Se lee la selección recién dibujada: partir de [] haría creer que el
    // usuario ha quitado todos los trozos antes de tocar nada.
    updateSegmentButtons(readSegments($('segments-list')));
  }
}

function celda(fila, texto) { const td = document.createElement('td'); td.textContent = texto; fila.append(td); }

function renderTables() {
  const cuts = state.analysis?.cuts || [];
  $('cuts-count').textContent = String(cuts.length);
  const cuerpoCortes = document.createDocumentFragment();
  for (const c of cuts) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    const boton = document.createElement('button');
    boton.type = 'button'; boton.className = 'enlace-tiempo';
    boton.textContent = c.timestamp.toFixed(3);
    boton.addEventListener('click', () => sourcePlayer.seek(c.timestamp));
    td.append(boton); tr.append(td);
    celda(tr, frame(c)); celda(tr, c.source); celda(tr, c.reason);
    cuerpoCortes.append(tr);
  }
  $('cuts-body').replaceChildren(cuerpoCortes);

  const ramps = state.analysis?.local?.ramps || [];
  $('ramps-count').textContent = String(ramps.length);
  const cuerpoRampas = document.createDocumentFragment();
  for (const r of ramps) {
    const tr = document.createElement('tr');
    const vista = rampRow(r);
    for (const clave of ['segmento', 'frames', 'duracion', 'factor', 'motivo']) celda(tr, vista[clave]);
    cuerpoRampas.append(tr);
  }
  $('ramps-body').replaceChildren(cuerpoRampas);
}

function renderDownloads() {
  const caja = $('downloads');
  caja.replaceChildren();
  if (!state.analysisId) {
    const vacio = document.createElement('p');
    vacio.className = 'texto-ayuda';
    vacio.textContent = 'Disponibles tras el análisis.';
    caja.append(vacio);
    return;
  }
  if (state.exportResult && state.proposal) {
    const mp4 = enlace(api.exportedFileUrl(state.proposal.id), 'Descargar video MP4');
    mp4.setAttribute('download', '');
    mp4.classList.add('descarga-principal');
    caja.append(mp4);
  }
  caja.append(enlace(api.analysisJsonUrl(state.analysisId), 'Datos del análisis (JSON)'));
  caja.append(enlace(api.analysisCsvUrl(state.analysisId), 'Lista de cortes (CSV)'));
}

function enlace(href, texto) {
  const a = document.createElement('a');
  a.href = href; a.textContent = texto; a.className = 'descarga';
  return a;
}

// ==================================================== SEGMENTOS EDITABLES

function onSegmentsChanged(segments) {
  pendingSegments = segments;
  updateSegmentButtons(segments);
}

function updateSegmentButtons(segments) {
  const cambiado = hasChanges(segments, state.proposal);
  const problema = cambiado ? validateSelection(segments) : null;
  $('btn-apply-segments').disabled = !cambiado || Boolean(problema) || state.busy;
  $('btn-reset-segments').disabled = !cambiado || state.busy;
  $('segments-note').textContent = problema
    ? problema
    : cambiado
      ? 'Al aplicar los cambios tendrás que aprobar de nuevo.'
      : 'Desmarca lo que no quieras o cambia la velocidad de un trozo.';
}

$('btn-apply-segments').addEventListener('click', async () => {
  const segments = readSegments($('segments-list'));
  const problema = validateSelection(segments);
  if (problema) { messages.setError(problema); return; }
  messages.setStatus('Guardando los cambios del montaje…');
  try {
    const proposal = await api.updateSegments(state.proposal.id, segments);
    pendingSegments = null;
    dispatch({ type: 'proposal-ready', proposal });
    exportPlayer.clear();
    messages.setStatus('Montaje actualizado. Apruébalo de nuevo para poder exportar.');
  } catch (e) {
    dispatch({ type: 'error', error: e.message });
  }
});

$('btn-reset-segments').addEventListener('click', () => {
  pendingSegments = null;
  renderSegments($('segments-list'), state.proposal, { onChange: onSegmentsChanged });
  updateSegmentButtons(readSegments($('segments-list')));
  messages.setStatus('Cambios descartados.');
});

// ============================================================ ACCIONES

$('file').addEventListener('change', event => {
  analysisPoll?.stop();
  sourcePlayer.clear(); exportPlayer.clear();
  pendingSegments = null;
  const file = event.target.files[0];
  $('file-label').textContent = file ? file.name : 'Elige un video MP4';
  dispatch({ type: 'file-selected', file });
  if (file) messages.setStatus('Video listo. Pulsa «Analizar video».');
});

$('btn-analyze').addEventListener('click', async () => {
  if (!canAnalyze(state)) return;
  dispatch({ type: 'upload-start' });
  try {
    const job = await uploadVideo(state.file, {
      onProgress: percent => { dispatch({ type: 'upload-progress', percent }); messages.setStatus(`Cargando el video: ${percent.toFixed(0)} %`); },
    });
    dispatch({ type: 'analysis-start', id: job.id });
    analysisPoll?.stop();
    // Sondeo: nunca dos peticiones a la vez, y se cancela al cambiar de archivo.
    analysisPoll = poll(() => api.getAnalysis(job.id), {
      intervalMs: 900,
      isDone: j => j.status !== 'running',
      onTick: j => {
        dispatch({ type: 'analysis-progress', progress: j.progress, stage: j.stage });
        messages.setStatus(`${j.stage || 'Analizando'} · ${(j.progress || 0).toFixed(0)} %`);
      },
    });
    const finished = await analysisPoll.done;
    if (finished.status !== 'complete') throw new ApiError(finished.error || `El análisis terminó en estado ${finished.status}`, 0);
    dispatch({ type: 'analysis-complete', analysis: finished });
    sourcePlayer.load(api.previewUrl(finished.id));
    messages.setStatus('Análisis listo. Elige cómo quieres el montaje y crea la propuesta.');
  } catch (e) {
    dispatch({ type: 'error', error: e.message });
  }
});

$('btn-propose').addEventListener('click', async () => {
  if (!canPropose(state)) return;
  pendingSegments = null;
  dispatch({ type: 'proposal-start' });
  messages.setStatus('Preparando la propuesta de montaje…');
  try {
    const raw = $('target-duration').value.trim();
    const proposal = await api.createProposal({
      videoJobId: state.analysisId,
      format: $('format').value,
      targetDuration: raw === '' ? null : Number(raw),
      syncMode: $('sync-mode').value,
      enableSpeedRamps: $('ramps').checked,
      approvalRequired: true,
    });
    dispatch({ type: 'proposal-ready', proposal });
    messages.setStatus('Propuesta lista. Revísala y apruébala para exportar.');
  } catch (e) {
    dispatch({ type: 'error', error: e.message });
  }
});

$('btn-approve').addEventListener('click', async () => {
  if (!canApprove(state)) return;
  try {
    const proposal = await api.approveProposal(state.proposal.id, 'editor-web');
    dispatch({ type: 'approved', proposal });
    messages.setStatus('Edición aprobada. Ya puedes exportar el MP4.');
  } catch (e) {
    dispatch({ type: 'error', error: e.message });
  }
});

$('btn-export').addEventListener('click', async () => {
  // El guardia de estado ya deshabilita el botón, pero un doble clic rápido no
  // debe llegar nunca a lanzar dos exportaciones.
  if (!canExport(state)) return;
  dispatch({ type: 'export-start' });
  const inicio = Date.now();
  messages.setStatus('Exportando el video. Puede tardar; no cierres la pestaña.');
  const reloj = setInterval(() => messages.setStatus(`Exportando el video… ${Math.round((Date.now() - inicio) / 1000)} s`), 1000);
  try {
    const result = await api.exportProposal(state.proposal.id, $('fit').value);
    dispatch({ type: 'export-complete', result });
    exportPlayer.load(api.exportedFileUrl(state.proposal.id));
    const m = result.export.measured;
    messages.setStatus(`Listo: ${m.width}×${m.height} · ${m.duration.toFixed(1)} s · ${m.audioTracks ? 'con audio' : 'sin audio'}. Ya puedes descargarlo.`);
  } catch (e) {
    dispatch({ type: 'error', error: e.message });
  } finally {
    clearInterval(reloj);
  }
});

// ============================================================ ARRANQUE

try {
  const config = await api.analysisConfig();
  // Sólo se recibe disponibilidad; la clave nunca sale del backend.
  $('config-hint').textContent = config.hasKey
    ? 'Todo se procesa en este equipo. La descripción con IA está en «Análisis avanzado».'
    : 'Todo se procesa en este equipo y sin coste.';
} catch (e) {
  $('config-hint').textContent = `No se pudo conectar con el servidor: ${e.message}`;
}

render();
