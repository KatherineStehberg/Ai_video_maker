import fs from 'node:fs';
import path from 'node:path';
import { PATHS, rel } from '../../lib/paths.js';

/**
 * Musica: SOLO archivos locales que el usuario coloca en data/assets/music/
 * (o data/assets/brands/<marca>/music/).
 *
 * No hay descarga automatica ni API. Motivo: cualquier banco "gratuito" con API
 * introduce dependencia de red, rate limits y riesgo de licencia. Manteniendo
 * los archivos locales el costo es $0 y la licencia es verificable por el usuario.
 * Fuentes recomendadas en docs/COST_STRATEGY.md.
 */

const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.opus']);

export const id = 'local';
export const label = 'Musica local (data/assets/music)';

export async function isAvailable() {
  return listTracks().length > 0;
}

/** Lista las pistas disponibles, incluyendo las especificas de cada marca. */
export function listTracks(brand = null) {
  const dirs = [];
  if (brand) dirs.push(path.join(PATHS.assetsBrands, brand, 'music'));
  dirs.push(PATHS.assetsMusic);

  const out = [];
  const seen = new Set();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!AUDIO_EXT.has(path.extname(f).toLowerCase())) continue;
      const full = path.join(dir, f);
      const key = rel(full);
      if (seen.has(key)) continue;
      seen.add(key);
      let size = 0;
      try { size = fs.statSync(full).size; } catch { /* archivo ilegible */ }
      out.push({
        name: path.basename(f, path.extname(f)),
        path: key,
        size,
        brand: dir.includes(path.sep + 'brands' + path.sep) ? brand : null,
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Resuelve una pista por nombre o ruta. Devuelve ruta relativa al ROOT o null. */
export function resolveTrack(nameOrPath, brand = null) {
  if (!nameOrPath) return null;
  const direct = path.resolve(PATHS.root, nameOrPath);
  if (fs.existsSync(direct) && AUDIO_EXT.has(path.extname(direct).toLowerCase())) {
    return rel(direct);
  }
  const found = listTracks(brand).find(
    (t) => t.name.toLowerCase() === String(nameOrPath).toLowerCase() || t.path === nameOrPath,
  );
  return found ? found.path : null;
}

export async function status() {
  const tracks = listTracks();
  return {
    local: {
      available: tracks.length > 0,
      label,
      count: tracks.length,
      hint: tracks.length ? undefined : 'Copia archivos de audio libres a data/assets/music/',
    },
  };
}
