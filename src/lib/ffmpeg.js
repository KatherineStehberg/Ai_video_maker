import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';
import { PATHS } from './paths.js';

const log = logger('ffmpeg');
let cached = null;

async function tryNodeModule(name) {
  try {
    const mod = await import(name);
    const v = mod.default ?? mod;
    const p = typeof v === 'string' ? v : v?.path;
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* paquete opcional no instalado: es un caso normal */
  }
  return null;
}

function fromPathEnv(exe) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const d of dirs) {
    if (!d) continue;
    for (const ext of exts) {
      const candidate = path.join(d, exe + ext);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* ruta inaccesible */
      }
    }
  }
  return null;
}

const COMMON_WIN = (exe) => [
  path.join('C:', 'ffmpeg', 'bin', `${exe}.exe`),
  path.join('C:', 'Program Files', 'ffmpeg', 'bin', `${exe}.exe`),
  path.join('C:', 'ProgramData', 'chocolatey', 'bin', `${exe}.exe`),
  path.join(PATHS.root, 'bin', `${exe}.exe`),
];

/**
 * Resuelve los binarios de ffmpeg/ffprobe en este orden:
 *   1. Variables de entorno explicitas (FFMPEG_PATH / FFPROBE_PATH)
 *   2. Paquetes npm ffmpeg-static / ffprobe-static (instalacion local, sin admin)
 *   3. PATH del sistema
 *   4. Rutas comunes de Windows
 */
export async function resolveFfmpeg({ force = false } = {}) {
  if (cached && !force) return cached;

  let ffmpeg = process.env.FFMPEG_PATH || null;
  if (ffmpeg && !fs.existsSync(ffmpeg)) {
    log.warn('FFMPEG_PATH apunta a un archivo inexistente:', ffmpeg);
    ffmpeg = null;
  }
  if (!ffmpeg) ffmpeg = await tryNodeModule('ffmpeg-static');
  if (!ffmpeg) ffmpeg = fromPathEnv('ffmpeg');
  if (!ffmpeg) ffmpeg = COMMON_WIN('ffmpeg').find((p) => fs.existsSync(p)) || null;

  let ffprobe = process.env.FFPROBE_PATH || null;
  if (ffprobe && !fs.existsSync(ffprobe)) ffprobe = null;
  if (!ffprobe) ffprobe = await tryNodeModule('ffprobe-static');
  if (!ffprobe) ffprobe = fromPathEnv('ffprobe');
  if (!ffprobe) ffprobe = COMMON_WIN('ffprobe').find((p) => fs.existsSync(p)) || null;
  // ffmpeg-static no trae ffprobe; si ffmpeg viene del sistema, ffprobe suele estar al lado.
  if (!ffprobe && ffmpeg) {
    const exe = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
    const sibling = path.join(path.dirname(ffmpeg), exe);
    if (fs.existsSync(sibling)) ffprobe = sibling;
  }

  cached = { ffmpeg, ffprobe, available: Boolean(ffmpeg) };
  return cached;
}

/** Ejecuta un binario y devuelve {code, stdout, stderr}. No lanza por exit code != 0. */
export function run(bin, args, { onProgress, cwd, timeoutMs = 30 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!bin) return reject(new Error('Binario no disponible (ffmpeg/ffprobe no encontrado)'));
    const child = spawn(bin, args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Timeout de FFmpeg'));
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (stderr.length > 400_000) stderr = stderr.slice(-200_000); // evita crecer sin limite
      if (onProgress) {
        const m = s.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
        if (m) onProgress(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Ejecuta ffmpeg y lanza error con las ultimas lineas de stderr si falla. */
export async function ffmpegRun(args, opts = {}) {
  const { ffmpeg } = await resolveFfmpeg();
  if (!ffmpeg) throw new Error('FFmpeg no esta disponible. Ejecuta: npm run doctor');
  const res = await run(ffmpeg, ['-hide_banner', '-nostdin', '-y', ...args], opts);
  if (res.code !== 0) {
    const tail = res.stderr.split('\n').filter(Boolean).slice(-12).join('\n');
    throw new Error(`FFmpeg fallo (code ${res.code}):\n${tail}`);
  }
  return res;
}

/** Duracion en segundos de un archivo de media. null si no se puede leer. */
export async function probeDuration(file) {
  const { ffprobe, ffmpeg } = await resolveFfmpeg();
  if (ffprobe) {
    const res = await run(ffprobe, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1',
      file,
    ]);
    const d = parseFloat(res.stdout.trim());
    if (Number.isFinite(d) && d > 0) return d;
  }
  if (ffmpeg) {
    // Fallback sin ffprobe: leer "Duration:" del stderr de ffmpeg.
    const res = await run(ffmpeg, ['-i', file]);
    const m = res.stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  return null;
}

const BACKSLASH = String.fromCharCode(92);

/**
 * Escapa una ruta para usarla DENTRO del valor de un filtro (subtitles=..., etc).
 * En Windows hay que pasar de "C:\a\b.srt" a "C\:/a/b.srt".
 */
export function escapeFilterPath(p) {
  return String(p)
    .split(BACKSLASH).join('/')
    .split(':').join(BACKSLASH + ':')
    .split("'").join(BACKSLASH + "'")
    .split('[').join(BACKSLASH + '[')
    .split(']').join(BACKSLASH + ']')
    .split(',').join(BACKSLASH + ',');
}

/** Escapa texto para el filtro drawtext. */
export function escapeDrawtext(t) {
  return String(t)
    .split(BACKSLASH).join(BACKSLASH + BACKSLASH)
    .split(':').join(BACKSLASH + ':')
    .split("'").join('\u2019')
    .split('%').join(BACKSLASH + '%');
}

/** Escapa un valor para el parametro force_style de subtitles (ASS override). */
export function escapeStyleValue(v) {
  return String(v).split(',').join(' ').split("'").join('');
}

/**
 * Transiciones que ESTE FFmpeg sabe hacer (nombres del filtro `xfade`).
 *
 * Se pregunta al binario en vez de suponerlo: una compilacion sin `xfade`, o
 * mas vieja, no trae todas. Lo que no este aqui se ofrece deshabilitado, nunca
 * simulado con otra cosa. El resultado se cachea: no cambia en caliente.
 */
let _xfade = null;
export async function xfadeDisponibles() {
  if (_xfade) return _xfade;
  const { ffmpeg } = await resolveFfmpeg();
  if (!ffmpeg) return (_xfade = []);
  const res = await run(ffmpeg, ['-hide_banner', '-h', 'filter=xfade']);
  const texto = `${res.stdout}\n${res.stderr}`;
  // La ayuda lista cada transicion como una linea "  nombre  <n>  ..E..V.....".
  const nombres = new Set();
  for (const linea of texto.split('\n')) {
    const m = /^\s{2,}([a-z][a-z0-9_]*)\s+\d+\s+\.{0,2}[A-Z.]{5,}/.exec(linea);
    if (m) nombres.add(m[1]);
  }
  return (_xfade = [...nombres]);
}
