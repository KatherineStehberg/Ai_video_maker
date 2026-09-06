import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ensureDir, rel } from '../lib/paths.js';

/**
 * Marcas: un JSON por marca en data/brands/.
 * NADA esta hardcodeado a una marca concreta; los defaults solo se usan
 * para completar campos faltantes.
 */

export const DEFAULT_BRAND = {
  id: 'default',
  name: 'Sin marca',
  colors: {
    primary: '#1b2a41',
    secondary: '#0b3954',
    accent: '#f2b705',
    text: '#ffffff',
    captionText: '#ffffff',
    captionOutline: '#000000',
  },
  font: null,          // ruta a .ttf en data/assets/fonts; null = fuente del sistema
  fontFamily: 'Arial',
  logo: null,          // ruta relativa al ROOT
  logoPosition: 'top-right',
  logoOpacity: 0.85,
  logoScale: 0.09,     // fraccion del ancho del video
  intro: null,
  outro: null,
  cta: '',
  urls: {},
  hashtags: [],
  musicDir: null,
};

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = deepMerge(base[k] || {}, v);
    else if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

export function brandFile(id) {
  return path.join(PATHS.brands, `${id}.json`);
}

export function loadBrand(id) {
  if (!id) return { ...DEFAULT_BRAND };
  const file = brandFile(id);
  if (!fs.existsSync(file)) return { ...DEFAULT_BRAND, id, name: id };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return deepMerge(DEFAULT_BRAND, { ...raw, id });
  } catch {
    return { ...DEFAULT_BRAND, id, name: id };
  }
}

export function listBrands() {
  ensureDir(PATHS.brands);
  return fs.readdirSync(PATHS.brands)
    .filter((f) => f.endsWith('.json'))
    .map((f) => loadBrand(path.basename(f, '.json')))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function saveBrand(brand) {
  ensureDir(PATHS.brands);
  const merged = deepMerge(DEFAULT_BRAND, brand);
  if (!merged.id) throw new Error('La marca necesita un id');
  fs.writeFileSync(brandFile(merged.id), JSON.stringify(merged, null, 2), 'utf8');
  ensureDir(path.join(PATHS.assetsBrands, merged.id, 'images'));
  ensureDir(path.join(PATHS.assetsBrands, merged.id, 'music'));
  return merged;
}

/** Ruta absoluta del logo de la marca, o null si no existe el archivo. */
export function brandLogoPath(brand) {
  if (!brand?.logo) return null;
  const abs = path.resolve(PATHS.root, brand.logo);
  return fs.existsSync(abs) ? abs : null;
}

/** Ruta absoluta de la fuente de la marca, o null. */
export function brandFontPath(brand) {
  if (!brand?.font) return null;
  const abs = path.resolve(PATHS.root, brand.font);
  return fs.existsSync(abs) ? abs : null;
}

export { rel };
