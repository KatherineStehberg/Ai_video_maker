import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PATHS, ensureDir } from '../lib/paths.js';
import { ASPECTS } from '../config.js';
import { getProvider, DEFAULT_PROVIDER } from '../providers/video-generation/index.js';
import { analyzeExistingFile } from '../analysis/routes.js';
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

  return { prompt, duration, format, style,
    music: opcional('music'), tempo: opcional('tempo'),
    audience: opcional('audience'), platform: opcional('platform') };
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
