import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PATHS, ensureDir } from '../lib/paths.js';
import { ASPECTS } from '../config.js';
import { getProvider, defaultProvider } from '../providers/video-generation/index.js';
import { analyzeExistingFile } from '../analysis/routes.js';
import { draftScript, segundosPorEscenaDe } from './script.js';
import { getTemplate } from '../templates/index.js';
import { vozDisponible } from './voice.js';
import { elegirTemplate } from '../providers/video-generation/pipeline.js';
import { planEdit } from '../edits/plan.js';
import { saveProposal } from '../edits/routes.js';
import { FORMATS, STYLES } from './formats.js';
import {
  PROMPT_MAX, SCRIPT_MAX_CHARS, DURATION_LIMITS, MAX_ESCENAS,
  SCENE_TEXT_MAX, SCENE_DURATION_LIMITS,
  mensajeGuionLargo, mensajePromptLargo,
} from './limits.js';
import { planificarDuracion, WPM_POR_DEFECTO, formatearDuracion } from './segmenter.js';
import { normalizeLogo, normalizeVoice, normalizeMusic, normalizeSubtitles, normalizeCourse, normalizeSourceReference } from './orchestrator-contract.js';
import { instantanea, ESTADO_LISTO, ESTADO_ERROR_RECUPERABLE, ESTADO_ERROR, ESTADO_EN_COLA } from './states.js';
import { loadProject, saveProject } from '../core/project.js';

/**
 * Trabajo de generación: prompt -> video -> análisis -> propuesta de edición.
 *
 * Encadena los módulos que ya existen; no reimplementa ni el análisis ni la
 * edición. Termina en `completed` cuando hay una PROPUESTA lista, no un video
 * final: la aprobación humana y la exportación siguen siendo pasos aparte, con
 * las mismas garantías que en el flujo de subida.
 */

export const STATES = ['queued', 'generating', 'generated', 'analyzing', 'editing', 'completed', 'failed'];

export { FORMATS, STYLES };

/**
 * Opciones de duración de la interfaz.
 *
 * `auto` es la primera a propósito: lo normal es que mande el guion. Los
 * presets siguen estando porque para un reel es cómodo pedir "15 segundos",
 * pero NO hay un botón separado para "video corto" y otro para "video largo":
 * es el mismo flujo y la misma lista.
 */
export const DURATION_OPTIONS = [
  { value: 'auto', label: 'Automática según el guion' },
  { value: 15, label: '15 segundos' },
  { value: 30, label: '30 segundos' },
  { value: 60, label: '1 minuto' },
  { value: 120, label: '2 minutos' },
  { value: 300, label: '5 minutos' },
  { value: 600, label: '10 minutos' },
  { value: 720, label: '12 minutos' },
  { value: 1800, label: '30 minutos' },
];

export { PROMPT_MAX, SCRIPT_MAX_CHARS, DURATION_LIMITS, MAX_ESCENAS };

const root = path.join(PATHS.data, 'video-generation');
const jobs = new Map();
let running = false;

const persist = j => { ensureDir(root); fs.writeFileSync(path.join(root, `${j.id}.json`), JSON.stringify(j, null, 2), 'utf8'); };

export function getJob(id) {
  if (!/^[\da-f-]{36}$/.test(id || '')) return null;
  if (jobs.has(id)) return jobs.get(id);
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, `${id}.json`), 'utf8'));
    // Un trabajo a medias tras un reinicio no se reanuda solo: podría volver a
    // gastar créditos en un proveedor de pago sin que nadie lo pida.
    if (!['completed', 'failed'].includes(j.status)) {
      j.status = 'failed';
      j.recuperable = Boolean(j.projectId);
      j.error = j.projectId
        ? 'El servidor se reinició durante el proceso. Lo ya producido sigue en disco: puedes reanudar este proyecto.'
        : 'El servidor se reinició antes de producir nada; vuelve a generar el video.';
      j.progreso = instantanea({
        etapa: j.projectId ? ESTADO_ERROR_RECUPERABLE : ESTADO_ERROR,
        hechas: j.progreso?.escenasCompletadas ?? 0,
        totales: j.progreso?.escenasTotales ?? 0,
        operacion: j.error,
      });
    }
    jobs.set(id, j);
    return j;
  } catch { return null; }
}

/**
 * Valida y normaliza lo que llega del formulario antes de tocar nada.
 *
 * Dos entradas de texto, con papeles distintos:
 *   - `prompt`: la IDEA. De ella se redacta un guion (plantilla local o LLM).
 *   - `script`: el GUION YA ESCRITO. Manda sobre el prompt y NO se reescribe
 *     ni se recorta; se segmenta en escenas conservando cada palabra.
 *
 * Basta con una de las dos. Ningún límite de aquí recorta texto en silencio:
 * o pasa entero, o la petición se rechaza diciendo el número exacto.
 */
export function normalizeSpec(input = {}) {
  const prompt = String(input.prompt ?? '').trim();
  const script = String(input.script ?? '').trim();

  if (!prompt && !script) {
    throw new Error('Escribe un prompt con tu idea, o pega el guion completo que quieres narrar.');
  }
  if (prompt.length > PROMPT_MAX) throw new Error(mensajePromptLargo(prompt.length));
  if (script.length > SCRIPT_MAX_CHARS) throw new Error(mensajeGuionLargo(script.length));

  // Duración objetivo: OPCIONAL. `auto` (y omitirla) deja que mande el guion.
  // En modo automático NO se recorta contenido para acortar el video: es lo que
  // necesita una lección de curso, donde manda el guion y no el reloj.
  const auto = input.duration === 'auto' || input.duration === null || input.duration === undefined || input.duration === '';
  const duration = auto ? null : Number(input.duration);
  if (!auto && (!Number.isFinite(duration) || duration < DURATION_LIMITS.min || duration > DURATION_LIMITS.max)) {
    throw new Error(`La duración debe estar entre ${DURATION_LIMITS.min} y ${DURATION_LIMITS.max} segundos, o ser "auto".`);
  }

  const format = String(input.format ?? '9:16');
  if (!FORMATS.includes(format) || !ASPECTS[format]) throw new Error(`Formato no admitido: ${format}. Usa ${FORMATS.join(', ')}.`);

  const style = input.style === undefined || input.style === null || input.style === '' ? STYLES[0] : String(input.style);
  if (!STYLES.includes(style)) throw new Error(`Estilo no admitido: ${style}. Usa ${STYLES.join(', ')}.`);

  // Campos opcionales: se guardan y se pasan al proveedor, sin interpretarlos.
  const opcional = clave => {
    const v = input[clave];
    if (v === undefined || v === null || String(v).trim() === '') return null;
    return String(v).trim().slice(0, 300);
  };

  // Escenas ya revisadas por la usuaria en el borrador. Si vienen, mandan sobre
  // cualquier redacción automática: el proveedor no vuelve a inventar el guion.
  let escenas = null;
  if (input.escenas !== undefined && input.escenas !== null) {
    if (!Array.isArray(input.escenas) || !input.escenas.length) throw new Error('Las escenas deben ser una lista con al menos una escena.');
    if (input.escenas.length > MAX_ESCENAS) {
      throw new Error(`El proyecto tiene ${input.escenas.length} escenas y el límite técnico es ${MAX_ESCENAS}. No se ha quitado ninguna: divide el guion en dos proyectos.`);
    }
    escenas = input.escenas.map((e, i) => {
      const text = String(e?.text ?? '').trim();
      if (!text) throw new Error(`La escena ${i + 1} no tiene narración.`);
      // El texto de escena NO se recorta: si no cabe, se rechaza y se dice.
      if (text.length > SCENE_TEXT_MAX) {
        throw new Error(`La escena ${i + 1} tiene ${text.length} caracteres de narración y el máximo por escena es ${SCENE_TEXT_MAX}. Pártela en dos escenas.`);
      }
      const dur = Number(e?.duration ?? 4);
      if (!Number.isFinite(dur) || dur < SCENE_DURATION_LIMITS.min || dur > SCENE_DURATION_LIMITS.max) {
        throw new Error(`La duración de la escena ${i + 1} debe estar entre ${SCENE_DURATION_LIMITS.min} y ${SCENE_DURATION_LIMITS.max} segundos.`);
      }
      return {
        role: String(e?.role ?? 'point').slice(0, 20),
        text,
        onScreenTitle: String(e?.onScreenTitle ?? '').trim().slice(0, 60),
        visualPrompt: String(e?.visualPrompt ?? '').trim().slice(0, 200),
        duration: Number(dur.toFixed(2)),
        seccion: e?.seccion ? String(e.seccion).slice(0, 120) : null,
      };
    });
  }

  // Velocidad de narración configurable: es lo que convierte palabras en
  // segundos, así que cambiarla cambia toda la planificación de duración.
  const wpm = Number(input.wpm) > 0 ? Math.min(400, Math.max(40, Number(input.wpm))) : WPM_POR_DEFECTO;

  return {
    prompt, script: script || null,
    duration, durationMode: auto ? 'auto' : 'fija', wpm,
    format, style,
    music: opcional('music'), tempo: opcional('tempo'),
    audience: opcional('audience'), platform: opcional('platform'),
    templateId: input.templateId ? String(input.templateId) : null,
    scriptSource: escenas ? (input.scriptSource ? String(input.scriptSource) : 'editado') : (script ? 'guion-propio' : null),
    escenas,
    // Marca y presentación. Nada de esto está incrustado en el código: viaja
    // con el proyecto y se puede cambiar por proyecto.
    brandId: input.brandId ? String(input.brandId).slice(0, 80) : 'personal',
    title: opcional('title'),
    logo: normalizeLogo(input.logo),
    voice: input.voice === undefined ? null : normalizeVoice(input.voice),
    musicTrack: input.musicTrack === undefined ? null : normalizeMusic(input.musicTrack),
    subtitles: input.subtitles === undefined ? null : normalizeSubtitles(input.subtitles),
    course: normalizeCourse(input.course),
    sourceReference: normalizeSourceReference(input.sourceReference),
    orchestratorProjectId: input.orchestratorProjectId ? String(input.orchestratorProjectId).slice(0, 120) : null,
  };
}

/**
 * Borrador: guion y escenas SIN producir nada. No renderiza, no sintetiza voz
 * y no descarga imágenes, así que es instantáneo y no puede costar dinero
 * salvo que haya un LLM de pago configurado, cosa que se declara en `costo`.
 */
export async function draftJob(input) {
  const spec = normalizeSpec(input);
  const templateId = spec.templateId || elegirTemplate(spec);
  const borrador = await draftScript(spec, { templateId });
  const voz = await vozDisponible();
  const duracionEstimada = Number(borrador.escenas.reduce((a, e) => a + e.duration, 0).toFixed(2));

  // Compatibilidad con la duración objetivo, si se pidió una. Es un AVISO:
  // nunca se quita contenido del guion para que cuadre el reloj.
  const avisos = [...(borrador.advertencias ?? [])];
  let compatible = null;
  if (spec.duration != null) {
    const margen = Math.max(5, spec.duration * 0.15);
    compatible = Math.abs(duracionEstimada - spec.duration) <= margen;
    if (!compatible) {
      avisos.push(
        duracionEstimada > spec.duration
          ? `El guion dura unos ${formatearDuracion(duracionEstimada)} y pediste ${formatearDuracion(spec.duration)}. ` +
            'No se ha recortado nada: sube la duración objetivo o acorta el guion.'
          : `El guion sólo da para unos ${formatearDuracion(duracionEstimada)} y pediste ${formatearDuracion(spec.duration)}. ` +
            'No se ha inventado contenido de relleno: baja la duración objetivo o alarga el guion.',
      );
    }
  }

  return {
    voz: { nombre: voz.nombre, provider: voz.provider, esEspanol: voz.esEspanol, etiqueta: voz.etiqueta, aviso: voz.aviso },
    spec: { ...spec, templateId },
    templateId,
    source: borrador.source,
    llmProvider: borrador.provider ?? 'ninguno',
    llmError: borrador.llmError ?? null,
    tema: borrador.tema ?? null,
    escenas: borrador.escenas,
    palabras: borrador.escenas.reduce((a, e) => a + String(e.text || '').trim().split(/\s+/).filter(Boolean).length, 0),
    wpm: spec.wpm,
    duracionEstimada,
    duracionEstimadaLegible: formatearDuracion(duracionEstimada),
    compatibleConObjetivo: compatible,
    advertencias: avisos,
    costo: estimarCosto(borrador),
  };
}

/**
 * Estimación PURA, sin redactar ni producir nada: cuántas palabras, cuántas
 * escenas y cuánto duraría. Es lo que la interfaz llama mientras se escribe el
 * guion, así que no puede tocar disco, red ni proveedores.
 */
export function planJob(input = {}) {
  const spec = normalizeSpec(input);
  const texto = spec.script || spec.prompt;
  // La misma ventana de escena que usará la segmentación real, para que lo
  // estimado y lo producido no se contradigan.
  const templateId = spec.templateId || elegirTemplate(spec);
  return {
    origen: spec.script ? 'guion' : 'prompt',
    templateId,
    ...planificarDuracion(texto, {
      wpm: spec.wpm,
      targetDurationSeconds: spec.duration,
      segundosPorEscena: segundosPorEscenaDe(getTemplate(templateId)),
      tema: spec.title || '',
    }),
    // El plan por escena se devuelve aparte del resumen: la interfaz muestra
    // el resumen y sólo pide el detalle cuando hace falta.
    plan: undefined,
    limites: { promptMax: PROMPT_MAX, scriptMax: SCRIPT_MAX_CHARS, maxEscenas: MAX_ESCENAS, duracion: DURATION_LIMITS },
  };
}

/**
 * Qué usaría cada pieza y si eso cuesta dinero. Se calcula a partir de lo que
 * está realmente configurado, no de lo que podría llegar a configurarse.
 */
export function estimarCosto(borrador = {}) {
  const piezas = [
    { pieza: 'Guion',
      proveedor: borrador.source === 'llm' ? `modelo ${borrador.provider}` : 'plantilla local (sin IA)',
      pago: borrador.source === 'llm' && !['ollama', 'ninguno'].includes(borrador.provider) },
    { pieza: 'Visuales',
      proveedor: process.env.PEXELS_API_KEY ? 'Pexels (free tier)' : 'fondos generados con FFmpeg',
      pago: false },
    { pieza: 'Voz', proveedor: 'TTS local (SAPI/Piper)', pago: false },
    { pieza: 'Subtítulos', proveedor: 'estimados en local', pago: false },
    { pieza: 'Montaje', proveedor: 'FFmpeg local', pago: false },
  ];
  const dePago = piezas.filter(p => p.pago);
  return {
    piezas,
    tieneCostoPotencial: dePago.length > 0,
    resumen: dePago.length
      ? `Podría consumir créditos: ${dePago.map(p => `${p.pieza} (${p.proveedor})`).join(', ')}.`
      : 'Sin coste: todo se produce en este equipo con software local.',
  };
}

/** Crea el trabajo en estado `queued` y lanza el proceso en segundo plano. */
export function createJob(input, { providerName = defaultProvider() } = {}) {
  const spec = normalizeSpec(input);
  if (running) throw new Error('Ya hay una generación en curso; espera a que termine.');
  const provider = getProvider(providerName);

  const job = {
    id: randomUUID(), status: 'queued', progress: 0, stage: 'En cola',
    createdAt: new Date().toISOString(), spec,
    provider: { id: provider.id, label: provider.label, mock: Boolean(provider.mock) },
    generation: null, analysisId: null, editId: null,
    projectId: null,
    // Progreso real, contado en escenas. Ver `states.js`.
    progreso: instantanea({ etapa: ESTADO_EN_COLA }),
    intentos: 0,
    warnings: [], error: null, finishedAt: null,
  };
  jobs.set(job.id, job);
  persist(job);
  running = true;
  void run(job, provider);
  return job;
}

/**
 * Reanuda un trabajo interrumpido SIN rehacer lo ya producido.
 *
 * No hay magia: el proyecto sigue en disco con sus escenas, sus WAV de voz y
 * sus clips MP4, y tanto el TTS como el render comprueban una huella antes de
 * rehacer nada. Reanudar es volver a recorrer el pipeline sobre ese mismo
 * proyecto; lo terminado se salta solo.
 */
export function resumeJob(id, { providerName = null } = {}) {
  const previo = getJob(id);
  if (!previo) throw new Error('Trabajo de generación no encontrado.');
  if (previo.status === 'completed') throw new Error('Ese proyecto ya terminó: no hay nada que reanudar.');
  if (!previo.projectId) {
    throw new Error('Ese proyecto falló antes de crear nada reutilizable. Vuelve a generarlo desde el guion.');
  }
  if (running) throw new Error('Ya hay una generación en curso; espera a que termine.');

  const provider = getProvider(providerName || previo.provider?.id || defaultProvider());
  const job = {
    ...previo,
    status: 'queued', progress: 0, stage: 'Reanudando',
    error: null,
    intentos: (previo.intentos || 0) + 1,
    reanudadoDe: previo.finishedAt || null,
    progreso: instantanea({ etapa: ESTADO_EN_COLA, operacion: 'Reanudando lo que quedó a medias' }),
    // El proyecto existente se reutiliza entero: aquí está el ahorro.
    spec: { ...previo.spec, resumeProjectId: previo.projectId },
    finishedAt: null,
  };
  jobs.set(job.id, job);
  persist(job);
  running = true;
  void run(job, provider);
  return job;
}

/**
 * Regenera UNA escena y vuelve a montar, conservando todo lo demás.
 *
 * Cambiar el texto de una escena invalida su WAV y su clip (las huellas dejan
 * de cuadrar) pero no toca las de las demás, así que el coste es el de una
 * escena más la concatenación final.
 */
export function regenerateScene(id, indice, parche = {}, { providerName = null } = {}) {
  const previo = getJob(id);
  if (!previo) throw new Error('Trabajo de generación no encontrado.');
  if (!previo.projectId) throw new Error('Ese proyecto todavía no tiene escenas producidas que reutilizar.');
  if (running) throw new Error('Ya hay una generación en curso; espera a que termine.');

  const project = loadProject(previo.projectId);
  if (!project) throw new Error('El proyecto ya no está en disco; vuelve a generarlo desde el guion.');
  const i = Number(indice);
  if (!Number.isInteger(i) || i < 0 || i >= project.scenes.length) {
    throw new Error(`La escena ${indice} no existe: el proyecto tiene ${project.scenes.length}.`);
  }

  const escena = project.scenes[i];
  if (parche.text !== undefined) {
    const text = String(parche.text).trim();
    if (!text) throw new Error('La escena necesita narración.');
    if (text.length > SCENE_TEXT_MAX) throw new Error(`La narración de la escena supera ${SCENE_TEXT_MAX} caracteres.`);
    escena.text = text;
  }
  if (parche.onScreenTitle !== undefined) escena.onScreenTitle = String(parche.onScreenTitle).slice(0, 60);
  if (parche.visualPrompt !== undefined) escena.visualPrompt = String(parche.visualPrompt).slice(0, 200);
  if (parche.duration !== undefined) {
    const d = Number(parche.duration);
    if (!Number.isFinite(d) || d < SCENE_DURATION_LIMITS.min || d > SCENE_DURATION_LIMITS.max) {
      throw new Error(`La duración de la escena debe estar entre ${SCENE_DURATION_LIMITS.min} y ${SCENE_DURATION_LIMITS.max} segundos.`);
    }
    escena.duration = Number(d.toFixed(2));
  }
  // Si se pide un visual nuevo, se suelta el asset para que se vuelva a buscar.
  if (parche.regenerarVisual) { escena.assetPath = null; escena.assetProvider = null; }
  saveProject(project);

  const provider = getProvider(providerName || previo.provider?.id || defaultProvider());
  const job = {
    ...previo,
    status: 'queued', progress: 0, stage: `Regenerando la escena ${i + 1}`,
    error: null,
    intentos: (previo.intentos || 0) + 1,
    escenaRegenerada: i,
    progreso: instantanea({ etapa: ESTADO_EN_COLA, operacion: `Regenerando sólo la escena ${i + 1}` }),
    spec: { ...previo.spec, resumeProjectId: previo.projectId },
    finishedAt: null,
  };
  jobs.set(job.id, job);
  persist(job);
  running = true;
  void run(job, provider);
  return job;
}

async function run(job, provider) {
  const began = Date.now();
  const progress = (percent, stage) => { job.progress = percent; job.stage = stage; persist(job); };
  const workDir = ensureDir(path.join(root, job.id));

  try {
    // ---- 1. Generar el video con el proveedor elegido -------------------
    job.status = 'generating';
    progress(5, 'Generando el video');
    const result = await provider.generate(job.spec, {
      workDir,
      // El proveedor manda el detalle real (etapa, escenas hechas y totales).
      // Aquí no se inventa avance: si no llega dato nuevo, el número no se mueve.
      onProgress: (p, stage, extra = {}) => {
        if (extra.projectId && !job.projectId) job.projectId = extra.projectId;
        if (extra.estado) {
          job.progreso = instantanea({
            etapa: extra.estado, hechas: extra.hechas ?? 0, totales: extra.totales ?? 0,
            operacion: stage, detalle: extra.detalle ?? null,
          });
        }
        progress(5 + Math.min(35, p * 0.35), stage || 'Generando el video');
      },
    });
    if (!result?.file || !fs.existsSync(result.file)) throw new Error('El proveedor no devolvió un archivo de video utilizable.');

    job.generation = {
      provider: result.provider, model: result.model ?? null, mock: Boolean(result.mock),
      file: path.relative(PATHS.root, result.file).split(path.sep).join('/'),
      bytes: (await fsp.stat(result.file)).size,
      notes: result.notes ?? [], usage: result.usage ?? null,
      elapsedMs: Date.now() - began,
    };
    if (result.mock) {
      job.warnings.push('Este video lo produjo el proveedor MOCK con FFmpeg: es material de prueba, no generación con IA, y no representa el contenido del prompt.');
    }
    job.warnings.push(...(result.notes ?? []));
    // El guion y las escenas realmente usadas viajan con el trabajo: la
    // interfaz los muestra y así queda claro qué se produjo y de dónde salió.
    if (result.script) job.script = result.script;
    // El id del proyecto es la llave para reanudar y para regenerar una escena.
    if (result.spec?.projectId) job.projectId = result.spec.projectId;
    job.status = 'generated';
    progress(40, 'Video generado');

    // ---- 2. Analizarlo con el pipeline existente ------------------------
    job.status = 'analyzing';
    progress(45, 'Analizando cortes, ritmo y duración');
    const analysis = await analyzeExistingFile(result.file, { label: `generación ${job.id}` });
    if (analysis.status !== 'complete') throw new Error(analysis.error || 'No se pudo analizar el video generado.');
    job.analysisId = analysis.id;
    progress(75, 'Análisis terminado');

    // ---- 3. Crear la propuesta de edición -------------------------------
    job.status = 'editing';
    progress(80, 'Preparando la propuesta de montaje');
    const proposal = planEdit(analysis, {
      format: job.spec.format, syncMode: 'beats', enableSpeedRamps: true, approvalRequired: true,
    });
    saveProposal(proposal);
    job.editId = proposal.id;
    job.warnings.push(...(proposal.warnings ?? []));

    job.status = 'completed';
    job.progreso = instantanea({
      etapa: ESTADO_LISTO,
      hechas: job.script?.escenas?.length ?? 0,
      totales: job.script?.escenas?.length ?? 0,
      operacion: 'Listo para revisar y aprobar',
    });
    progress(100, 'Listo para revisar y aprobar');
  } catch (e) {
    job.status = 'failed';
    job.error = e.message;
    job.stage = 'Error';
    // Si llegó a existir un proyecto en disco, lo producido sigue ahí y se
    // puede reanudar: eso es un error RECUPERABLE, y se declara como tal para
    // que la interfaz ofrezca reintentar en vez de empezar de cero.
    const recuperable = Boolean(job.projectId);
    job.recuperable = recuperable;
    job.progreso = instantanea({
      etapa: recuperable ? ESTADO_ERROR_RECUPERABLE : ESTADO_ERROR,
      hechas: job.progreso?.escenasCompletadas ?? 0,
      totales: job.progreso?.escenasTotales ?? 0,
      operacion: e.message,
      detalle: recuperable
        ? 'Las escenas ya terminadas se conservan; al reanudar sólo se rehace lo que falta.'
        : 'No llegó a producirse nada reutilizable.',
    });
  } finally {
    job.elapsedMs = Date.now() - began;
    job.finishedAt = new Date().toISOString();
    running = false;
    try { persist(job); } catch { /* el estado en memoria sigue siendo válido */ }
  }
}

/**
 * Proyectos recientes, leídos del disco. No borra nada: un trabajo antiguo
 * sigue estando disponible para retomarlo mientras exista su archivo.
 */
export function listJobs({ limit = 40 } = {}) {
  let archivos = [];
  try { archivos = fs.readdirSync(root).filter(f => f.endsWith('.json')); } catch { return []; }

  const proyectos = [];
  for (const archivo of archivos) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(root, archivo), 'utf8'));
      const interrumpido = !['completed', 'failed'].includes(j.status);
      proyectos.push({
        id: j.id,
        titulo: j.script?.tema || j.spec?.prompt?.slice(0, 70) || 'Proyecto sin título',
        prompt: j.spec?.prompt ?? '',
        estado: interrumpido ? 'interrumpido' : j.status,
        progreso: j.progreso ?? null,
        reanudable: Boolean(j.projectId) && j.status !== 'completed',
        projectId: j.projectId ?? null,
        formato: j.spec?.format ?? null,
        duracionPedida: j.spec?.duration ?? null,
        duracionReal: j.generation?.spec?.duracion?.real ?? null,
        escenas: j.script?.escenas?.length ?? null,
        creado: j.createdAt ?? null,
        terminado: j.finishedAt ?? null,
        analysisId: j.analysisId ?? null,
        editId: j.editId ?? null,
        proveedor: j.provider?.id ?? null,
        error: j.error ?? null,
      });
    } catch { /* un JSON corrupto no debe tumbar la lista entera */ }
  }
  return proyectos
    .sort((a, b) => String(b.creado).localeCompare(String(a.creado)))
    .slice(0, limit);
}

/** Vista pública: idéntica al job, pero sin rutas absolutas del servidor. */
export const publicJob = j => j && ({ ...j, generation: j.generation ? { ...j.generation } : null });
