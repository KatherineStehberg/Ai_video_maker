import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { workDir, rel, abs } from '../lib/paths.js';
import { srtTime, wrapText } from '../lib/util.js';
import { stripLangTags } from './lang.js';
import { captionMetrics, normalizeCaptionStyle } from './captions-style.js';
import { ASPECTS, CONFIG } from '../config.js';
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

/**
 * Divide el texto de una escena en cues que caben en pantalla.
 *
 * REPARTO EXACTO. Los bordes se calculan sobre el peso ACUMULADO, no sumando
 * duraciones una a una:
 *
 *     end(i) = start + duracion * (pesos[0..i] / pesoTotal)
 *
 * Asi los cues son contiguos, no se solapan y el ultimo cierra exactamente al
 * final de la escena, sin arrastre de redondeo.
 *
 * NO hay duracion minima por cue, y es deliberado. La version anterior forzaba
 * un minimo de 0,7 s; cuando una escena tenia muchos grupos, esos minimos
 * sumaban MAS que la escena y los ultimos cues se recortaban contra el final
 * hasta quedar en duracion cero. Resultado: el final de la escena se narraba
 * SIN subtitulo. Un cue corto es legible; un cue inexistente, no. Los cues por
 * debajo del umbral comodo se cuentan en `verifyCaptionCoverage` y se avisan,
 * en vez de provocar un agujero silencioso.
 */
function cuesForScene(text, start, duration, { maxChars, maxLines }) {
  const lines = wrapText(text, maxChars);
  if (!lines.length || !(duration > 0)) return [];

  // Agrupa de a `maxLines` lineas por cue: nunca mas de las que caben.
  const groups = [];
  for (let i = 0; i < lines.length; i += maxLines) {
    groups.push(lines.slice(i, i + maxLines).join('\n'));
  }

  // El peso es el numero de caracteres: leer mas texto lleva mas tiempo.
  const pesos = groups.map((g) => Math.max(1, g.replace(/\n/g, ' ').length));
  const total = pesos.reduce((a, b) => a + b, 0);

  const cues = [];
  let acumulado = 0;
  let anterior = start;
  for (let i = 0; i < groups.length; i++) {
    acumulado += pesos[i];
    const end = i === groups.length - 1
      ? start + duration                       // el ultimo cierra exacto
      : start + duration * (acumulado / total);
    cues.push({ start: anterior, end, text: groups[i] });
    anterior = end;
  }
  return cues;
}

/**
 * Construye todos los cues del proyecto a partir del timeline de escenas.
 *
 * El ancho de linea sale de la METRICA del formato (ver captions-style.js): con
 * letra mas grande caben menos caracteres, asi que el corte de linea y el
 * tamano de fuente tienen que decidirse juntos o el texto se sale del encuadre.
 *
 * `captions.maxCharsPerLine` sigue mandando si esta declarado explicitamente:
 * es un ajuste manual y no se pisa.
 */
export function buildCues(project, { width = null, height = null } = {}) {
  const dims = ASPECTS[project?.aspectRatio] || ASPECTS['9:16'];
  const w = width ?? dims.width;
  const h = height ?? dims.height;
  const m = captionMetrics(w, h, project?.captions?.style || {});

  const maxChars = project?.captions?.maxCharsPerLine || m.maxCharsPerLine;
  const maxLines = m.maxLines;

  const cues = [];
  let t = 0;
  for (const s of project?.scenes || []) {
    // Las marcas [en]/[es] son de produccion: se narran como cambio de voz,
    // nunca se leen en pantalla.
    //
    // `caption` vacio o en blanco NO silencia el subtitulo: se entiende como
    // «no se ha escrito un subtitulo propio» y manda la narracion. Dejar una
    // escena narrada sin subtitulo solo se consigue apagando los subtitulos
    // del proyecto entero.
    const propio = stripLangTags(s.caption ?? '');
    const text = propio || stripLangTags(s.text ?? '');
    const dur = Number(s.duration) || 0;
    if (text) cues.push(...cuesForScene(text, t, dur, { maxChars, maxLines }));
    t += dur;
  }
  return cues;
}

/** Umbral por debajo del cual un cue pasa demasiado rapido para leerse. */
export const CUE_MINIMO_COMODO = 0.5;

/**
 * Comprueba que NINGUNA parte narrada se queda sin subtitulo.
 *
 * Es la garantia del requisito «subtitular todo el video»: se verifica escena
 * por escena, no en total, porque un promedio global puede tapar una escena
 * entera sin cues.
 */
export function verifyCaptionCoverage(project, { width = null, height = null } = {}) {
  const escenas = project?.scenes || [];
  const problemas = [];
  const rapidos = [];
  let narrados = 0;
  let cubiertos = 0;

  let t = 0;
  for (const [i, s] of escenas.entries()) {
    const dur = Number(s.duration) || 0;
    const propio = stripLangTags(s.caption ?? '');
    const texto = propio || stripLangTags(s.text ?? '');
    if (texto && dur > 0) {
      narrados += dur;
      const cues = buildCues({ ...project, scenes: [s] }, { width, height });
      const cubre = cues.reduce((a, c) => a + Math.max(0, c.end - c.start), 0);
      cubiertos += cubre;
      if (!cues.length || cubre <= 0.01) {
        problemas.push(`Escena ${i + 1}: narra texto pero no produce ningun subtitulo.`);
      } else if (cubre < dur - 0.05) {
        problemas.push(`Escena ${i + 1}: ${(dur - cubre).toFixed(2)} s narrados sin subtitulo.`);
      }
      for (const c of cues) {
        if (c.end - c.start < CUE_MINIMO_COMODO) rapidos.push({ escena: i + 1, segundos: Number((c.end - c.start).toFixed(2)) });
      }
    }
    t += dur;
  }

  return {
    ok: problemas.length === 0,
    problemas,
    // No es un error: es un aviso de ritmo. El texto esta, pero pasa rapido.
    cuesRapidos: rapidos,
    segundosNarrados: Number(narrados.toFixed(2)),
    segundosConSubtitulo: Number(cubiertos.toFixed(2)),
    cobertura: narrados > 0 ? Number((cubiertos / narrados).toFixed(4)) : 1,
    duracionTotal: Number(t.toFixed(2)),
  };
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

/**
 * #RRGGBB + opacidad -> &HAABBGGRR (el formato de color de ASS).
 *
 * OJO con el canal alfa: en ASS 00 es OPACO y FF es TRANSPARENTE, al reves de
 * lo que espera casi todo el mundo. Por eso se invierte aqui y no en la
 * interfaz, donde `opacity: 1` significa lo que parece.
 */
function hexToAss(hex, opacity = 1) {
  const h = String(hex || '#ffffff').replace('#', '').padEnd(6, 'f');
  const alpha = Math.round((1 - Math.min(1, Math.max(0, Number(opacity)))) * 255)
    .toString(16).padStart(2, '0');
  return `&H${alpha}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}

/**
 * Alineacion de ASS a partir de posicion + alineacion horizontal.
 *
 * Los valores siguen la disposicion del teclado numerico:
 *   7 8 9   arriba
 *   4 5 6   centro
 *   1 2 3   abajo
 */
export function assAlignment(position, alignment) {
  const fila = position === 'top' ? 6 : position === 'center' ? 3 : 0;
  const columna = alignment === 'left' ? 1 : alignment === 'right' ? 3 : 2;
  return fila + columna;
}

/**
 * Genera un archivo ASS completo.
 *
 * Es necesario en vez de pasar un .srt con force_style: al convertir SRT,
 * FFmpeg fija PlayResY=288, asi que cualquier FontSize se escala x6.7 en un
 * video de 1920 de alto. Escribiendo el ASS declaramos PlayRes = tamano real
 * del video y el tamano de fuente pasa a estar en pixeles reales.
 *
 * Todo el estilo sale de `captionMetrics`, que ya resolvio tamano, margenes y
 * zonas seguras para ESTE formato. Aqui no se calcula ninguna medida.
 */
export function cuesToAss(cues, { width = 1080, height = 1920, style = {}, fontName = null } = {}) {
  const m = captionMetrics(width, height, style);
  const s = m.style;
  const familia = fontName || s.fontFamily || 'Arial';

  // BorderStyle 3 = caja opaca detras del texto; 1 = contorno + sombra.
  const caja = s.background === 'box';
  const borderStyle = caja ? 3 : 1;
  // Con caja, `Outline` deja de ser el grosor del contorno y pasa a ser el
  // relleno de la caja alrededor del texto.
  const outlineW = caja ? Math.max(2, Math.round(m.fontSize / 4)) : m.outlineWidth;
  const colorFondo = caja
    ? hexToAss(s.backgroundColor, s.backgroundOpacity)
    : hexToAss('#000000', 0.5);
  const colorContorno = s.background === 'none'
    ? hexToAss(s.outlineColor, 0)          // sin fondo ni contorno: invisible
    : hexToAss(s.outlineColor, 1);

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
    `Style: Main,${familia},${m.fontSize},${hexToAss(s.color, 1)},${hexToAss(s.color, 1)},` +
      `${colorContorno},${colorFondo},${s.bold ? -1 : 0},0,0,0,100,100,0,0,${borderStyle},` +
      `${outlineW},0,${assAlignment(s.position, s.alignment)},` +
      `${m.marginH},${m.marginH},${m.marginV},1`,
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
 *
 * El estilo del PROYECTO manda sobre el de la marca: es lo que el usuario
 * controla desde la interfaz. La marca solo aporta el color por defecto cuando
 * el proyecto no fija uno.
 */
export function writeAssForFormat(project, { width, height, brand = {}, suffix = '' }) {
  const cues = buildCues(project, { width, height });
  if (!cues.length) return null;

  const guardado = project.captions?.style || {};
  const style = normalizeCaptionStyle({
    ...guardado,
    // `captions.fontSize` es el ajuste manual historico: sigue mandando.
    fontSize: project.captions?.fontSize ?? guardado.fontSize ?? null,
    color: guardado.color ?? brand.colors?.captionText,
    outlineColor: guardado.outlineColor ?? brand.colors?.captionOutline,
  });

  const file = path.join(workDir(project.id), `captions${suffix}.ass`);
  fs.writeFileSync(file, cuesToAss(cues, {
    width,
    height,
    style,
    // La fuente de la marca solo se usa si el proyecto no eligio una.
    fontName: guardado.fontFamily || (brand.fontFamily || '').split(',')[0].trim() || null,
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
