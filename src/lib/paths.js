import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const PATHS = {
  root: ROOT,
  src: path.join(ROOT, 'src'),
  ui: path.join(ROOT, 'src', 'ui'),
  data: path.join(ROOT, 'data'),
  brands: path.join(ROOT, 'data', 'brands'),
  projects: path.join(ROOT, 'data', 'projects'),
  assets: path.join(ROOT, 'data', 'assets'),
  assetsImages: path.join(ROOT, 'data', 'assets', 'images'),
  assetsMusic: path.join(ROOT, 'data', 'assets', 'music'),
  // Efectos de sonido de la biblioteca local, cada uno con su ficha de licencia.
  assetsSfx: path.join(ROOT, 'data', 'assets', 'sfx'),
  assetsFonts: path.join(ROOT, 'data', 'assets', 'fonts'),
  assetsBrands: path.join(ROOT, 'data', 'assets', 'brands'),
  models: path.join(ROOT, 'models'),
  output: path.join(ROOT, 'output'),
  drafts: path.join(ROOT, 'output', 'drafts'),
  final: path.join(ROOT, 'output', 'final'),
};

export function ensureDirs() {
  for (const p of Object.values(PATHS)) {
    if (typeof p === 'string' && !fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  }
}

export function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

/** Directorio de trabajo temporal de un proyecto (audio, frames, listas). */
export function workDir(projectId) {
  return ensureDir(path.join(PATHS.drafts, projectId));
}

/** Evita path traversal: resuelve `p` y verifica que caiga dentro de `base`. */
export function insideBase(base, p) {
  const resolved = path.resolve(base, p);
  const rel = path.relative(base, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}

/** Convierte a ruta absoluta usable por FFmpeg (acepta rutas relativas al ROOT). */
export function abs(p) {
  if (!p) return null;
  return path.isAbsolute(p) ? p : path.resolve(ROOT, p);
}

/** Ruta relativa al ROOT, con separadores POSIX (para guardar en JSON portable). */
export function rel(p) {
  if (!p) return null;
  return path.relative(ROOT, path.resolve(ROOT, p)).split(path.sep).join('/');
}
