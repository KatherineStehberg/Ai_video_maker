import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ensureDir, rel } from '../lib/paths.js';
import { newId, slugify, nowISO, estimateDuration, clamp } from '../lib/util.js';
import { ASPECTS } from '../config.js';

export const STATUS = Object.freeze({
  DRAFT: 'draft',
  QUEUED: 'queued',
  SCRIPTING: 'scripting',
  ASSETS_PENDING: 'assets_pending',
  RENDERING: 'rendering',
  COMPLETED: 'completed',
  FAILED: 'failed',
  HUMAN_REVIEW_REQUIRED: 'human_review_required',
});

export const TRANSITIONS = ['none', 'fade', 'fadeblack', 'slideleft', 'wipeleft'];

/** Escena vacia con valores por defecto. */
export function makeScene(partial = {}) {
  const text = partial.text ?? '';
  return {
    id: partial.id || newId('sc'),
    text,
    duration: clamp(Number(partial.duration) || estimateDuration(text), 0.5, 300),
    visualPrompt: partial.visualPrompt ?? '',
    assetPath: partial.assetPath ?? null,      // imagen o clip de video (relativo al ROOT)
    assetKind: partial.assetKind ?? 'auto',    // auto | image | video | color
    narrationPath: partial.narrationPath ?? null,
    narrationText: partial.narrationText ?? null,
    narrationKey: partial.narrationKey ?? null,
    durationLocked: partial.durationLocked ?? false,
    provenance: partial.provenance ?? { kind: 'unverified', authorized: false, originalReference: null },
    transition: TRANSITIONS.includes(partial.transition) ? partial.transition : 'fade',
    caption: partial.caption ?? null,          // null => se usa `text`
    kenBurns: partial.kenBurns ?? 'auto',      // auto | in | out | none
    onScreenTitle: partial.onScreenTitle ?? '',
    notes: partial.notes ?? '',
  };
}

/** Proyecto vacio con valores por defecto. */
export function makeProject(partial = {}) {
  const title = partial.title || 'Video sin titulo';
  const aspectRatio = ASPECTS[partial.aspectRatio] ? partial.aspectRatio : '9:16';
  return {
    schemaVersion: 1,
    id: partial.id || newId('vid'),
    title,
    slug: partial.slug || slugify(title),
    brand: partial.brand || 'ksl',
    template: partial.template || 'short-educativo',
    objective: partial.objective || '',
    audience: partial.audience || '',
    platform: Array.isArray(partial.platform) ? partial.platform : ['youtube'],
    aspectRatio,
    exportFormats: Array.isArray(partial.exportFormats) && partial.exportFormats.length
      ? partial.exportFormats.filter((a) => ASPECTS[a])
      : [aspectRatio],
    language: partial.language || 'es',
    brief: partial.brief || '',
    script: partial.script || '',
    studio: partial.studio ?? null,
    scenes: (partial.scenes || []).map(makeScene),
    voice: {
      provider: partial.voice?.provider ?? 'auto',   // auto | sapi | piper | none
      name: partial.voice?.name ?? '',
      rate: partial.voice?.rate ?? 0,                // -10..10 (SAPI)
      volume: partial.voice?.volume ?? 100,
      enabled: partial.voice?.enabled ?? true,
    },
    music: {
      path: partial.music?.path ?? null,
      volume: partial.music?.volume ?? 0.12,         // 0..1, bajo para no tapar la voz
      fadeIn: partial.music?.fadeIn ?? 1.5,
      fadeOut: partial.music?.fadeOut ?? 2,
      enabled: partial.music?.enabled ?? false,
    },
    captions: {
      enabled: partial.captions?.enabled ?? true,
      burnIn: partial.captions?.burnIn ?? true,      // quemados en el video
      fontSize: partial.captions?.fontSize ?? null,  // null => calculado por aspecto
      maxCharsPerLine: partial.captions?.maxCharsPerLine ?? 38,
      provider: partial.captions?.provider ?? 'auto',
      file: partial.captions?.file ?? null,
    },
    assets: {
      intro: partial.assets?.intro ?? null,
      outro: partial.assets?.outro ?? null,
      logo: partial.assets?.logo ?? null,            // null => usa el de la marca
      extra: partial.assets?.extra ?? [],
    },
    cta: partial.cta ?? '',
    status: partial.status || STATUS.DRAFT,
    outputPath: partial.outputPath ?? null,
    outputs: partial.outputs ?? {},                  // { "16:9": "output/final/...mp4" }
    metadata: partial.metadata ?? null,              // metadatos de publicacion generados
    renderLog: partial.renderLog ?? [],
    error: partial.error ?? null,
    createdAt: partial.createdAt || nowISO(),
    updatedAt: nowISO(),
  };
}

/** Valida un proyecto. Devuelve { ok, errors[], warnings[] }. */
export function validateProject(p) {
  const errors = [];
  const warnings = [];

  if (!p || typeof p !== 'object') return { ok: false, errors: ['Proyecto invalido'], warnings };
  if (!p.id) errors.push('Falta id');
  if (!p.title?.trim()) errors.push('Falta title');
  if (!ASPECTS[p.aspectRatio]) errors.push(`aspectRatio no soportado: ${p.aspectRatio}`);
  if (!Array.isArray(p.scenes) || p.scenes.length === 0) errors.push('El proyecto no tiene escenas');

  (p.scenes || []).forEach((s, i) => {
    const n = i + 1;
    if (!s.id) errors.push(`Escena ${n}: falta id`);
    if (!(Number(s.duration) > 0)) errors.push(`Escena ${n}: duracion invalida`);
    if (!s.text?.trim() && !s.assetPath) {
      warnings.push(`Escena ${n}: sin texto ni imagen, se rendera como fondo plano`);
    }
    if (s.assetPath) {
      const abs = path.resolve(PATHS.root, s.assetPath);
      if (!fs.existsSync(abs)) errors.push(`Escena ${n}: asset no encontrado -> ${s.assetPath}`);
    }
  });

  for (const fmt of p.exportFormats || []) {
    if (!ASPECTS[fmt]) errors.push(`exportFormats: formato no soportado ${fmt}`);
  }
  if (p.music?.enabled && p.music?.path) {
    if (!fs.existsSync(path.resolve(PATHS.root, p.music.path))) {
      errors.push(`Musica no encontrada -> ${p.music.path}`);
    }
  }
  const total = (p.scenes || []).reduce((a, s) => a + (Number(s.duration) || 0), 0);
  if (total > 600) warnings.push(`Duracion total ${Math.round(total)}s: el render en CPU sera lento`);

  return { ok: errors.length === 0, errors, warnings };
}

export function totalDuration(p) {
  return (p.scenes || []).reduce((a, s) => a + (Number(s.duration) || 0), 0);
}

export function projectFile(id) {
  return path.join(PATHS.projects, `${id}.json`);
}

/** Espera sincrona breve, sin dependencias ni busy-wait de CPU. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * En Windows, renameSync falla de forma transitoria con EPERM/EBUSY/EACCES
 * cuando un antivirus o el indexador aun mantiene abierto el .tmp recien
 * escrito. El contenido ya esta en disco: solo hay que reintentar el cambio de
 * nombre. Se reintenta con espera creciente (~900 ms en total) y se propaga
 * cualquier otro error sin enmascararlo.
 */
export function renameWithRetry(tmp, file, { attempts = 8, rename = fs.renameSync, sleep = sleepSync } = {}) {
  const transient = new Set(['EPERM', 'EBUSY', 'EACCES']);
  for (let i = 0; ; i++) {
    try {
      return rename(tmp, file);
    } catch (e) {
      if (i >= attempts || !transient.has(e.code)) throw e;
      sleep(25 * (i + 1));
    }
  }
}

export function saveProject(p) {
  ensureDir(PATHS.projects);
  p.updatedAt = nowISO();
  const file = projectFile(p.id);
  // Escritura atomica: evita dejar un JSON corrupto si el proceso muere a mitad.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2), 'utf8');
  renameWithRetry(tmp, file);
  return file;
}

export function loadProject(id) {
  const file = projectFile(id);
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Normaliza contra el esquema actual: permite reabrir proyectos viejos.
  return makeProject({ ...raw, createdAt: raw.createdAt, updatedAt: raw.updatedAt });
}

export function listProjects() {
  ensureDir(PATHS.projects);
  return fs.readdirSync(PATHS.projects)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(PATHS.projects, f), 'utf8'));
        return {
          id: p.id,
          title: p.title,
          brand: p.brand,
          template: p.template,
          aspectRatio: p.aspectRatio,
          status: p.status,
          scenes: p.scenes?.length || 0,
          duration: Math.round(totalDuration(p)),
          outputs: p.outputs || {},
          updatedAt: p.updatedAt,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export function deleteProject(id) {
  const file = projectFile(id);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file); // NO borra assets ni renders: son del usuario
  return true;
}

/** Registra una linea en el log del proyecto (acotado a 200 entradas). */
export function logToProject(p, message) {
  p.renderLog = [...(p.renderLog || []), `${nowISO()} ${message}`].slice(-200);
  return p;
}

export { rel };
