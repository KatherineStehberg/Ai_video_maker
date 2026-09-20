import { FORMATS, STYLES } from './formats.js';
import {
  PROMPT_MAX, SCRIPT_MAX_CHARS, DURATION_LIMITS,
  mensajeGuionLargo, mensajePromptLargo,
} from './limits.js';

/**
 * CONTRATO DE ENTRADA para el Orquestador KSL.
 *
 * Esto es sólo el lado receptor: valida y normaliza lo que el Orquestador
 * enviará algún día. NO hay aquí ninguna llamada de red, ningún cliente del
 * Orquestador y ninguna credencial, y el repositorio del Orquestador NO se ha
 * tocado. Existe ahora para que el contrato quede fijado y probado antes de
 * que nadie escriba el emisor.
 *
 * `sourceReference` está pensado para que más adelante pueda apuntar a un
 * archivo de Drive, pero HOY es un descriptor opaco: se guarda tal cual, no se
 * resuelve, no se descarga y no se le pide credencial a nadie.
 */

/** Versión del contrato. Cambia si algún campo deja de aceptarse. */
export const CONTRACT_VERSION = '1.0.0';

/** Plataformas que el contrato reconoce. `otro` siempre vale. */
export const PLATFORMS = ['youtube', 'tiktok', 'instagram', 'linkedin', 'facebook', 'lms', 'otro'];

/** Tipos de `sourceReference` previstos. Ninguno se resuelve todavía. */
export const SOURCE_KINDS = ['inline', 'drive', 'url', 'archivo'];

const texto = (v, max, campo) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.length > max) throw new Error(`${campo} supera el límite de ${max} caracteres (tiene ${s.length}).`);
  return s;
};

const enumOpcional = (v, validos, campo) => {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const s = String(v).trim().toLowerCase();
  if (!validos.includes(s)) throw new Error(`${campo} no admitido: ${s}. Usa ${validos.join(', ')}.`);
  return s;
};

/**
 * Normaliza `sourceReference`. Acepta una cadena (se trata como texto en línea)
 * o un objeto { kind, id, name, text, mimeType }.
 *
 * NO lee Drive ni ninguna URL: sólo describe de dónde vendrá el material.
 */
export function normalizeSourceReference(input) {
  if (input === undefined || input === null || input === '') return null;
  if (typeof input === 'string') return { kind: 'inline', text: texto(input, SCRIPT_MAX_CHARS, 'sourceReference') };

  if (typeof input !== 'object') throw new Error('sourceReference debe ser texto o un objeto.');
  const kind = enumOpcional(input.kind, SOURCE_KINDS, 'sourceReference.kind') || 'inline';
  return {
    kind,
    id: texto(input.id, 300, 'sourceReference.id'),
    name: texto(input.name, 300, 'sourceReference.name'),
    mimeType: texto(input.mimeType, 120, 'sourceReference.mimeType'),
    text: texto(input.text, SCRIPT_MAX_CHARS, 'sourceReference.text'),
    // Se guarda pero NO se resuelve en esta versión.
    resolved: false,
  };
}

/**
 * Valida y normaliza una petición del Orquestador.
 *
 * Exige lo mínimo para poder producir algo: o `script`, o `prompt`, o un
 * `sourceReference` con texto. Todo lo demás es opcional y tiene defecto.
 *
 * @returns {object} spec normalizada, apta para `createJob`
 */
export function normalizeOrchestratorInput(input = {}) {
  if (!input || typeof input !== 'object') throw new Error('La petición debe ser un objeto JSON.');

  const prompt = texto(input.prompt, PROMPT_MAX, 'prompt');
  const script = texto(input.script, SCRIPT_MAX_CHARS, 'script');
  const sourceReference = normalizeSourceReference(input.sourceReference);

  if (!prompt && !script && !sourceReference?.text) {
    throw new Error('La petición necesita al menos `script`, `prompt` o un `sourceReference` con texto.');
  }

  // Duración objetivo: OPCIONAL. Sin ella manda el guion.
  let targetDurationSeconds = null;
  if (input.targetDurationSeconds !== undefined && input.targetDurationSeconds !== null
      && input.targetDurationSeconds !== '' && input.targetDurationSeconds !== 'auto') {
    const n = Number(input.targetDurationSeconds);
    if (!Number.isFinite(n) || n < DURATION_LIMITS.min || n > DURATION_LIMITS.max) {
      throw new Error(`targetDurationSeconds debe estar entre ${DURATION_LIMITS.min} y ${DURATION_LIMITS.max} segundos, u omitirse.`);
    }
    targetDurationSeconds = n;
  }

  const format = input.format === undefined || input.format === null || input.format === ''
    ? '16:9' : String(input.format);
  if (!FORMATS.includes(format)) throw new Error(`format no admitido: ${format}. Usa ${FORMATS.join(', ')}.`);

  const style = input.style === undefined || input.style === null || input.style === ''
    ? STYLES[0] : String(input.style);
  if (!STYLES.includes(style)) throw new Error(`style no admitido: ${style}. Usa ${STYLES.join(', ')}.`);

  return {
    contractVersion: CONTRACT_VERSION,
    projectId: texto(input.projectId, 120, 'projectId'),
    brandId: texto(input.brandId, 80, 'brandId'),
    title: texto(input.title, 200, 'title'),
    prompt,
    script,
    sourceReference,
    format,
    targetDurationSeconds,
    platform: enumOpcional(input.platform, PLATFORMS, 'platform'),
    style,
    voice: normalizeVoice(input.voice),
    music: normalizeMusic(input.music),
    subtitles: normalizeSubtitles(input.subtitles),
    logo: normalizeLogo(input.logo),
    course: normalizeCourse(input.course ?? input.metadata),
  };
}

/** Voz: motor y nombre. Nunca lleva claves; el TTS es local. */
export function normalizeVoice(voice) {
  if (!voice) return { provider: 'auto', name: null, rate: 0, enabled: true };
  if (typeof voice === 'string') return { provider: 'auto', name: texto(voice, 120, 'voice'), rate: 0, enabled: true };
  const rate = Number(voice.rate ?? 0);
  return {
    provider: enumOpcional(voice.provider, ['auto', 'sapi', 'piper', 'none'], 'voice.provider') || 'auto',
    name: texto(voice.name, 120, 'voice.name'),
    rate: Number.isFinite(rate) ? Math.max(-10, Math.min(10, rate)) : 0,
    enabled: voice.enabled !== false,
  };
}

/** Música: una ruta local opcional y su volumen. No descarga nada. */
export function normalizeMusic(music) {
  if (!music) return { enabled: false, path: null, volume: 0.12 };
  if (typeof music === 'string') return { enabled: true, path: texto(music, 400, 'music'), volume: 0.12 };
  const volume = Number(music.volume ?? 0.12);
  return {
    enabled: music.enabled !== false && Boolean(music.path),
    path: texto(music.path, 400, 'music.path'),
    volume: Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0.12,
  };
}

/** Subtítulos: activos por defecto, porque un video educativo los necesita. */
export function normalizeSubtitles(subtitles) {
  if (subtitles === undefined || subtitles === null) return { enabled: true, burnIn: true, language: 'es' };
  if (typeof subtitles === 'boolean') return { enabled: subtitles, burnIn: subtitles, language: 'es' };
  return {
    enabled: subtitles.enabled !== false,
    burnIn: subtitles.burnIn !== false,
    language: texto(subtitles.language, 12, 'subtitles.language') || 'es',
  };
}

/**
 * Logo: ruta, posición, escala y opacidad. Se declara por proyecto y NUNCA se
 * incrusta ningún logo concreto en el código.
 */
export function normalizeLogo(logo) {
  if (!logo) return null;
  if (typeof logo === 'string') return { path: texto(logo, 400, 'logo'), position: 'top-right', scale: 0.09, opacity: 0.85 };
  const scale = Number(logo.scale ?? 0.09);
  const opacity = Number(logo.opacity ?? 0.85);
  return {
    path: texto(logo.path, 400, 'logo.path'),
    position: enumOpcional(logo.position, ['top-right', 'top-left', 'bottom-right', 'bottom-left'], 'logo.position') || 'top-right',
    scale: Number.isFinite(scale) ? Math.max(0.02, Math.min(0.4, scale)) : 0.09,
    opacity: Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 0.85,
  };
}

/** Metadatos de curso, módulo o presentación. Se guardan tal cual. */
export function normalizeCourse(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const out = {
    courseId: texto(meta.courseId, 120, 'course.courseId'),
    courseName: texto(meta.courseName, 200, 'course.courseName'),
    moduleId: texto(meta.moduleId, 120, 'course.moduleId'),
    moduleName: texto(meta.moduleName, 200, 'course.moduleName'),
    lessonNumber: Number.isFinite(Number(meta.lessonNumber)) ? Number(meta.lessonNumber) : null,
    presentationId: texto(meta.presentationId, 120, 'course.presentationId'),
    tags: Array.isArray(meta.tags) ? meta.tags.slice(0, 20).map(t => String(t).slice(0, 60)) : [],
  };
  return Object.values(out).some(v => v !== null && !(Array.isArray(v) && !v.length)) ? out : null;
}

/**
 * Convierte una petición del contrato en el cuerpo que ya entiende
 * `createJob`. Es la única función que traduce entre los dos vocabularios.
 */
export function specDesdeContrato(contrato) {
  return {
    prompt: contrato.prompt || contrato.title || 'Video desde el Orquestador KSL',
    script: contrato.script || contrato.sourceReference?.text || null,
    duration: contrato.targetDurationSeconds ?? 'auto',
    format: contrato.format,
    style: contrato.style,
    platform: contrato.platform,
    brandId: contrato.brandId,
    title: contrato.title,
    logo: contrato.logo,
    voice: contrato.voice,
    music: contrato.music,
    subtitles: contrato.subtitles,
    course: contrato.course,
    sourceReference: contrato.sourceReference,
    orchestratorProjectId: contrato.projectId,
  };
}

export { PROMPT_MAX, SCRIPT_MAX_CHARS, mensajeGuionLargo, mensajePromptLargo };
