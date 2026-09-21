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
/**
 * Estilo global de los subtítulos. Vive aquí y no en el DOM porque tiene que
 * sobrevivir a cambiar de paso, y porque el preset decide varios controles a
 * la vez.
 */
let estiloSubs = { preset: 'redes-sociales' };
let presetsSubs = [];

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

/**
 * Enlace al editor visual. Sólo se activa cuando hay un proyecto en disco:
 * un enlace que lleva a una pantalla vacía es peor que un enlace apagado.
 */
function pintarEnlaceEditor() {
  const enlace = $('ir-editor-visual');
  if (!enlace) return;
  const projectId = state.generation?.projectId || state.generation?.spec?.projectId || null;
  if (projectId) {
    enlace.href = `/project-editor.html?id=${encodeURIComponent(projectId)}`;
    enlace.classList.remove('btn-sutil');
    enlace.removeAttribute('aria-disabled');
    $('editor-visual-nota').textContent = 'Se abre en esta misma pestaña. Los cambios se guardan en el proyecto.';
  } else {
    enlace.href = '#';
    enlace.setAttribute('aria-disabled', 'true');
    $('editor-visual-nota').textContent = 'Disponible en cuanto el video se haya montado.';
  }
}

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
  pintarEnlaceEditor();
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

/** Lee los controles globales de subtítulos tal y como están en pantalla. */
function leerEstiloSubs() {
  return {
    preset: estiloSubs.preset,
    fontFamily: $('subs-font').value,
    fontScale: Number($('subs-scale').value),
    color: $('subs-color').value,
    background: $('subs-bg').value,
    backgroundColor: $('subs-bgcolor').value,
    backgroundOpacity: Number($('subs-bgopacity').value),
    outlineScale: Number($('subs-outline').value),
    position: $('subs-pos').value,
    alignment: $('subs-align').value,
  };
}

/** Vuelca un estilo en los controles. Se usa al aplicar un preset. */
function pintarEstiloSubs(estilo) {
  estiloSubs = { ...estiloSubs, ...estilo };
  const poner = (id, valor) => { if (valor !== undefined && valor !== null) $(id).value = String(valor); };
  poner('subs-font', estilo.fontFamily);
  poner('subs-scale', estilo.fontScale);
  poner('subs-color', estilo.color);
  poner('subs-bg', estilo.background);
  poner('subs-bgcolor', estilo.backgroundColor);
  poner('subs-bgopacity', estilo.backgroundOpacity);
  poner('subs-outline', estilo.outlineScale);
  poner('subs-pos', estilo.position);
  poner('subs-align', estilo.alignment);
  refrescarSubs();
}

/**
 * Aviso en vivo: qué tamaño de letra saldrá en el formato elegido.
 *
 * El cálculo real vive en el backend (core/captions-style.js). Aquí se repite
 * la parte mínima para dar una cifra sin ir y volver por la red en cada
 * pulsación; si los dos se separasen, manda el backend.
*/
const BASE_SUBS = { '9:16': 64, '16:9': 48, '1:1': 58, '4:5': 61 };

function refrescarSubs() {
  const encendido = $('subs-on').checked;
  $('subs-detalle').hidden = !encendido;
  $('subs-resumen').textContent = encendido
    ? 'Se subtitula el video entero, de principio a fin, con la narración exacta.'
    : 'Sin subtítulos: no aparecerá ningún texto de narración en el video.';
  if (!encendido) { $('subs-medida').textContent = ''; return; }

  const formato = $('gen-format').value;
  const base = BASE_SUBS[formato] ?? 64;
  const px = Math.round(base * Number($('subs-scale').value || 1));
  $('subs-medida').textContent =
    `En ${formato} la letra medirá unos ${px} px, en dos líneas como máximo, ` +
    'dentro de la zona segura (sin quedar bajo los controles de TikTok o Instagram).';

  const activo = presetsSubs.find(p => p.id === estiloSubs.preset);
  $('subs-preset-desc').textContent = activo?.description || '';
  for (const b of $('subs-presets').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.preset === estiloSubs.preset));
  }
}

/** Dibuja los botones de preset y engancha los controles. Se llama una vez. */
function montarSubs(opciones) {
  presetsSubs = opciones?.presets || [];
  $('subs-presets').replaceChildren(...presetsSubs.map(p => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-mini';
    b.textContent = p.label;
    b.dataset.preset = p.id;
    b.title = p.description;
    b.addEventListener('click', () => {
      // Cambiar de preset REEMPLAZA los controles: es lo que se espera de un
      // preset. Retocar después sigue funcionando y no se pierde.
      estiloSubs = { preset: p.id };
      pintarEstiloSubs(p.style || {});
    });
    return b;
  }));

  const fuentes = opciones?.fonts || [{ id: 'Arial', label: 'Arial' }];
  $('subs-font').replaceChildren(...fuentes.map(f => {
    const o = document.createElement('option');
    o.value = f.id; o.textContent = f.label;
    return o;
  }));

  for (const id of ['subs-on', 'subs-font', 'subs-scale', 'subs-color', 'subs-bg',
    'subs-bgcolor', 'subs-bgopacity', 'subs-outline', 'subs-pos', 'subs-align']) {
    $(id).addEventListener('change', refrescarSubs);
  }
  $('gen-format').addEventListener('change', refrescarSubs);
  refrescarSubs();
}

function leerFormulario() {
  const dur = $('gen-duration').value;
  const wpm = Number($('gen-wpm')?.value);
  return {
    prompt: $('prompt').value.trim(),
    // Guion propio: si está escrito, manda sobre el prompt y no se reescribe.
    script: $('guion-propio')?.value.trim() || null,
    duration: dur === 'auto' ? 'auto' : dur === 'custom' ? Number($('gen-duration-custom').value) : Number(dur),
    wpm: Number.isFinite(wpm) && wpm > 0 ? wpm : undefined,
    format: $('gen-format').value,
    style: $('gen-style').value,
    brandId: $('gen-marca')?.value || undefined,
    audience: $('gen-audience').value.trim() || null,
    platform: $('gen-platform').value.trim() || null,
    music: $('gen-tono').value.trim() || null,
    // SUBTITULOS. Este campo faltaba: la casilla existia en la pantalla pero
    // nunca viajaba al backend, asi que desactivarla no hacia nada y el video
    // salia subtitulado igual. Ahora manda lo que diga la casilla.
    subtitles: { enabled: $('subs-on').checked, burnIn: $('subs-on').checked, style: leerEstiloSubs() },
  };
}

$('gen-duration').addEventListener('change', () => {
  $('wrap-duracion-custom').hidden = $('gen-duration').value !== 'custom';
  estimar();
});

/**
 * Estimación en vivo de la duración, pedida al backend (que usa exactamente el
 * mismo segmentador que la producción, para que lo previsto y lo producido no
 * se contradigan). Se espera a que pare de escribir antes de preguntar.
 */
let estimarTimer = null;
async function estimar() {
  const salida = $('guion-propio-estado');
  if (!salida) return;
  const base = leerFormulario();
  if (!base.script && !base.prompt) { salida.textContent = 'La duración se calcula a partir del guion.'; return; }
  try {
    const p = await api.planGeneration(base);
    const aviso = p.advertencias?.[0] ? ` ⚠ ${p.advertencias[0]}` : '';
    salida.textContent =
      `${p.palabras.toLocaleString('es')} palabras · ${p.escenas} escenas · ` +
      `dura unos ${p.duracionEstimadaLegible} a ${p.wpm} palabras por minuto.${aviso}`;
  } catch (e) {
    salida.textContent = e.message;
  }
}
const estimarPronto = () => { clearTimeout(estimarTimer); estimarTimer = setTimeout(estimar, 400); };
$('guion-propio')?.addEventListener('input', estimarPronto);
$('prompt').addEventListener('input', estimarPronto);
$('gen-wpm')?.addEventListener('change', estimar);

$('btn-draft').addEventListener('click', async () => {
  if (state.busy) return;
  const base = leerFormulario();
  if (!base.prompt && !base.script) {
    messages.setError('Escribe tu idea, o pega el guion que quieres narrar.');
    return;
  }
  messages.clearError();
  messages.setStatus(base.script ? 'Segmentando tu guion en escenas…' : 'Preparando el guion…');
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
  if (!base.prompt && !base.script) { messages.setError('Escribe la idea o el guion antes de regenerar.'); return; }
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

// ============================================ PROGRESO REAL Y REANUDACIÓN

/**
 * Muestra el avance CONTADO por el backend: etapa, escenas terminadas sobre el
 * total y porcentaje. Si una etapa tarda, el número se queda quieto, que es lo
 * que realmente está pasando; aquí no se anima nada para disimular.
 */
function mostrarProgreso(job) {
  const p = job.progreso;
  const caja = $('progreso-escenas');
  if (!p) {
    messages.setStatus(`${job.stage || 'Trabajando'} · ${(job.progress || 0).toFixed(0)} %`);
    if (caja) caja.hidden = true;
    return;
  }
  messages.setStatus(`${p.etiqueta} · ${p.porcentaje.toFixed(0)} %`);
  if (!caja) return;
  caja.hidden = false;
  caja.textContent = p.escenasTotales
    ? `Escena ${p.escenasCompletadas} de ${p.escenasTotales} · ${p.operacion || p.etiqueta}`
    : (p.operacion || p.etiqueta);
}

/** Ofrece reanudar cuando el fallo dejó trabajo aprovechable en disco. */
function ofrecerReanudar(job) {
  const boton = $('btn-reanudar');
  if (!boton) return;
  const puede = Boolean(job?.projectId) && job.status !== 'completed';
  boton.hidden = !puede;
  boton.dataset.jobId = puede ? job.id : '';
  if (puede) {
    messages.setStatus('El proyecto se interrumpió. Las escenas ya terminadas se conservan: puedes reanudarlo.');
  }
}

$('btn-reanudar')?.addEventListener('click', async () => {
  const id = $('btn-reanudar').dataset.jobId;
  if (!id) return;
  $('btn-reanudar').hidden = true;
  messages.clearError();
  messages.setStatus('Reanudando: sólo se rehará lo que quedó a medias…');
  try {
    const job = await api.resumeGeneration(id);
    dispatch({ type: 'generation-start', job });
    await seguirGeneracion(job);
  } catch (e) { dispatch({ type: 'error', error: e.message }); }
});

/** Sondea un trabajo hasta el final y carga el resultado. Compartido por crear y reanudar. */
async function seguirGeneracion(job) {
  generationPoll?.stop();
  generationPoll = poll(() => api.getGeneration(job.id), {
    intervalMs: 900,
    isDone: j => ['completed', 'failed'].includes(j.status),
    onTick: j => { dispatch({ type: 'generation-progress', job: j }); mostrarProgreso(j); },
  });
  const fin = await generationPoll.done;
  if (fin.status !== 'completed') { ofrecerReanudar(fin); throw new ApiError(fin.error || 'No pudimos terminar tu video.', 0); }

  const [analysis, proposal] = await Promise.all([api.getAnalysis(fin.analysisId), api.getProposal(fin.editId)]);
  dispatch({ type: 'generation-complete', job: fin, analysis, proposal });
  sourcePlayer.load(api.previewUrl(analysis.id));
  irPaso('preview');
  messages.setStatus('Tu video está listo. Revísalo y pasa a editar o exportar.');
  cargarProyectos();
  return fin;
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
        mostrarProgreso(j);
      },
    });
    const fin = await generationPoll.done;
    if (fin.status !== 'completed') {
      // Si quedó proyecto en disco, lo hecho se conserva y se puede reanudar.
      ofrecerReanudar(fin);
      throw new ApiError(fin.error || 'No pudimos terminar tu video.', 0);
    }

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
  // «Automática» por defecto: manda el guion. Los presets siguen ahí para
  // quien quiera pedir una duración concreta, corta o larga, en la misma lista.
  $('gen-duration').value = 'auto';
  if (config.narration?.wpm && $('gen-wpm')) $('gen-wpm').value = String(config.narration.wpm);
  // Subtítulos: presets y tipografías salen del backend, para que la lista
  // de aquí no se desincronice de la que de verdad se aplica al render.
  montarSubs(config.captionStyle);
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
