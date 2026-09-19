/**
 * Orquestador de la interfaz: une estado, API, timeline, reproductores y
 * mensajes. No contiene lógica de FFmpeg ni de análisis; sólo llama al backend.
 */
import { createApi, uploadVideo, poll, ApiError } from './api.js';
import { initialState, reduce, canAnalyze, canPropose, canApprove, canExport, exportBlockedReason } from './state.js';
import { fileSummary, rhythmSummary, collectWarnings, SYNC_STATUS_TEXT, seconds, frame, rampRow } from './format.js';
import { renderTimeline } from './timeline.js';
import { createMessages } from './messages.js';
import { createPlayer } from './player.js';

const $ = id => document.getElementById(id);
const api = createApi();
let state = initialState();
let analysisPoll = null;

const messages = createMessages({ statusEl: $('status'), stateEl: $('state-pill'), errorEl: $('error'), warningsEl: $('warnings') });
const sourcePlayer = createPlayer($('source-player'), { emptyEl: $('source-empty') });
const exportPlayer = createPlayer($('export-player'), { emptyEl: $('export-empty') });

/** Única puerta de entrada al estado: reduce y repinta. */
function dispatch(action) {
  state = reduce(state, action);
  render();
}

// ---------------------------------------------------------------- pintado

function render() {
  messages.setState(state.state);
  messages.setError(state.error);
  $('progress').value = state.progress || 0;

  $('btn-analyze').disabled = !canAnalyze(state);
  $('btn-propose').disabled = !canPropose(state);
  $('btn-approve').disabled = !canApprove(state);
  $('btn-export').disabled = !canExport(state);
  $('export-blocked').textContent = exportBlockedReason(state) || '';

  renderFacts();
  renderProposal();
  renderTables();
  messages.setWarnings(collectWarnings(state.proposal, state.exportResult));
  renderTimeline($('timeline'), state.analysis, state.proposal, { onSeek: t => sourcePlayer.seek(t) });
  renderDownloads();
}

function renderFacts() {
  const rows = fileSummary(state.file, state.analysis?.metadata);
  const fragment = document.createDocumentFragment();
  for (const [key, value] of rows) {
    const dt = document.createElement('dt'); dt.textContent = key;
    const dd = document.createElement('dd'); dd.textContent = value;
    fragment.append(dt, dd);
  }
  $('file-facts').replaceChildren(fragment);

  const rhythm = rhythmSummary(state.analysis?.local);
  $('tempo-summary').textContent = rhythm.tempo;
  $('sync-summary').textContent = rhythm.sync;
}

function renderProposal() {
  const p = state.proposal;
  if (!p) { $('proposal-summary').textContent = 'Sin propuesta.'; $('approval-hint').textContent = 'La exportación está bloqueada hasta que apruebes una propuesta.'; return; }
  const approved = !p.approvalRequired || p.approval?.status === 'aprobada';
  $('proposal-summary').textContent =
    `${p.format} · ${p.dimensions.width}×${p.dimensions.height} · ${p.segments.length} segmentos · duración estimada ${seconds(p.estimatedDuration)}\n` +
    (SYNC_STATUS_TEXT[p.syncStatus] || p.syncStatus);
  $('approval-hint').textContent = approved
    ? (p.approvalRequired ? `Aprobada por ${p.approval.by || 'local'}.` : 'Esta propuesta no requiere aprobación.')
    : 'Revisa la timeline y las advertencias antes de aprobar.';
}

function cell(row, text) { const td = document.createElement('td'); td.textContent = text; row.append(td); }

function renderTables() {
  const cuts = state.analysis?.cuts || [];
  $('cuts-count').textContent = String(cuts.length);
  const cutsBody = document.createDocumentFragment();
  for (const c of cuts) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'link';
    button.textContent = c.timestamp.toFixed(3);
    button.addEventListener('click', () => sourcePlayer.seek(c.timestamp));
    td.append(button); tr.append(td);
    cell(tr, frame(c)); cell(tr, c.source); cell(tr, c.reason);
    cutsBody.append(tr);
  }
  $('cuts-body').replaceChildren(cutsBody);

  const ramps = state.analysis?.local?.ramps || [];
  $('ramps-count').textContent = String(ramps.length);
  const rampsBody = document.createDocumentFragment();
  for (const r of ramps) {
    const tr = document.createElement('tr');
    const view = rampRow(r);
    for (const key of ['segmento', 'frames', 'duracion', 'factor', 'motivo']) cell(tr, view[key]);
    rampsBody.append(tr);
  }
  $('ramps-body').replaceChildren(rampsBody);

  const segments = state.proposal?.segments || [];
  $('segments-count').textContent = String(segments.length);
  const segmentsBody = document.createDocumentFragment();
  segments.forEach((s, i) => {
    const tr = document.createElement('tr');
    cell(tr, String(i + 1));
    cell(tr, `${s.sourceStart.toFixed(3)} – ${s.sourceEnd.toFixed(3)} s`);
    cell(tr, `${s.start.toFixed(3)} – ${s.end.toFixed(3)} s`);
    cell(tr, `${s.speed.toFixed(4)}×`);
    cell(tr, s.setptsFactor.toFixed(6));
    cell(tr, s.reason);
    segmentsBody.append(tr);
  });
  $('segments-body').replaceChildren(segmentsBody);
}

function renderDownloads() {
  const box = $('downloads');
  box.replaceChildren();
  if (state.analysisId) {
    box.append(link(api.analysisJsonUrl(state.analysisId), 'Descargar análisis JSON'));
    box.append(link(api.analysisCsvUrl(state.analysisId), 'Descargar cortes CSV'));
  }
  if (state.exportResult && state.proposal) {
    const a = link(api.exportedFileUrl(state.proposal.id), 'Descargar MP4 exportado');
    a.setAttribute('download', '');
    a.classList.add('is-primary');
    box.append(a);
  }
}

function link(href, text) {
  const a = document.createElement('a');
  a.href = href; a.textContent = text; a.className = 'download';
  return a;
}

// ---------------------------------------------------------------- acciones

$('file').addEventListener('change', event => {
  analysisPoll?.stop();
  sourcePlayer.clear(); exportPlayer.clear();
  const file = event.target.files[0];
  $('file-label').textContent = file ? file.name : 'Selecciona un MP4';
  dispatch({ type: 'file-selected', file });
  if (file) messages.setStatus('Archivo listo. Pulsa «Analizar video».');
});

$('btn-analyze').addEventListener('click', async () => {
  if (!canAnalyze(state)) return;
  dispatch({ type: 'upload-start' });
  try {
    const job = await uploadVideo(state.file, {
      onProgress: percent => { dispatch({ type: 'upload-progress', percent }); messages.setStatus(`Subiendo al backend local: ${percent.toFixed(0)} %`); },
    });
    dispatch({ type: 'analysis-start', id: job.id });
    analysisPoll?.stop();
    // Polling: nunca dos peticiones simultáneas, y se cancela al cambiar de archivo.
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
    messages.setStatus('Análisis completado. Ajusta la propuesta y créala.');
  } catch (e) {
    dispatch({ type: 'error', error: e.message });
  }
});

$('btn-propose').addEventListener('click', async () => {
  if (!canPropose(state)) return;
  dispatch({ type: 'proposal-start' });
  messages.setStatus('Creando propuesta de edición…');
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
    messages.setStatus('Propuesta creada. Revisa la timeline y apruébala para poder exportar.');
  } catch (e) {
    dispatch({ type: 'error', error: e.message });
  }
});

$('btn-approve').addEventListener('click', async () => {
  if (!canApprove(state)) return;
  try {
    const proposal = await api.approveProposal(state.proposal.id, 'editor-web');
    dispatch({ type: 'approved', proposal });
    messages.setStatus('Propuesta aprobada. Ya puedes exportar.');
  } catch (e) {
    dispatch({ type: 'error', error: e.message });
  }
});

$('btn-export').addEventListener('click', async () => {
  // Doble comprobación: el guardia de estado ya deshabilita el botón, pero un
  // doble clic rápido no debe llegar nunca a lanzar dos exportaciones.
  if (!canExport(state)) return;
  dispatch({ type: 'export-start' });
  messages.setStatus('Exportando con FFmpeg. Puede tardar; no cierres la pestaña.');
  const began = Date.now();
  const ticker = setInterval(() => messages.setStatus(`Exportando con FFmpeg… ${Math.round((Date.now() - began) / 1000)} s`), 1000);
  try {
    const result = await api.exportProposal(state.proposal.id, $('fit').value);
    dispatch({ type: 'export-complete', result });
    exportPlayer.load(api.exportedFileUrl(state.proposal.id));
    const m = result.export.measured;
    messages.setStatus(`Exportado: ${m.width}×${m.height} ${m.codec} · ${m.duration.toFixed(3)} s · ${m.audioTracks ? 'con audio' : 'sin audio'}.`);
  } catch (e) {
    dispatch({ type: 'error', error: e.message });
  } finally {
    clearInterval(ticker);
  }
});

// ---------------------------------------------------------------- arranque

try {
  const config = await api.analysisConfig();
  // Sólo se recibe disponibilidad; la clave nunca sale del backend.
  $('config-hint').textContent = config.hasKey
    ? `Gemini disponible (modelo ${config.model}). El análisis de esta pantalla es local; la interpretación opcional está en «Análisis detallado».`
    : 'Modo local: sin clave Gemini. El análisis, la propuesta y la exportación funcionan igualmente y no consumen créditos.';
} catch (e) {
  $('config-hint').textContent = `No se pudo leer la configuración: ${e.message}`;
}

render();
