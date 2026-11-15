import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ensureDir } from '../lib/paths.js';
import { ASPECTS } from '../config.js';
import { makeProject, makeScene, saveProject, loadProject } from '../core/project.js';
import { listBrands } from '../core/brands.js';

/**
 * PROYECTO DEL EDITOR VISUAL A PARTIR DE UN VIDEO SUBIDO.
 *
 * El editor visual trabaja con proyectos de escenas; un video subido sólo tenía
 * análisis y montaje, así que el botón quedaba apagado. Aquí se crea un
 * proyecto de UNA escena cuyo fondo es el clip subido, sin narración ni
 * subtítulos, con la música del montaje más reciente. Desde el editor visual se
 * le pueden añadir textos, escenas, recursos y audio.
 *
 * - El clip se copia a data/assets/uploads/<análisis>.mp4: el renderer reconoce
 *   los videos por su extensión y el original se guarda sin ella.
 * - Es idempotente: el análisis guarda `projectId` y se reutiliza mientras el
 *   proyecto exista.
 * - Los recortes y cambios de velocidad del montaje no pasan al proyecto: una
 *   escena muestra el clip desde el principio.
 */
const dirAnalisis = () => path.join(PATHS.data, 'analyses');
const rel = p => path.relative(PATHS.root, p).split(path.sep).join('/');

function ultimoMontaje(analysisId) {
  const dir = path.join(PATHS.data, 'video-edits');
  let archivos = [];
  try { archivos = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return null; }
  let ultimo = null;
  for (const f of archivos) {
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (m.videoJobId !== analysisId) continue;
    const fecha = x => x.editedAt || x.createdAt || '';
    if (!ultimo || fecha(m) > fecha(ultimo)) ultimo = m;
  }
  return ultimo;
}

/** Formato más cercano a las proporciones del video. */
function formatoDe(width, height) {
  if (!(width > 0 && height > 0)) return '9:16';
  const r = width / height;
  return Object.entries(ASPECTS)
    .map(([id, a]) => ({ id, d: Math.abs(a.width / a.height - r) }))
    .sort((a, b) => a.d - b.d)[0].id;
}

/** Marca cuyo id aparece como palabra del nombre del archivo (famores-…mp4 -> famores). */
function marcaDe(nombre) {
  const palabras = new Set(String(nombre).toLowerCase().split(/[^a-z0-9]+/));
  try { return listBrands().find(b => palabras.has(String(b.id).toLowerCase()))?.id || 'personal'; }
  catch { return 'personal'; }
}

export function proyectoDesdeSubida(analysisId) {
  if (!/^[\da-f-]{36}$/.test(analysisId || '')) throw new Error('Análisis no válido');
  const ficha = path.join(dirAnalisis(), analysisId, 'analysis.json');
  let a;
  try { a = JSON.parse(fs.readFileSync(ficha, 'utf8')); } catch { throw new Error('Análisis no encontrado'); }
  if (a.status !== 'complete') throw new Error('El video todavía no termina de analizarse');

  if (a.projectId && loadProject(a.projectId)) return loadProject(a.projectId);

  const original = path.join(dirAnalisis(), analysisId, 'original');
  if (!fs.existsSync(original)) throw new Error('No se encuentra el video original');
  const clip = path.join(ensureDir(path.join(PATHS.data, 'assets', 'uploads')), `${analysisId}.mp4`);
  if (!fs.existsSync(clip)) fs.copyFileSync(original, clip);

  const nombre = a.fileName || `video-${analysisId.slice(0, 8)}.mp4`;
  const titulo = nombre.replace(/\.[^.]+$/, '');
  const montaje = ultimoMontaje(analysisId);
  const formato = ASPECTS[montaje?.format] ? montaje.format : formatoDe(a.metadata?.width, a.metadata?.height);
  const duracion = Number(a.metadata?.duration) || 5;
  const conAudio = Boolean(a.metadata?.audio?.length);

  const project = makeProject({
    title: titulo,
    brand: marcaDe(nombre),
    aspectRatio: formato,
    exportFormats: [formato],
    language: 'es',
    scenes: [makeScene({
      text: '',
      duration: duracion,
      durationLocked: true,
      assetPath: rel(clip),
      assetKind: 'video',
      kenBurns: 'none',
      provenance: { kind: 'upload', authorized: true, originalReference: `local:${nombre}` },
    })],
    voice: { enabled: false, provider: 'none' },
    captions: { enabled: false },
    // Sin narración la música es lo único que suena: va con el volumen del
    // montaje, o entero si el video no trae audio (ver defaultMusicVolume).
    music: montaje?.music?.path ? {
      path: montaje.music.path,
      enabled: true,
      volume: montaje.music.volume ?? (conAudio ? 0.16 : 1),
      credit: montaje.music.credit ?? null,
    } : undefined,
  });
  project.source = { kind: 'upload', analysisId, fileName: nombre, editId: montaje?.id ?? null };
  // El video subido ya trae su cierre: sin el rótulo de la marca encima
  // (con «Conoce Famores» tapaba el precio en los últimos segundos).
  project.cta = null;
  saveProject(project);

  a.projectId = project.id;
  fs.writeFileSync(ficha, JSON.stringify(a, null, 2));
  return project;
}
