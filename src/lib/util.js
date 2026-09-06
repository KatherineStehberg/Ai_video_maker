import crypto from 'node:crypto';

export function newId(prefix = 'p') {
  const ts = Date.now().toString(36);
  const rnd = crypto.randomBytes(3).toString('hex');
  return `${prefix}_${ts}${rnd}`;
}

export function slugify(s = '', max = 48) {
  return String(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'sin-titulo';
}

export const nowISO = () => new Date().toISOString();

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
}

/** Segundos -> "HH:MM:SS,mmm" (SRT) */
export function srtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  const t = String(ms % 1000).padStart(3, '0');
  return `${h}:${m}:${s},${t}`;
}

/** Estimacion de duracion de lectura en voz alta (palabras por minuto). */
export function estimateDuration(text, wpm = 150) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  if (!words) return 2;
  return Math.max(1.5, (words / wpm) * 60);
}

/** Parte un texto largo en frases utilizables como escenas/subtitulos. */
export function splitSentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?…:])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Agrupa palabras en lineas de <= maxChars, sin cortar palabras. */
export function wrapText(text, maxChars = 38) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}
