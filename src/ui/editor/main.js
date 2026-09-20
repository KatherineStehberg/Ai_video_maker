/**
 * Orquestador del estudio. Une navegación, pasos, estado, API y vistas.
 *
 * Separación de responsabilidades (no la mezcles al editar):
 *   api.js        -> todo lo que habla con el backend
 *   state.js      -> qué se puede hacer en cada momento (sin DOM)
 *   format.js     -> convertir datos en texto legible (sin DOM)
 *   draft.js      -> tarjetas de escena del guion
 *   segments.js   -> trozos del montaje
 *   timeline.js   -> línea de tiempo
 *   projects.js   -> tarjetas de proyectos recientes
 *   inspector.js  -> panel derecho
 *   messages.js   -> estado, errores y advertencias
 *   main.js       -> este archivo: sólo coordina
 *
 * Aquí NO hay lógica de FFmpeg ni de análisis: eso vive en el backend.
 */
import { createApi, uploadVideo, poll, ApiError } from './api.js';
import { initialState, reduce, canAnalyze, canPropose, canApprove, canExport, exportBlockedReason, STATE_LABELS } from './state.js';
import { fileSummary, rhythmSummary, collectWarnings, summaryCards, seconds, frame, rampRow } from './format.js';
import { renderTimeline } from './timeline.js';
import { renderSegments, readSegments, validateSelection, hasChanges } from './segments.js';
import { renderDraft, readDraft, validateDraft, duracionTotal, aplicarAccion, escenasIncluidas } from './draft.js';
import { renderProjects, duracionCorta } from './projects.js';
import { renderInspector, renderVacio } from './inspector.js';
import { createMessages } from './messages.js';
import { createPlayer } from './player.js';

const $ = id => document.getElementById(id);
const api = createApi();

let state = initialState();
let analysisPoll = null, generationPoll = null;
let pendingSegments = null;      // selección del panel aún sin aplicar
let borrador = null;             // guion y escenas revisables antes de producir
let guionOriginal = null;        // para el botón «Restaurar»
let seccion = 'inicio';
let paso = 'idea';
let escenaSel = null;            // trozo seleccionado en la timeline
let config = { durationOptions: [], styles: [] };

const messages = createMessages({ statusEl: $('status'), stateEl: $('estado-pill'), errorEl: $('error'), warningsEl: $('warnings') });
const sourcePlayer = createPlayer($('source-player'), { emptyEl: $('source-empty') });
const exportPlayer = createPlayer($('export-player'), { emptyEl: $('export-empty') });

/** Tono de la píldora de estado según en qué anda el sistema. */
const TONOS = {
  listo: 'neutro', cargando: 'trabajo', generando: 'trabajo', analizando: 'trabajo',
  'analisis-completado': 'ok', 'creando-propuesta': 'trabajo', 'aprobacion-pendiente': 'aviso',
  aprobado: 'ok', exportando: 'trabajo', exportado: 'ok', error: 'error',
};

/** Secciones sin implementar todavía: se dicen, no se simulan. */
const PROXIMAMENTE = {
  plantillas: 'Aquí podrás guardar tus propios formatos de video y reutilizarlos. Hoy el tipo de video se elige en el paso «Idea».',
  recursos: 'Aquí verás tu biblioteca de imágenes, clips y música. Hoy las imágenes se buscan automáticamente al crear cada video.',
  exportaciones: 'Aquí tendrás el historial de todos los MP4 exportados. Hoy cada video se descarga desde el paso «Exportar» y se guarda en output/video-edits/.',
  ajustes: 'Aquí podrás cambiar la voz, la marca y las claves desde la interfaz. Hoy se configuran en el archivo .env.',
};

const dispatch = action => { state = reduce(state, action); render(); };

// ========================================================= NAVEGACIÓN

function irA(nueva) {
  seccion = nueva;
  for (const b of $('nav').querySelectorAll('.nav-item')) {
    if (b.dataset.seccion === nueva) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }

  const pantalla = PROXIMAMENTE[nueva] ? 'proximamente'
    : nueva === 'crear' ? 'crear'
    : nueva === 'subir' ? 'subir'
    : 'inicio';

  for (const s of $('lienzo').querySelectorAll('[data-pantalla]')) {
    s.hidden = s.dataset.pantalla !== pantalla;
  }

  if (pantalla === 'proximamente') {
    $('prox-titulo').textContent = `${nueva.charAt(0).toUpperCase() + nueva.slice(1)} · Próximamente`;
    $('prox-texto').textContent = PROXIMAMENTE[nueva];
  }
  if (pantalla === 'inicio') cargarProyectos();
  // El panel derecho sólo aparece donde sirve para algo.
  $('app').dataset.panel = pantalla === 'crear' && paso === 'editor' ? 'si' : 'no';
  $('lienzo').scrollTop = 0;
  render();
}

for (const boton of $('nav').querySelectorAll('.nav-item')) {
  boton.addEventListener('click', () => irA(boton.dataset.seccion));
}
$('ir-crear').addEventListener('click', () => { irA('crear'); irPaso('idea'); });
$('ir-subir').addEventListener('click', () => irA('subir'));
$('btn-inicio').addEventListener('click', () => irA('inicio'));
$('prox-volver').addEventListener('click', () => irA('inicio'));
$('btn-nuevo').addEventListener('click', () => {
  analysisPoll?.stop(); generationPoll?.stop();
  sourcePlayer.clear(); exportPlayer.clear();
  borrador = null; guionOriginal = null; pendingSegments = null; escenaSel = null;
  dispatch({ type: 'reset' });
  irA('crear'); irPaso('idea');
  messages.setStatus('Describe tu idea para empezar.');
});

// ============================================================ PASOS

const PASOS = ['idea', 'guion', 'escenas', 'voz', 'preview', 'editor', 'exportar'];

/** ¿Está disponible este paso con lo que hay hecho? */
function pasoDisponible(p) {
  if (p === 'idea') return true;
  if (['guion', 'escenas', 'voz'].includes(p)) return Boolean(borrador);
  if (p === 'preview') return Boolean(state.analysis);
  return Boolean(state.proposal);   // editor y exportar
}

function irPaso(nuevo) {
  if (!pasoDisponible(nuevo)) return;
  paso = nuevo;
  for (const panel of $('lienzo').querySelectorAll('[data-paso-panel]')) {
    panel.hidden = panel.dataset.pasoPanel !== nuevo;
  }
  $('app').dataset.panel = nuevo === 'editor' ? 'si' : 'no';
  $('lienzo').scrollTop = 0;
  render();
}

for (const boton of $('pasos').querySelectorAll('.paso')) {
  boton.addEventListener('click', () => irPaso(boton.dataset.paso));
}

// ========================================================= PINTADO

function render() {
  const etiqueta = STATE_LABELS[state.state] || state.state;
  $('estado-pill').textContent = etiqueta;
  $('estado-pill').dataset.tono = TONOS[state.state] || 'neutro';
  messages.setError(state.error);
  $('progress').value = state.progress || 0;

  $('titulo-proyecto').textContent = borrador?.tema || state.generation?.script?.tema
    || (state.file?.name ?? 'Sin proyecto abierto');

  // Pasos: hecho / activo / disponible.
  for (const boton of $('pasos').querySelectorAll('.paso')) {
    const p = boton.dataset.paso;
    const hecho = PASOS.indexOf(p) < PASOS.indexOf(paso) && pasoDisponible(p);
    boton.dataset.estado = p === paso ? 'activo' : hecho ? 'hecho' : 'pendiente';
    boton.disabled = !pasoDisponible(p);
  }

  $('btn-draft').disabled = state.busy;
  $('btn-generate').disabled = state.busy || !borrador;
  $('btn-analyze').disabled = !canAnalyze(state);
  $('btn-propose').disabled = !canPropose(state);
  $('btn-approve').disabled = !canApprove(state);
  $('btn-export').disabled = !canExport(state);
  $('export-blocked').textContent = exportBlockedReason(state) || '';

  pintarGuion();
  pintarVoz();
  pintarResumen();
  pintarTablas();
  pintarDescargas();

  messages.setWarnings([...new Set([
    ...(state.generation?.warnings || []),
    ...collectWarnings(state.proposal, state.exportResult),
  ])]);

  renderTimeline($('timeline'), state.analysis, state.proposal, {
    onSeek: t => sourcePlayer.seek(t),
    onSelect: i => { escenaSel = i; pintarPanel(); render(); },
    seleccionada: escenaSel,
  });

  if (state.proposal && !pendingSegments) {
    renderSegments($('segments-list'), state.proposal, { onChange: alCambiarSegmentos });
    actualizarBotonesSegmentos(readSegments($('segments-list')));
  }
  pintarPanel();
}

function pintarPanel() {
  if (paso !== 'editor' || !state.proposal) {
    return renderVacio($('panel-contenido'),
      paso === 'editor' ? 'Crea una propuesta para poder ajustar las escenas.' : undefined);
  }
  renderInspector($('panel-contenido'), {
    proposal: state.proposal, index: escenaSel ?? 0,
    onIr: t => sourcePlayer.seek(t),
    onCambio: ({ index, speed, incluido }) => {
      const filas = [...$('segments-list').querySelectorAll('.seg-fila')];
      const fila = filas[index];
      if (!fila) return;
      fila.querySelector('.segmento-velocidad').value = String(speed);
      const casilla = fila.querySelector('.segmento-incluir');
      casilla.checked = incluido;
      fila.dataset.incluido = incluido ? 'si' : 'no';
      alCambiarSegmentos(readSegments($('segments-list')));
    },
  });
}

function pintarGuion() {
  if (!borrador) return;
  const fuentes = { 'plantilla-local': 'Plantilla local (sin IA)', llm: `Escrito por ${borrador.llmProvider}`, editado: 'Editado por ti' };
  $('draft-source').textContent = fuentes[borrador.source] || borrador.source;
  const modo = borrador.spec?.durationMode === 'auto' ? 'duración automática' : `objetivo ${borrador.spec?.duration} s`;
  $('draft-summary').textContent =
    `${borrador.escenas.length} escenas · ${duracionTotal(borrador.escenas)} s estimados · ${modo}.` +
    (borrador.llmError ? ` No se pudo usar el modelo (${borrador.llmError}); se usó la plantilla local.` : '');
  $('draft-cost').textContent = borrador.costo.resumen;

  const palabras = borrador.escenas.map(e => e.text).join(' ').split(/\s+/).filter(Boolean).length;
  $('guion-contador').textContent = `${palabras} palabras · ${duracionTotal(borrador.escenas)} s`;

  const ficha = document.createDocumentFragment();
  for (const [k, v] of [
    ['Duración estimada', `${duracionTotal(borrador.escenas)} s`],
    ['Voz', borrador.voz?.nombre ? `${borrador.voz.nombre} · ${borrador.voz.etiqueta}` : 'Sin narración'],
    ['Imágenes', borrador.costo.piezas.find(p => p.pieza === 'Visuales')?.proveedor ?? '—'],
  ]) { ficha.append(Object.assign(document.createElement('dt'), { textContent: k }), Object.assign(document.createElement('dd'), { textContent: v })); }
  $('draft-facts').replaceChildren(ficha);

  $('draft-voice-warning').hidden = !borrador.voz?.aviso;
  $('draft-voice-warning').textContent = borrador.voz?.aviso || '';

  renderDraft($('draft-scenes'), borrador.escenas, {
    onChange: escenas => { borrador.escenas = escenas; $('escenas-resumen').textContent = `${escenasIncluidas(escenas).length} escenas · ${duracionTotal(escenas)} s`; },
    onRegenerate: regenerarEscena,
    onAccion: accion => {
      // Duplicar, excluir o reordenar cambia el montaje: hay que revisarlo.
      borrador = { ...borrador, escenas: aplicarAccion(readDraft($('draft-scenes')), accion), source: 'editado' };
      render();
      messages.setStatus('Escenas actualizadas. Revisa el orden antes de crear el video.');
    },
  });
  $('escenas-resumen').textContent = `${escenasIncluidas(borrador.escenas).length} escenas · ${duracionTotal(borrador.escenas)} s`;
}

function pintarVoz() {
  if (!borrador?.voz) return;
  const ficha = document.createDocumentFragment();
  for (const [k, v] of [
    ['Proveedor', borrador.voz.provider || '—'],
    ['Voz', borrador.voz.nombre || 'Sin narración'],
    ['Idioma', borrador.voz.etiqueta || '—'],
    ['Subtítulos', 'Sincronizados y quemados en el video'],
  ]) { ficha.append(Object.assign(document.createElement('dt'), { textContent: k }), Object.assign(document.createElement('dd'), { textContent: v })); }
  $('voz-ficha').replaceChildren(ficha);
  $('voz-aviso').hidden = !borrador.voz.aviso;
  $('voz-aviso').textContent = borrador.voz.aviso || '';
  $('fuente-imagenes').textContent = borrador.costo.piezas.find(p => p.pieza === 'Visuales')?.proveedor ?? '—';
}

function pintarResumen() {
  const cards = summaryCards(state.analysis, state.proposal);
  const frag = document.createDocumentFragment();
  for (const c of cards) {
    const caja = document.createElement('div'); caja.className = 'dato';
    caja.append(
      Object.assign(document.createElement('div'), { className: 'dato-valor', textContent: c.valor }),
      Object.assign(document.createElement('div'), { className: 'dato-etq', textContent: c.etiqueta }),
      Object.assign(document.createElement('div'), { className: 'dato-det', textContent: c.detalle }),
    );
    frag.append(caja);
  }
  if (!cards.length) {
    frag.append(Object.assign(document.createElement('p'), { className: 'ayuda', textContent: 'Crea el video para ver aquí sus datos.' }));
  }
  $('resumen').replaceChildren(frag.cloneNode(true));
  $('export-resumen').replaceChildren(frag);

  const p = state.proposal;
  $('approval-hint').textContent = !p
    ? 'Primero crea el video.'
    : (!p.approvalRequired || p.approval?.status === 'aprobada')
      ? 'Aprobado. Ya puedes exportar.'
      : 'Revisa el resumen y las advertencias antes de aprobar.';

  const ritmo = rhythmSummary(state.analysis?.local);
  $('tempo-summary').textContent = ritmo.tempo;
  $('sync-summary').textContent = ritmo.sync;

  const fichaArchivo = document.createDocumentFragment();
  for (const [k, v] of fileSummary(state.file, state.analysis?.metadata)) {
    fichaArchivo.append(Object.assign(document.createElement('dt'), { textContent: k }), Object.assign(document.createElement('dd'), { textContent: v }));
  }
  $('file-facts').replaceChildren(fichaArchivo.cloneNode(true));
  $('file-facts-subir').replaceChildren(fichaArchivo);
}

const celda = (tr, txt) => { const td = document.createElement('td'); td.textContent = txt; tr.append(td); };

function pintarTablas() {
  const cuts = state.analysis?.cuts || [];
  $('cuts-count').textContent = String(cuts.length);
  const cuerpo = document.createDocumentFragment();
  for (const c of cuts) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'enlace-tiempo'; b.textContent = c.timestamp.toFixed(3);
    b.addEventListener('click', () => sourcePlayer.seek(c.timestamp));
    td.append(b); tr.append(td);
    celda(tr, frame(c)); celda(tr, c.source); celda(tr, c.reason);
    cuerpo.append(tr);
  }
  $('cuts-body').replaceChildren(cuerpo);

  const ramps = state.analysis?.local?.ramps || [];
  $('ramps-count').textContent = String(ramps.length);
  const cuerpoR = document.createDocumentFragment();
  for (const r of ramps) {
    const tr = document.createElement('tr');
    const v = rampRow(r);
    for (const k of ['segmento', 'frames', 'duracion', 'factor', 'motivo']) celda(tr, v[k]);
    cuerpoR.append(tr);
  }
  $('ramps-body').replaceChildren(cuerpoR);
}

function pintarDescargas() {
  const caja = $('downloads');
  caja.replaceChildren();
  if (!state.analysisId) {
    caja.append(Object.assign(document.createElement('p'), { className: 'ayuda', textContent: 'Disponibles cuando el video esté montado.' }));
    return;
  }
  const enlace = (href, txt, principal) => {
    const a = document.createElement('a');
    a.href = href; a.textContent = txt; a.className = `btn btn-mini${principal ? ' btn-accion' : ''}`;
    return a;
  };
  if (state.exportResult && state.proposal) {
    const mp4 = enlace(api.exportedFileUrl(state.proposal.id), 'Descargar MP4', true);
    mp4.setAttribute('download', '');
    caja.append(mp4);
  }
  caja.append(enlace(api.analysisJsonUrl(state.analysisId), 'Datos del análisis (JSON)'));
  caja.append(enlace(api.analysisCsvUrl(state.analysisId), 'Lista de cortes (CSV)'));
}

// ================================================== PROYECTOS (INICIO)

async function cargarProyectos() {
  try {
    const { proyectos } = await api.listProjects();
    $('proyectos-total').textContent = proyectos.length ? `${proyectos.length} guardados` : '';
    renderProjects($('proyectos-lista'), proyectos, { onAbrir: abrirProyecto, onVer: abrirProyecto });
  } catch (e) {
    renderProjects($('proyectos-lista'), [], {});
    $('proyectos-total').textContent = `No se pudieron cargar: ${e.message}`;
  }
}

/** Retoma un proyecto guardado: recupera su análisis y su propuesta. */
async function abrirProyecto(p) {
  irA('crear');
  messages.setStatus(`Abriendo «${p.titulo}»…`);
  try {
    if (!p.analysisId) {
      irPaso('idea');
      $('prompt').value = p.prompt || '';
      messages.setStatus('Este proyecto no llegó a montarse. Su idea está cargada: puedes crear el borrador de nuevo.');
      return;
    }
    const analysis = await api.getAnalysis(p.analysisId);
    const proposal = p.editId ? await api.getProposal(p.editId).catch(() => null) : null;
    const job = { id: p.id, spec: { prompt: p.prompt, duration: p.duracionPedida, format: p.formato }, provider: {}, warnings: [], generation: {} };
    dispatch({ type: 'generation-complete', job, analysis, proposal: proposal || { segments: [], approvalRequired: true, approval: {}, warnings: [], format: p.formato, dimensions: {}, estimatedDuration: 0, syncStatus: 'propuesto' } });
    sourcePlayer.load(api.previewUrl(analysis.id));
    irPaso(proposal ? 'editor' : 'preview');
    messages.setStatus(`Proyecto recuperado. ${proposal ? 'Puedes seguir editando.' : 'Su montaje no está disponible.'}`);
  } catch (e) {
    dispatch({ type: 'error', error: `No pudimos abrir este proyecto: ${e.message}` });
  }
}

// ==================================================== SEGMENTOS

function alCambiarSegmentos(segments) {
  pendingSegments = segments;
  actualizarBotonesSegmentos(segments);
}

function actualizarBotonesSegmentos(segments) {
  const cambiado = hasChanges(segments, state.proposal);
  const problema = cambiado ? validateSelection(segments) : null;
  $('btn-apply-segments').disabled = !cambiado || Boolean(problema) || state.busy;
  $('btn-reset-segments').disabled = !cambiado || state.busy;
  $('segments-note').textContent = problema || (cambiado
    ? 'Al aplicar los cambios tendrás que aprobar de nuevo.'
    : 'Desmarca lo que no quieras o cambia la velocidad.');
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
  } catch (e) { dispatch({ type: 'error', error: e.message }); }
});

$('btn-reset-segments').addEventListener('click', () => {
  pendingSegments = null;
  renderSegments($('segments-list'), state.proposal, { onChange: alCambiarSegmentos });
  actualizarBotonesSegmentos(readSegments($('segments-list')));
  messages.setStatus('Cambios descartados.');
});

// ================================================= IDEA Y GUION

function leerFormulario() {
  const dur = $('gen-duration').value;
  return {
    prompt: $('prompt').value.trim(),
    duration: dur === 'auto' ? 'auto' : dur === 'custom' ? Number($('gen-duration-custom').value) : Number(dur),
    format: $('gen-format').value,
    style: $('gen-style').value,
    audience: $('gen-audience').value.trim() || null,
    platform: $('gen-platform').value.trim() || null,
    music: $('gen-tono').value.trim() || null,
  };
}

$('gen-duration').addEventListener('change', () => {
  $('wrap-duracion-custom').hidden = $('gen-duration').value !== 'custom';
});

$('btn-draft').addEventListener('click', async () => {
  if (state.busy) return;
  const base = leerFormulario();
  if (!base.prompt) { messages.setError('Escribe primero qué video quieres crear.'); return; }
  messages.clearError();
  messages.setStatus('Preparando el guion…');
  try {
    borrador = await api.draftGeneration(base);
    guionOriginal = JSON.parse(JSON.stringify(borrador.escenas));
    $('guion-texto').value = borrador.escenas.map(e => e.text).join('\n');
    render();
    irPaso('guion');
    messages.setStatus('Guion listo. Revísalo y apruébalo.');
  } catch (e) { dispatch({ type: 'error', error: e.message }); }
});

$('btn-redraft').addEventListener('click', () => $('btn-draft').click());

$('btn-restaurar').addEventListener('click', () => {
  if (!guionOriginal) return;
  borrador.escenas = JSON.parse(JSON.stringify(guionOriginal));
  borrador.source = borrador.source === 'editado' ? 'plantilla-local' : borrador.source;
  $('guion-texto').value = borrador.escenas.map(e => e.text).join('\n');
  render();
  messages.setStatus('Guion restaurado a la versión propuesta.');
});

$('btn-aprobar-guion').addEventListener('click', () => {
  if (!borrador) return;
  // El texto del área grande manda sobre las tarjetas si se editó aquí.
  const lineas = $('guion-texto').value.split('\n').map(l => l.trim()).filter(Boolean);
  if (lineas.length === borrador.escenas.length) {
    borrador.escenas = borrador.escenas.map((e, i) => ({ ...e, text: lineas[i] }));
  }
  borrador.source = 'editado';
  render();
  irPaso('escenas');
  messages.setStatus('Guion aprobado. Revisa las escenas una a una.');
});

$('btn-add-escena').addEventListener('click', () => {
  if (!borrador) return;
  borrador.escenas = [...readDraft($('draft-scenes')), {
    role: 'point', text: 'Escribe aquí lo que se narra en esta escena.',
    onScreenTitle: 'Nueva escena', visualPrompt: borrador.tema || '', duration: 4,
  }];
  render();
  messages.setStatus('Escena añadida al final.');
});

/** Regenera UNA escena conservando el resto tal y como está editado. */
async function regenerarEscena(indice) {
  const base = leerFormulario();
  if (!base.prompt) { messages.setError('Escribe la idea antes de regenerar.'); return; }
  messages.setStatus(`Regenerando la escena ${indice + 1}…`);
  try {
    const fresco = await api.draftGeneration({ ...base, templateId: borrador.templateId });
    const reemplazo = fresco.escenas[indice] || fresco.escenas.at(-1);
    if (!reemplazo) throw new ApiError('El borrador nuevo no trae esa escena.', 0);
    const escenas = readDraft($('draft-scenes'));
    escenas[indice] = reemplazo;
    borrador = { ...borrador, escenas, source: 'editado' };
    render();
    messages.setStatus(`Escena ${indice + 1} regenerada.`);
  } catch (e) { dispatch({ type: 'error', error: e.message }); }
}

// ================================================== CREAR EL VIDEO

$('btn-generate').addEventListener('click', async () => {
  if (state.busy || !borrador) return;
  const escenas = readDraft($('draft-scenes'));
  const problema = validateDraft(escenas);
  if (problema) { messages.setError(problema); return; }

  // Las escenas excluidas no viajan al backend: no forman parte del video.
  const body = { ...leerFormulario(), templateId: borrador.templateId,
    escenas: escenasIncluidas(escenas).map(({ excluida, ...e }) => e), scriptSource: borrador.source };
  try {
    const job = await api.createGeneration(body);
    dispatch({ type: 'generation-start', job });
    irPaso('preview');
    messages.setStatus('Preparando tu video…');

    generationPoll?.stop();
    generationPoll = poll(() => api.getGeneration(job.id), {
      intervalMs: 900,
      isDone: j => ['completed', 'failed'].includes(j.status),
      onTick: j => {
        dispatch({ type: 'generation-progress', job: j });
        messages.setStatus(`${j.stage || 'Trabajando'} · ${(j.progress || 0).toFixed(0)} %`);
      },
    });
    const fin = await generationPoll.done;
    if (fin.status !== 'completed') throw new ApiError(fin.error || 'No pudimos terminar tu video.', 0);

    const [analysis, proposal] = await Promise.all([api.getAnalysis(fin.analysisId), api.getProposal(fin.editId)]);
    dispatch({ type: 'generation-complete', job: fin, analysis, proposal });
    sourcePlayer.load(api.previewUrl(analysis.id));
    irPaso('preview');
    messages.setStatus('Tu video está listo. Revísalo y pasa a editar o exportar.');
    cargarProyectos();
  } catch (e) { dispatch({ type: 'error', error: e.message }); }
});

// ================================================ SUBIR UN MP4

$('file').addEventListener('change', event => {
  analysisPoll?.stop();
  sourcePlayer.clear(); exportPlayer.clear();
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
      onProgress: p => { dispatch({ type: 'upload-progress', percent: p }); messages.setStatus(`Cargando el video: ${p.toFixed(0)} %`); },
    });
    dispatch({ type: 'analysis-start', id: job.id });
    analysisPoll?.stop();
    analysisPoll = poll(() => api.getAnalysis(job.id), {
      intervalMs: 900,
      isDone: j => j.status !== 'running',
      onTick: j => {
        dispatch({ type: 'analysis-progress', progress: j.progress, stage: j.stage });
        messages.setStatus(`${j.stage || 'Analizando'} · ${(j.progress || 0).toFixed(0)} %`);
      },
    });
    const fin = await analysisPoll.done;
    if (fin.status !== 'complete') throw new ApiError(fin.error || `El análisis terminó en estado ${fin.status}`, 0);
    dispatch({ type: 'analysis-complete', analysis: fin });
    sourcePlayer.load(api.previewUrl(fin.id));
    messages.setStatus('Análisis listo. Elige cómo quieres el montaje.');
  } catch (e) { dispatch({ type: 'error', error: e.message }); }
});

$('btn-propose').addEventListener('click', async () => {
  if (!canPropose(state)) return;
  pendingSegments = null;
  dispatch({ type: 'proposal-start' });
  messages.setStatus('Preparando el montaje…');
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
    irA('crear'); irPaso('editor');
    messages.setStatus('Montaje propuesto. Revísalo y apruébalo.');
  } catch (e) { dispatch({ type: 'error', error: e.message }); }
});

// ============================================ APROBAR Y EXPORTAR

$('btn-approve').addEventListener('click', async () => {
  if (!canApprove(state)) return;
  try {
    const proposal = await api.approveProposal(state.proposal.id, 'estudio');
    dispatch({ type: 'approved', proposal });
    messages.setStatus('Versión aprobada. Ya puedes exportar.');
  } catch (e) { dispatch({ type: 'error', error: e.message }); }
});

$('btn-export').addEventListener('click', async () => {
  if (!canExport(state)) return;
  dispatch({ type: 'export-start' });
  const inicio = Date.now();
  messages.setStatus('Exportando tu video. No cierres la pestaña.');
  const reloj = setInterval(() => messages.setStatus(`Exportando tu video… ${Math.round((Date.now() - inicio) / 1000)} s`), 1000);
  try {
    const result = await api.exportProposal(state.proposal.id, $('fit').value);
    dispatch({ type: 'export-complete', result });
    exportPlayer.load(api.exportedFileUrl(state.proposal.id));
    const m = result.export.measured;
    messages.setStatus(`Listo: ${m.width}×${m.height} · ${duracionCorta(m.duration)} · ${m.audioTracks ? 'con audio' : 'sin audio'}.`);
    cargarProyectos();
  } catch (e) { dispatch({ type: 'error', error: e.message }); }
  finally { clearInterval(reloj); }
});

// =================================================== ARRANQUE

try {
  const c = await api.analysisConfig();
  $('config-hint').textContent = c.hasKey
    ? 'Todo se procesa en este equipo. La descripción con IA está en «Análisis avanzado».'
    : 'Todo se procesa en este equipo y sin coste.';
} catch (e) {
  $('config-hint').textContent = `No se pudo conectar con el servidor: ${e.message}`;
}

try {
  config = await api.generationConfig();
  $('gen-style').replaceChildren(...config.styles.map(s => new Option(s.charAt(0).toUpperCase() + s.slice(1), s)));
  $('gen-duration').replaceChildren(
    ...config.durationOptions.map(o => new Option(o.label, String(o.value))),
    new Option('Personalizada…', 'custom'),
  );
  $('gen-duration').value = '15';
  const activo = config.providers.find(p => p.id === config.defaultProvider);
  $('gen-provider-hint').textContent = activo?.mock
    ? 'Se creará un video de PRUEBA, sin IA, para que puedas recorrer el flujo.'
    : 'El guion, la voz y el montaje se hacen en este equipo, sin coste.';
} catch (e) {
  $('gen-provider-hint').textContent = `No se pudo leer la configuración: ${e.message}`;
}

// Marcas disponibles (si el backend las expone); si no, una opción neutra.
try {
  const marcas = await fetch('/api/brands').then(r => (r.ok ? r.json() : []));
  const lista = Array.isArray(marcas) ? marcas : [];
  $('gen-marca').replaceChildren(...(lista.length
    ? lista.map(b => new Option(b.name || b.id, b.id))
    : [new Option('Personal', 'personal')]));
  // 'personal' es la marca neutra: mejor punto de partida que la primera de la lista.
  if ([...$('gen-marca').options].some(o => o.value === 'personal')) $('gen-marca').value = 'personal';
} catch { $('gen-marca').replaceChildren(new Option('Personal', 'personal')); }

irA('inicio');
irPaso('idea');
render();
