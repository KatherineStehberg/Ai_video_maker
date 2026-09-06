import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ensureDir } from '../lib/paths.js';
import { newId, nowISO } from '../lib/util.js';
import { makeProject, saveProject, loadProject, STATUS } from './project.js';
import { getTemplate } from '../templates/index.js';
import { runPipeline } from './pipeline.js';
import { logger } from '../lib/logger.js';

const log = logger('jobs');

/**
 * COLA DE TRABAJOS — contrato para el Orquestador KSL.
 *
 * Cola en memoria con persistencia en disco, concurrencia 1.
 * Concurrencia 1 es deliberado: el render en una CPU de 2 nucleos satura
 * la maquina; dos renders en paralelo tardan mas que dos en serie.
 */

const JOBS_DIR = path.join(PATHS.data, 'jobs');
const MAX_CONCURRENT = 1;

/** Estados expuestos al Orquestador. */
export const JOB_STATUS = Object.freeze({
  QUEUED: 'queued',
  SCRIPTING: 'scripting',
  ASSETS_PENDING: 'assets_pending',
  RENDERING: 'rendering',
  COMPLETED: 'completed',
  FAILED: 'failed',
  HUMAN_REVIEW_REQUIRED: 'human_review_required',
});

/** Mapea el paso del pipeline al estado publico del job. */
const STEP_TO_STATUS = {
  script: JOB_STATUS.SCRIPTING,
  scenes: JOB_STATUS.SCRIPTING,
  assets: JOB_STATUS.ASSETS_PENDING,
  narration: JOB_STATUS.RENDERING,
  subtitles: JOB_STATUS.RENDERING,
  render: JOB_STATUS.RENDERING,
  encode: JOB_STATUS.RENDERING,
  compose: JOB_STATUS.RENDERING,
  concat: JOB_STATUS.RENDERING,
  audio: JOB_STATUS.RENDERING,
  scene: JOB_STATUS.RENDERING,
  metadata: JOB_STATUS.RENDERING,
  done: JOB_STATUS.COMPLETED,
};

const jobs = new Map();
const queue = [];
let running = 0;

function jobFile(id) {
  return path.join(ensureDir(JOBS_DIR), `${id}.json`);
}

function persist(job) {
  try {
    fs.writeFileSync(jobFile(job.id), JSON.stringify(job, null, 2), 'utf8');
  } catch (e) {
    log.warn('No se pudo persistir el job:', e.message);
  }
}

function update(job, patch) {
  Object.assign(job, patch, { updatedAt: nowISO() });
  persist(job);
  return job;
}

/** Carga jobs previos del disco. Los que quedaron corriendo se marcan fallidos. */
export function restoreJobs() {
  ensureDir(JOBS_DIR);
  for (const f of fs.readdirSync(JOBS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const job = JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), 'utf8'));
      if ([JOB_STATUS.RENDERING, JOB_STATUS.SCRIPTING, JOB_STATUS.QUEUED].includes(job.status)) {
        job.status = JOB_STATUS.FAILED;
        job.error = 'Interrumpido por reinicio del servidor';
      }
      jobs.set(job.id, job);
    } catch { /* job corrupto: se ignora */ }
  }
  return jobs.size;
}

/**
 * Crea un job. Payload del Orquestador KSL:
 *   { project?, brand, prompt, platform, format, priority, template, language,
 *     objective, audience, cta, title, autoRender }
 */
export function createJob(payload = {}) {
  const id = newId('job');

  let projectId = payload.project;
  if (projectId && !loadProject(projectId)) projectId = null;

  if (!projectId) {
    const template = getTemplate(payload.template);
    const formats = Array.isArray(payload.format)
      ? payload.format
      : payload.format ? [payload.format] : template.exportFormats;

    const project = makeProject({
      title: payload.title || String(payload.prompt || 'Video').slice(0, 80),
      brand: payload.brand || 'ksl',
      template: template.id,
      brief: payload.prompt || '',
      objective: payload.objective || '',
      audience: payload.audience || '',
      cta: payload.cta || '',
      language: payload.language || 'es',
      aspectRatio: formats[0] || template.aspectRatio,
      exportFormats: formats,
      platform: Array.isArray(payload.platform)
        ? payload.platform
        : payload.platform ? [payload.platform] : template.platform,
      status: STATUS.QUEUED,
    });
    saveProject(project);
    projectId = project.id;
  }

  const job = {
    id,
    projectId,
    status: JOB_STATUS.QUEUED,
    priority: Number(payload.priority) || 5,   // 1 = mas alta
    progress: 0,
    message: 'En cola',
    steps: payload.steps || null,
    formats: Array.isArray(payload.format) ? payload.format : payload.format ? [payload.format] : null,
    stopOnMissingAssets: payload.stopOnMissingAssets ?? false,
    source: payload.source || 'api',
    result: null,
    error: null,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    startedAt: null,
    finishedAt: null,
  };

  jobs.set(id, job);
  persist(job);

  queue.push(id);
  queue.sort((a, b) => (jobs.get(a)?.priority ?? 5) - (jobs.get(b)?.priority ?? 5));
  setImmediate(drain);

  return job;
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function listJobs({ status = null, limit = 50 } = {}) {
  return [...jobs.values()]
    .filter((j) => !status || j.status === status)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit);
}

/** Cancela un job que todavia no empezo. Un render en curso no se interrumpe. */
export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.status !== JOB_STATUS.QUEUED) {
    return { ok: false, reason: `El job esta en estado ${job.status} y no se puede cancelar` };
  }
  const i = queue.indexOf(id);
  if (i >= 0) queue.splice(i, 1);
  update(job, { status: JOB_STATUS.FAILED, error: 'Cancelado por el usuario', finishedAt: nowISO() });
  return { ok: true, job };
}

async function drain() {
  if (running >= MAX_CONCURRENT || !queue.length) return;
  const id = queue.shift();
  const job = jobs.get(id);
  if (!job || job.status !== JOB_STATUS.QUEUED) return setImmediate(drain);

  running++;
  update(job, { status: JOB_STATUS.SCRIPTING, startedAt: nowISO(), message: 'Iniciando' });

  try {
    const project = loadProject(job.projectId);
    if (!project) throw new Error(`Proyecto ${job.projectId} no encontrado`);

    const report = await runPipeline(project, {
      steps: job.steps || undefined,
      formats: job.formats || undefined,
      stopOnMissingAssets: job.stopOnMissingAssets,
      onProgress: (p) => {
        update(job, {
          progress: Math.min(99, p.pct ?? job.progress),
          message: p.message || p.step,
          status: p.stopped ? JOB_STATUS.HUMAN_REVIEW_REQUIRED : (STEP_TO_STATUS[p.step] || job.status),
        });
      },
    });

    if (report.stopped === 'assets_pending') {
      update(job, {
        status: JOB_STATUS.HUMAN_REVIEW_REQUIRED,
        progress: 50,
        message: 'Faltan visuales: requiere revision humana',
        result: { warnings: report.warnings },
        finishedAt: nowISO(),
      });
    } else {
      update(job, {
        status: JOB_STATUS.COMPLETED,
        progress: 100,
        message: 'Completado',
        result: {
          projectId: project.id,
          outputs: report.project?.outputs || {},
          warnings: report.warnings,
          metadata: Object.keys(report.project?.metadata || {}),
        },
        finishedAt: nowISO(),
      });
    }
  } catch (e) {
    update(job, {
      status: JOB_STATUS.FAILED,
      message: 'Fallo',
      error: e.message,
      finishedAt: nowISO(),
    });
  } finally {
    running--;
    setImmediate(drain);
  }
}

/** Vista publica del job (lo que consume el Orquestador). */
export function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    projectId: job.projectId,
    status: job.status,
    progress: job.progress,
    message: job.message,
    priority: job.priority,
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

export function queueStats() {
  return {
    queued: queue.length,
    running,
    maxConcurrent: MAX_CONCURRENT,
    total: jobs.size,
  };
}
