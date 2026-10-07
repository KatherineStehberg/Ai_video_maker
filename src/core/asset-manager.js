import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ensureDir, rel, abs, insideBase } from '../lib/paths.js';
import { provideImage } from '../providers/image/index.js';
import { listTracks, resolveTrack } from '../providers/music/index.js';
import { ASPECTS } from '../config.js';
import { slugify } from '../lib/util.js';
import { logger } from '../lib/logger.js';
import { busquedaDeEscena } from './keywords.js';
import { buscarVideos, importarVideo } from '../project-editor/video-library.js';

const log = logger('assets');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi']);

export function assetKind(p) {
  const ext = path.extname(p || '').toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  return 'unknown';
}

/** Lista los assets visuales disponibles (globales + de la marca). */
export function listAssets(brand = null) {
  const dirs = [];
  if (brand) dirs.push({ dir: path.join(PATHS.assetsBrands, brand, 'images'), scope: brand });
  dirs.push({ dir: PATHS.assetsImages, scope: 'global' });

  const out = [];
  for (const { dir, scope } of dirs) {
    if (!fs.existsSync(dir)) continue;
    const walk = (d, depth = 0) => {
      if (depth > 2) return;
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) { walk(full, depth + 1); continue; }
        const kind = assetKind(entry.name);
        if (kind === 'unknown') continue;
        let size = 0;
        try { size = fs.statSync(full).size; } catch { continue; }
        out.push({ name: entry.name, path: rel(full), kind, scope, size });
      }
    };
    walk(dir);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export { listTracks, resolveTrack };

/**
 * Guarda un archivo subido desde la UI.
 * Solo escribe dentro de data/assets: cualquier intento de salir se rechaza.
 */
export function saveUpload(filename, buffer, { brand = null, kind = 'image' } = {}) {
  const baseDir = kind === 'music'
    ? (brand ? path.join(PATHS.assetsBrands, brand, 'music') : PATHS.assetsMusic)
    : (brand ? path.join(PATHS.assetsBrands, brand, 'images') : PATHS.assetsImages);
  ensureDir(baseDir);

  const ext = path.extname(filename).toLowerCase();
  const stem = slugify(path.basename(filename, ext)) || 'asset';
  let target = path.join(baseDir, `${stem}${ext}`);
  let n = 1;
  while (fs.existsSync(target)) target = path.join(baseDir, `${stem}-${n++}${ext}`);

  if (!insideBase(PATHS.assets, path.relative(PATHS.assets, target))) {
    throw new Error('Ruta de destino invalida');
  }
  fs.writeFileSync(target, buffer);
  return { path: rel(target), name: path.basename(target), kind: assetKind(target) };
}

/**
 * Asegura que TODA escena tenga un visual.
 * Cae en cascada por los providers y termina en el generador FFmpeg,
 * que nunca falla. Nunca sobreescribe un asset elegido por el usuario.
 */
export async function ensureSceneAssets(project, brandObj, { provider = 'auto', onProgress, force = false } = {}) {
  const { width, height } = ASPECTS[project.aspectRatio] || ASPECTS['9:16'];
  const results = [];

  for (let i = 0; i < project.scenes.length; i++) {
    const scene = project.scenes[i];
    onProgress?.({ step: 'assets', index: i, total: project.scenes.length, sceneId: scene.id });

    if (!force && scene.assetPath && fs.existsSync(abs(scene.assetPath))) {
      if (project.visualMode === 'video-only' && assetKind(scene.assetPath) !== 'video') throw new Error(`Escena ${i + 1}: el recurso elegido es una imagen. Elige un clip o cambia el modo visual.`);
      results.push({ sceneId: scene.id, path: scene.assetPath, provider: 'existing' });
      continue;
    }

    let found = null;
    const mode = project.visualMode || 'prefer-video';
    scene.visualWarning = null;
    const consulta = scene.visualPrompt || busquedaDeEscena(scene.text, { tema: project.title || '' }) || scene.text;
    if (mode !== 'images' && provider === 'auto') {
      const clips = await buscarVideos({ consulta, aspecto: project.aspectRatio, idioma: project.language });
      const usados = new Set(project.scenes.filter(s => s.id !== scene.id).map(s => String(s.assetCredit?.idRemoto || '')));
      const candidato = clips.resultados?.find(v => !usados.has(v.id));
      if (candidato) {
        try {
          const clip = await importarVideo({ id: candidato.id, consulta, aspecto: project.aspectRatio });
          found = { path: clip.path, provider: 'pexels-video', credit: clip.credito };
        } catch (e) { scene.visualWarning = e.message; }
      }
      if (!found) scene.visualWarning = scene.visualWarning || clips.motivo || 'No se encontró un clip distinto para esta escena.';
      else scene.visualWarning = null;
      if (!found && mode === 'video-only') {
        throw new Error(`Escena ${i + 1}: ${scene.visualWarning} El modo solo video no sustituye clips por imágenes.`);
      }
    }
    if (!found) found = await provideImage(
      {
        // Sin instruccion visual se buscan las palabras clave de la escena, no
        // la frase entera: un buscador de imagenes con una frase de narracion
        // devuelve cualquier cosa.
        prompt: scene.visualPrompt || busquedaDeEscena(scene.text, {
          contexto: (project.scenes || []).filter(x => x.id !== scene.id).map(x => x.text),
          tema: project.title || '',
        }) || scene.text,
        scene,
        project,
        brand: brandObj,
        width,
        height,
      },
      provider,
    );

    if (found) {
      scene.assetPath = found.path;
      scene.assetKind = assetKind(found.path);
      // Procedencia y atribucion: quien puso la imagen y bajo que licencia.
      // Sin esto la interfaz no puede distinguir un fondo generado de una foto
      // de banco, ni acreditar al autor cuando la licencia lo pide.
      scene.assetProvider = found.provider || null;
      scene.assetCredit = found.credit || null;
      results.push({ sceneId: scene.id, ...found });
    } else {
      log.warn(`Escena ${i + 1}: sin visual disponible`);
      results.push({ sceneId: scene.id, path: null, provider: null });
    }
  }
  return results;
}

/** Escenas que siguen sin visual (para el estado assets_pending). */
export function missingAssets(project) {
  return (project.scenes || [])
    .map((s, i) => ({ n: i + 1, id: s.id, ok: Boolean(s.assetPath && fs.existsSync(abs(s.assetPath))) }))
    .filter((x) => !x.ok);
}

/**
 * Resuelve una ruta de asset enviada por el cliente.
 * Debe estar dentro de data/ u output/: nunca se sirve el resto del disco.
 */
export function resolveSafeAsset(p) {
  if (!p) return null;
  for (const base of [PATHS.data, PATHS.output]) {
    const resolved = path.resolve(PATHS.root, p);
    const relative = path.relative(base, resolved);
    if (!relative.startsWith('..') && !path.isAbsolute(relative) && fs.existsSync(resolved)) {
      return resolved;
    }
  }
  return null;
}
