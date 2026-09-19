import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PATHS, ensureDir } from '../lib/paths.js';
import { ASPECTS } from '../config.js';
import { getProvider, DEFAULT_PROVIDER } from '../providers/video-generation/index.js';
import { analyzeExistingFile } from '../analysis/routes.js';
import { draftScript } from './script.js';
import { vozDisponible } from './voice.js';
import { elegirTemplate } from '../providers/video-generation/pipeline.js';
import { planEdit } from '../edits/plan.js';
import { saveProposal } from '../edits/routes.js';

/**
 * Trabajo de generación: prompt -> video -> análisis -> propuesta de edición.
 *
 * Encadena los módulos que ya existen; no reimplementa ni el análisis ni la
 * edición. Termina en `completed` cuando hay una PROPUESTA lista, no un video
 * final: la aprobación humana y la exportación siguen siendo pasos aparte, con
 * las mismas garantías que en el flujo de subida.
 */

export const STATES = ['queued', 'generating', 'generated', 'analyzing', 'editing', 'completed', 'failed'];

/** Formatos ofrecidos en este flujo (el backend de edición admite alguno más). */
export const FORMATS = ['9:16', '16:9', '1:1'];
export const STYLES = ['cinematográfico', 'documental', 'dinámico', 'minimalista', 'corporativo'];
export const DURATION_LIMITS = { min: 3, max: 120 };
export const PROMPT_MAX = 2000;

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
      j.error = 'El servidor se reinició durante el proceso; vuelve a generar el video.';
    }
    jobs.set(id, j);
    return j;
  } catch { return null; }
}

/** Valida y normaliza lo que llega del formulario antes de tocar nada. */
export function normalizeSpec(input = {}) {
  const prompt = String(input.prompt ?? '').trim();
  if (!prompt) throw new Error('Escribe un prompt que describa el video que quieres.');
  if (prompt.length > PROMPT_MAX) throw new Error(`El prompt no puede superar ${PROMPT_MAX} caracteres.`);

  const duration = Number(input.duration ?? 15);
  if (!Number.isFinite(duration) || duration < DURATION_LIMITS.min || duration > DURATION_LIMITS.max) {
    throw new Error(`La duración debe estar entre ${DURATION_LIMITS.min} y ${DURATION_LIMITS.max} segundos.`);
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
    if (input.escenas.length > 20) throw new Error('Máximo 20 escenas por video.');
    escenas = input.escenas.map((e, i) => {
      const text = String(e?.text ?? '').trim();
      if (!text) throw new Error(`La escena ${i + 1} no tiene narración.`);
      const dur = Number(e?.duration ?? 4);
      if (!Number.isFinite(dur) || dur < 0.5 || dur > 30) throw new Error(`La duración de la escena ${i + 1} debe estar entre 0.5 y 30 segundos.`);
      return {
        role: String(e?.role ?? 'point').slice(0, 20),
        text: text.slice(0, 600),
        onScreenTitle: String(e?.onScreenTitle ?? '').trim().slice(0, 60),
        visualPrompt: String(e?.visualPrompt ?? '').trim().slice(0, 200),
        duration: Number(dur.toFixed(2)),
      };
    });
  }

  return { prompt, duration, format, style,
    music: opcional('music'), tempo: opcional('tempo'),
    audience: opcional('audience'), platform: opcional('platform'),
    templateId: input.templateId ? String(input.templateId) : null,
    scriptSource: escenas ? (input.scriptSource ? String(input.scriptSource) : 'editado') : null,
    escenas };
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
  return {
    voz: { nombre: voz.nombre, provider: voz.provider, esEspanol: voz.esEspanol, etiqueta: voz.etiqueta, aviso: voz.aviso },
    spec: { ...spec, templateId },
    templateId,
    source: borrador.source,
    llmProvider: borrador.provider ?? 'ninguno',
    llmError: borrador.llmError ?? null,
    tema: borrador.tema ?? null,
    escenas: borrador.escenas,
    duracionEstimada: Number(borrador.escenas.reduce((a, e) => a + e.duration, 0).toFixed(2)),
    costo: estimarCosto(borrador),
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
export function createJob(input, { providerName = DEFAULT_PROVIDER } = {}) {
  const spec = normalizeSpec(input);
  if (running) throw new Error('Ya hay una generación en curso; espera a que termine.');
  const provider = getProvider(providerName);

  const job = {
    id: randomUUID(), status: 'queued', progress: 0, stage: 'En cola',
    createdAt: new Date().toISOString(), spec,
    provider: { id: provider.id, label: provider.label, mock: Boolean(provider.mock) },
    generation: null, analysisId: null, editId: null,
    warnings: [], error: null, finishedAt: null,
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
      onProgress: (p, stage) => progress(5 + Math.min(35, p * 0.35), stage || 'Generando el video'),
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
    progress(100, 'Listo para revisar y aprobar');
  } catch (e) {
    job.status = 'failed';
    job.error = e.message;
    job.stage = 'Error';
  } finally {
    job.elapsedMs = Date.now() - began;
    job.finishedAt = new Date().toISOString();
    running = false;
    try { persist(job); } catch { /* el estado en memoria sigue siendo válido */ }
  }
}

/** Vista pública: idéntica al job, pero sin rutas absolutas del servidor. */
export const publicJob = j => j && ({ ...j, generation: j.generation ? { ...j.generation } : null });
