import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { workDir, rel, abs } from '../lib/paths.js';
import { srtTime, wrapText, clamp } from '../lib/util.js';
import { stripLangTags } from './lang.js';
import { CONFIG } from '../config.js';
import { logger } from '../lib/logger.js';

const log = logger('subs');

/**
 * SUBTITULOS
 *
 * Estrategia por defecto: 'estimated'.
 * Como el texto narrado ya lo conocemos (lo escribimos nosotros), no hace falta
 * transcribir con Whisper. Repartimos el tiempo de cada escena entre sus lineas
 * proporcionalmente al numero de caracteres. Es exacto a nivel de escena,
 * cuesta 0 CPU y no requiere descargar ningun modelo.
 *
 * Whisper queda como provider OPCIONAL para cuando la narracion viene de un
 * audio externo del que no tenemos el texto.
 */

/** Divide el texto de una escena en cues que caben en pantalla. */
function cuesForScene(text, start, duration, maxChars) {
  const lines = wrapText(text, maxChars);
  if (!lines.length) return [];

  // Agrupa de a 2 lineas por cue: es lo que se lee comodo en vertical.
  const groups = [];
  for (let i = 0; i < lines.length; i += 2) {
    groups.push(lines.slice(i, i + 2).join('\n'));
  }

  const totalChars = groups.reduce((a, g) => a + g.replace(/\n/g, ' ').length, 0) || 1;
  const cues = [];
  let t = start;
  groups.forEach((g, i) => {
    const share = g.replace(/\n/g, ' ').length / totalChars;
    let d = duration * share;
    if (i === groups.length - 1) d = start + duration - t; // el ultimo cierra exacto
    d = clamp(d, 0.7, 8);
    cues.push({ start: t, end: Math.min(t + d, start + duration), text: g });
    t += d;
  });
  return cues;
}

/** Construye todos los cues del proyecto a partir del timeline de escenas. */
export function buildCues(project) {
  const maxChars = project.captions?.maxCharsPerLine || 38;
  const cues = [];
  let t = 0;
  for (const s of project.scenes || []) {
    // Las marcas [en]/[es] son de produccion: se narran como cambio de voz,
    // nunca se leen en pantalla.
    const text = stripLangTags(s.caption ?? s.text ?? '');
    const dur = Number(s.duration) || 0;
    if (text) cues.push(...cuesForScene(text, t, dur, maxChars));
    t += dur;
  }
  return cues;
}

export function cuesToSrt(cues) {
  return cues
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`)
    .join('\n');
}

/** Genera el .srt del proyecto. Devuelve ruta relativa al ROOT, o null. */
export async function generateSubtitles(project, { provider = 'auto' } = {}) {
  if (project.captions?.enabled === false) return null;

  const chosen = provider !== 'auto'
    ? provider
    : (project.captions?.provider && project.captions.provider !== 'auto'
      ? project.captions.provider
      : CONFIG.subtitles.provider);

  const out = path.join(workDir(project.id), 'captions.srt');

  if (chosen === 'whisper') {
    try {
      const srt = await transcribeWithWhisper(project);
      if (srt) return srt;
      log.warn('Whisper no produjo salida, se usa estimacion');
    } catch (e) {
      log.warn('Whisper fallo, se usa estimacion:', e.message);
    }
  }

  const cues = buildCues(project);
  if (!cues.length) return null;
  fs.writeFileSync(out, cuesToSrt(cues), 'utf8');
  return rel(out);
}

/**
 * Provider OPCIONAL: whisper.cpp / faster-whisper.
 * No descarga modelos. Requiere WHISPER_BIN y WHISPER_MODEL en .env.
 * Solo tiene sentido si la narracion viene de audio externo.
 */
export async function transcribeWithWhisper(project) {
  const bin = CONFIG.subtitles.whisperBin;
  const model = CONFIG.subtitles.whisperModel;
  if (!bin || !model) throw new Error('Whisper no configurado (WHISPER_BIN / WHISPER_MODEL)');
  if (!fs.existsSync(bin)) throw new Error(`WHISPER_BIN no existe: ${bin}`);
  if (!fs.existsSync(abs(model))) throw new Error(`WHISPER_MODEL no existe: ${model}`);

  const narration = path.join(workDir(project.id), 'narration.wav');
  if (!fs.existsSync(narration)) throw new Error('No hay narration.wav para transcribir');

  const base = path.join(workDir(project.id), 'captions_whisper');
  const args = [
    '-m', abs(model),
    '-f', narration,
    '-l', project.language || 'es',
    '-osrt',
    '-of', base,
  ];

  await new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(-400)))));
  });

  const produced = `${base}.srt`;
  return fs.existsSync(produced) ? rel(produced) : null;
}

/** Segundos -> "H:MM:SS.cc" (formato de tiempo de ASS). */
function assTime(sec) {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/** #RRGGBB -> &HAABBGGRR */
function hexToAss(hex, alphaHex = '00') {
  const h = String(hex || '#ffffff').replace('#', '').padEnd(6, 'f');
  return `&H${alphaHex}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}

/**
 * Genera un archivo ASS completo.
 *
 * Es necesario en vez de pasar un .srt con force_style: al convertir SRT,
 * FFmpeg fija PlayResY=288, asi que cualquier FontSize se escala x6.7 en un
 * video de 1920 de alto. Escribiendo el ASS declaramos PlayRes = tamano real
 * del video y el tamano de fuente pasa a estar en pixeles reales.
 */
export function cuesToAss(cues, {
  width = 1080,
  height = 1920,
  fontName = 'Arial',
  fontSize = null,
  primary = '#ffffff',
  outline = '#000000',
  marginV = null,
  bold = true,
} = {}) {
  const size = fontSize || Math.round(height / 34);
  const outlineW = Math.max(2, Math.round(size / 11));
  const mv = marginV ?? Math.round(height * 0.10);
  const mh = Math.round(width * 0.06);

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour,' +
      ' Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline,' +
      ' Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Main,${fontName},${size},${hexToAss(primary)},${hexToAss(primary)},` +
      `${hexToAss(outline)},&H80000000,${bold ? -1 : 0},0,0,0,100,100,0,0,1,${outlineW},0,2,` +
      `${mh},${mh},${mv},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');

  const events = cues.map((c) => {
    const text = String(c.text)
      .split('\n').join('\\N')
      .split('{').join('(')
      .split('}').join(')');
    return `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Main,,0,0,0,,${text}`;
  }).join('\n');

  return `${header}\n${events}\n`;
}

/**
 * Escribe el .ass para un formato concreto. El .srt sigue siendo el artefacto
 * canonico que se entrega al usuario; el .ass solo existe para el quemado.
 */
export function writeAssForFormat(project, { width, height, brand = {}, suffix = '' }) {
  const cues = buildCues(project);
  if (!cues.length) return null;
  const file = path.join(workDir(project.id), `captions${suffix}.ass`);
  fs.writeFileSync(file, cuesToAss(cues, {
    width,
    height,
    fontName: (brand.fontFamily || 'Arial').split(',')[0].trim(),
    fontSize: project.captions?.fontSize || null,
    primary: brand.colors?.captionText || '#ffffff',
    outline: brand.colors?.captionOutline || '#000000',
  }), 'utf8');
  return file;
}

/** Exporta los cues como WebVTT (util para previsualizar en el navegador). */
export function cuesToVtt(cues) {
  const body = cues
    .map((c) => `${srtTime(c.start).replace(',', '.')} --> ${srtTime(c.end).replace(',', '.')}\n${c.text}\n`)
    .join('\n');
  return `WEBVTT\n\n${body}`;
}
