import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Carpetas que se pueden mover con una variable de entorno.
 *
 * Existen por las PRUEBAS: crean proyectos y renders de verdad, y si escriben
 * en data/projects se mezclan con el trabajo real y lo entierran en la lista
 * del editor, que ordena por fecha. En uso normal no se define ninguna y todo
 * queda donde siempre.
 */
const fuera = (variable, pordefecto) => (
  process.env[variable] ? path.resolve(process.env[variable]) : pordefecto
);

const PROYECTOS = fuera('AIVM_PROJECTS_DIR', path.join(ROOT, 'data', 'projects'));
const SALIDA = fuera('AIVM_OUTPUT_DIR', path.join(ROOT, 'output'));

export const PATHS = {
  root: ROOT,
  src: path.join(ROOT, 'src'),
  ui: path.join(ROOT, 'src', 'ui'),
  data: path.join(ROOT, 'data'),
  brands: path.join(ROOT, 'data', 'brands'),
  projects: PROYECTOS,
  assets: path.join(ROOT, 'data', 'assets'),
  assetsImages: path.join(ROOT, 'data', 'assets', 'images'),
  assetsMusic: path.join(ROOT, 'data', 'assets', 'music'),
  // Efectos de sonido de la biblioteca local, cada uno con su ficha de licencia.
  assetsSfx: path.join(ROOT, 'data', 'assets', 'sfx'),
  assetsFonts: path.join(ROOT, 'data', 'assets', 'fonts'),
  assetsBrands: path.join(ROOT, 'data', 'assets', 'brands'),
  models: path.join(ROOT, 'models'),
  output: SALIDA,
  drafts: path.join(SALIDA, 'drafts'),
  final: path.join(SALIDA, 'final'),
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
