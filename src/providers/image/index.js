import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ensureDir, rel } from '../../lib/paths.js';
import { CONFIG } from '../../config.js';
import { slugify } from '../../lib/util.js';
import { ffmpegRun, escapeDrawtext } from '../../lib/ffmpeg.js';

/**
 * Contrato:
 *   id, label, isAvailable()
 *   provide({ prompt, scene, project, outFile }) -> ruta relativa al ROOT, o null
 *
 * NINGUN provider descarga modelos ni usa APIs de pago.
 */

/** Busca en data/assets/images por coincidencia de palabras del prompt. */
const local = {
  id: 'local',
  label: 'Imagenes locales (data/assets/images)',
  isAvailable: async () => true,
  async provide({ prompt, project }) {
    const dirs = [
      path.join(PATHS.assetsBrands, project?.brand || '', 'images'),
      PATHS.assetsImages,
    ].filter((d) => fs.existsSync(d));

    const exts = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);
    const files = [];
    for (const dir of dirs) {
      for (const f of fs.readdirSync(dir)) {
        if (exts.has(path.extname(f).toLowerCase())) files.push(path.join(dir, f));
      }
    }
    if (!files.length) return null;

    const words = slugify(prompt || '').split('-').filter((w) => w.length > 3);
    let best = null;
    let bestScore = 0;
    for (const f of files) {
      const name = slugify(path.basename(f, path.extname(f)));
      const score = words.reduce((a, w) => a + (name.includes(w) ? 1 : 0), 0);
      if (score > bestScore) { bestScore = score; best = f; }
    }
    return rel(best || files[0]);
  },
};

/**
 * Genera un fondo con FFmpeg: degradado de marca + texto del prompt.
 * Es el fallback que garantiza que SIEMPRE haya un visual, sin red y sin costo.
 */
const placeholder = {
  id: 'placeholder',
  label: 'Fondo generado con FFmpeg ($0, offline)',
  isAvailable: async () => true,
  async provide({ prompt, scene, project, brand, width = 1080, height = 1920 }) {
    const dir = ensureDir(path.join(PATHS.assetsImages, '_generated'));
    const outFile = path.join(dir, `${project?.id || 'tmp'}_${scene?.id || 'sc'}.png`);

    const c1 = brand?.colors?.primary || '#1b2a41';
    const c2 = brand?.colors?.secondary || '#0b3954';
    const textColor = brand?.colors?.text || '#ffffff';
    // El renderer ya dibuja `scene.onScreenTitle` encima del video. Si la
    // escena lo tiene, el fondo se deja limpio: de lo contrario el mismo texto
    // aparece dos veces, en el centro y arriba.
    const label = scene?.onScreenTitle?.trim()
      ? ''
      : (prompt || project?.title || '').slice(0, 60);

    // gradients: degradado nativo de FFmpeg, sin assets externos.
    const filters = [
      `gradients=s=${width}x${height}:c0=${c1}:c1=${c2}:x0=0:y0=0:x1=${width}:y1=${height}:d=1`,
    ];
    const drawArgs = label
      ? `,drawtext=text='${escapeDrawtext(label)}':fontcolor=${textColor}@0.85:` +
        `fontsize=${Math.round(width / 22)}:x=(w-text_w)/2:y=(h-text_h)/2:` +
        `box=1:boxcolor=black@0.25:boxborderw=${Math.round(width / 60)}`
      : '';

    await ffmpegRun([
      '-f', 'lavfi',
      '-i', filters[0],
      '-frames:v', '1',
      '-vf', `format=rgb24${drawArgs}`,
      outFile,
    ]);
    return rel(outFile);
  },
};

/**
 * Pexels: banco de imagenes con free tier real (200 req/hora, sin tarjeta).
 * Opcional: sin PEXELS_API_KEY el provider queda inactivo.
 */
/**
 * Fotos ya usadas en este proyecto, para no repetir la misma imagen en varias
 * escenas. Se guarda por proyecto y en memoria: un proceso nuevo empieza limpio.
 */
const usadasPorProyecto = new Map();

/** Traduce el término de búsqueda a algo que funcione en un banco anglosajón. */
const TRADUCCIONES = [
  [/\bingl[eé]s\b/gi, 'english language'], [/\bclases?\b/gi, 'class lesson'],
  [/\bprofesor(a|es)?\b/gi, 'teacher'], [/\balumnos?\b|\bestudiantes?\b/gi, 'student'],
  [/\bhorarios?\b/gi, 'schedule'], [/\bflexibles?\b/gi, 'flexible'],
  [/\bconversaci[oó]n\b/gi, 'conversation'], [/\btrabajo\b|\blaborales?\b/gi, 'work office'],
  [/\badultos?\b/gi, 'adult'], [/\bonline\b/gi, 'online remote'],
  [/\bcurso\b/gi, 'course'], [/\bempresa\b/gi, 'business'],
  [/\bcomida\b/gi, 'food'], [/\bviajes?\b/gi, 'travel'],
];

/** Normaliza el término: traduce lo conocido y quita palabras vacías. */
export function terminoVisual(prompt) {
  let t = ` ${String(prompt || '')} `;
  for (const [de, a] of TRADUCCIONES) t = t.replace(de, a);
  const palabras = t.toLowerCase().split(/[^a-záéíóúñü0-9]+/i)
    .filter(w => w.length > 2 && !/^(para|con|del|las|los|una|uno|que|por|sus|tus|mas|muy|the|and|for)$/.test(w));
  return [...new Set(palabras)].slice(0, 5).join(' ').trim();
}

/**
 * Pexels: banco de imagenes con free tier real (200 req/hora, sin tarjeta).
 * Opcional: sin PEXELS_API_KEY el provider queda inactivo.
 *
 * La clave vive SOLO en el backend (CONFIG.image.pexelsKey, leido de .env).
 * Nunca se envia al frontend ni aparece en la respuesta: de cada foto se
 * devuelve autor, url y licencia, no credenciales.
 */
const pexels = {
  id: 'pexels',
  label: 'Pexels (free tier, requiere API key gratuita)',
  isAvailable: async () => Boolean(CONFIG.image.pexelsKey),
  async provide({ prompt, scene, project, width = 1080, height = 1920, fetchImpl = fetch }) {
    if (!CONFIG.image.pexelsKey) return null;
    const orientation = height > width ? 'portrait' : width > height ? 'landscape' : 'square';
    const consulta = terminoVisual(prompt) || 'abstract background';

    // Se piden varias y se descarta lo ya usado: escenas distintas, fotos distintas.
    const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(consulta)}` +
      `&per_page=10&orientation=${orientation}`;
    const res = await fetchImpl(url, {
      headers: { authorization: CONFIG.image.pexelsKey },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const data = await res.json();

    const clave = project?.id || 'sin-proyecto';
    if (!usadasPorProyecto.has(clave)) usadasPorProyecto.set(clave, new Set());
    const usadas = usadasPorProyecto.get(clave);

    const foto = (data?.photos || []).find(p => !usadas.has(String(p.id)));
    if (!foto) return null;
    const src = foto.src?.large2x || foto.src?.original || foto.src?.large;
    if (!src) return null;

    const img = await fetchImpl(src, { signal: AbortSignal.timeout(60_000) });
    if (!img.ok) return null;
    const dir = ensureDir(path.join(PATHS.assetsImages, '_pexels'));
    const outFile = path.join(dir, `${clave}_${scene?.id || 'sc'}.jpg`);
    fs.writeFileSync(outFile, Buffer.from(await img.arrayBuffer()));
    usadas.add(String(foto.id));

    return {
      path: rel(outFile),
      credit: {
        fuente: 'Pexels', autor: foto.photographer || 'desconocido',
        autorUrl: foto.photographer_url || null, url: foto.url || null,
        id: String(foto.id), licencia: 'Pexels License (uso libre, atribución no obligatoria pero recomendada)',
        consulta,
      },
    };
  },
};

/** Olvida las fotos usadas por un proyecto (para regenerar desde cero). */
export const olvidarUsadas = projectId => usadasPorProyecto.delete(projectId || 'sin-proyecto');

const REGISTRY = { local, placeholder, pexels };

export function getProvider(name) {
  return REGISTRY[name] || null;
}

/**
 * Cadena de resolucion: intenta el provider preferido y cae a `placeholder`,
 * que nunca falla. Asi el render nunca se queda sin visual.
 */
export async function provideImage(ctx, preferred = 'auto') {
  const order = preferred && preferred !== 'auto'
    ? [preferred, 'placeholder']
    : [CONFIG.image.provider, 'local', 'pexels', 'placeholder'];

  const tried = new Set();
  for (const name of order) {
    if (!name || tried.has(name)) continue;
    tried.add(name);
    const p = REGISTRY[name];
    if (!p) continue;
    try {
      if (!(await p.isAvailable())) continue;
      // Un provider puede devolver la ruta suelta o { path, credit } cuando el
      // recurso viene de un banco y hay que guardar autor y licencia.
      const result = await p.provide(ctx);
      const file = typeof result === 'string' ? result : result?.path;
      if (file) return { path: file, provider: name, credit: (typeof result === 'object' && result?.credit) || null };
    } catch {
      /* seguimos con el siguiente provider */
    }
  }
  return null;
}

export async function status() {
  const out = {};
  for (const [name, p] of Object.entries(REGISTRY)) {
    out[name] = { available: await p.isAvailable(), label: p.label };
  }
  return out;
}
