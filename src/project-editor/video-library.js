import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PATHS, rel, ensureDir } from '../lib/paths.js';
import { CONFIG } from '../config.js';
import { run, resolveFfmpeg } from '../lib/ffmpeg.js';
import { LICENCIA_PEXELS, orientacionDe, localeDe, comprobarHost } from './media-library.js';

const HOSTS = new Set(['videos.pexels.com', 'player.vimeo.com', 'vod-progressive.akamaized.net']);
export const VIDEO_MAX_BYTES = 150 * 1024 * 1024;
export const videosDisponibles = () => Boolean(CONFIG.image.pexelsKey);
export const dirVideos = () => path.join(PATHS.assetsImages, '_library', 'pexels-videos');

// Prefer a source close to the output size, avoiding unnecessary 4K downloads.
export function elegirArchivoVideo(video, aspecto = '9:16') {
  const target = aspecto === '16:9' ? [1920, 1080] : aspecto === '1:1' ? [1080, 1080] : [1080, 1920];
  return (video?.video_files || []).filter(f => {
    if (f.file_type !== 'video/mp4' || !(f.width > 0 && f.height > 0)) return false;
    try { comprobarHost(f.link, HOSTS); return true; } catch { return false; }
  }).sort((a, b) => {
    const score = f => Math.abs(Math.log((f.width / f.height) / (target[0] / target[1]))) * 10
      + Math.abs(Math.log((f.width * f.height) / (target[0] * target[1])));
    return score(a) - score(b);
  })[0] || null;
}

export async function buscarVideos({ consulta, aspecto = '9:16', idioma = 'es', pagina = 1, porPagina = 12, fetchImpl = fetch } = {}) {
  const q = String(consulta || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!videosDisponibles()) return { disponible: false, resultados: [], motivo: 'Configura PEXELS_API_KEY para buscar clips con movimiento real, o sube tus propios videos.' };
  if (!q) return { disponible: true, resultados: [], motivo: 'Escribe qué quieres buscar.' };
  const p = Math.max(1, Math.min(50, Math.trunc(Number(pagina)) || 1));
  const n = Math.max(1, Math.min(40, Math.trunc(Number(porPagina)) || 12));
  const url = `https://api.pexels.com/v1/videos/search?query=${encodeURIComponent(q)}&orientation=${orientacionDe(aspecto)}&locale=${localeDe(idioma)}&per_page=${n}&page=${p}`;
  try {
    const res = await fetchImpl(url, { headers: { authorization: CONFIG.image.pexelsKey }, signal: AbortSignal.timeout(20_000), redirect: 'error' });
    if (!res.ok) return { disponible: true, resultados: [], motivo: res.status === 429 ? 'Se alcanzó el límite de búsquedas. Prueba más tarde.' : 'No se pudo consultar el banco de videos.' };
    const data = await res.json();
    const resultados = (data.videos || []).filter(v => v.duration > 0).map(v => {
      const file = elegirArchivoVideo(v, aspecto);
      if (!file) return null;
      return { id: String(v.id), proveedor: 'pexels-video', kind: 'video', ancho: file.width, alto: file.height,
        duracion: v.duration, autor: v.user?.name || 'Autor desconocido', autorUrl: v.user?.url || null,
        paginaUrl: v.url, miniatura: v.image, vistaPrevia: file.link, licencia: LICENCIA_PEXELS.nombre };
    }).filter(Boolean);
    return { disponible: true, consulta: q, pagina: p, total: Number(data.total_results) || resultados.length, resultados,
      motivo: resultados.length ? null : 'No se encontraron clips. Prueba otras palabras.', licencia: LICENCIA_PEXELS };
  } catch { return { disponible: true, resultados: [], motivo: 'No hay conexión con el banco de videos.' }; }
}

// Follow redirects manually so no unvalidated download host can be reached.
async function descargar(url, fetchImpl) {
  for (let i = 0; i < 4; i++) {
    comprobarHost(url, HOSTS);
    const res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(120_000) });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      await res.body?.cancel?.();
      if (!location) throw new Error('Redirección de video inválida.');
      url = new URL(location, url).href;
      continue;
    }
    if (!res.ok) throw new Error('No se pudo descargar el clip.');
    if (!/^video\/mp4(?:;|$)/i.test(res.headers.get('content-type') || '')) throw new Error('El archivo recibido no es un MP4.');
    if (Number(res.headers.get('content-length')) > VIDEO_MAX_BYTES) { await res.body?.cancel?.(); throw new Error('El clip es demasiado grande.'); }
    return res;
  }
  throw new Error('Demasiadas redirecciones al descargar el clip.');
}

export async function importarVideo({ id, consulta = '', aspecto = '9:16', fetchImpl = fetch, probeImpl = comprobarVideo } = {}) {
  if (!videosDisponibles()) throw new Error('Configura PEXELS_API_KEY para descargar clips.');
  const remoto = String(id ?? '').trim();
  if (!/^\d{1,15}$/.test(remoto)) throw new Error('Identificador de video no válido.');
  if (!['9:16', '16:9', '1:1', '4:5'].includes(aspecto)) throw new Error('Formato no válido.');
  const archivo = path.join(ensureDir(dirVideos()), `${remoto}_${aspecto.replace(':', 'x')}.mp4`);
  if (fs.existsSync(archivo) && fs.existsSync(`${archivo}.json`)) return { path: rel(archivo), credito: JSON.parse(fs.readFileSync(`${archivo}.json`, 'utf8')), cache: true };
  const meta = await fetchImpl(`https://api.pexels.com/v1/videos/videos/${remoto}`, { headers: { authorization: CONFIG.image.pexelsKey }, signal: AbortSignal.timeout(20_000), redirect: 'error' });
  if (!meta.ok) throw new Error('No se pudo obtener ese video.');
  const video = await meta.json();
  if (String(video.id) !== remoto) throw new Error('El banco devolvió otro identificador.');
  const file = elegirArchivoVideo(video, aspecto);
  if (!file) throw new Error('No hay un MP4 compatible de origen permitido.');
  const res = await descargar(file.link, fetchImpl);
  const temp = `${archivo}.${randomUUID()}.tmp.mp4`;
  let bytes = 0;
  try {
    const out = fs.openSync(temp, 'wx');
    try {
      for await (const chunk of res.body) {
        bytes += chunk.length;
        if (bytes > VIDEO_MAX_BYTES) throw new Error('El clip es demasiado grande.');
        fs.writeFileSync(out, chunk);
      }
    } finally { fs.closeSync(out); }
    if (!bytes) throw new Error('El clip está vacío.');
    const medida = await probeImpl(temp);
    const credito = { proveedor: 'pexels-video', kind: 'video', idRemoto: remoto, autor: video.user?.name || 'Autor desconocido',
      autorUrl: video.user?.url || null, urlAtribucion: video.url || null, urlDescarga: file.link,
      licencia: LICENCIA_PEXELS.nombre, licenciaUrl: LICENCIA_PEXELS.url,
      consulta: String(consulta).slice(0, 100), archivoLocal: rel(archivo), descargadaEn: new Date().toISOString(), ...medida };
    fs.renameSync(temp, archivo);
    fs.writeFileSync(`${archivo}.json`, JSON.stringify(credito, null, 2));
    return { path: rel(archivo), credito, cache: false };
  } finally { try { fs.unlinkSync(temp); } catch { /* already moved */ } }
}

async function comprobarVideo(file) {
  const { ffprobe } = await resolveFfmpeg();
  const r = await run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { timeoutMs: 20_000 });
  if (r.code !== 0) throw new Error('El clip descargado no se puede leer.');
  const data = JSON.parse(r.stdout);
  const v = data.streams?.find(s => s.codec_type === 'video');
  const duracion = Number(data.format?.duration);
  if (!v?.width || !v.height || !Number.isFinite(duracion) || duracion <= 0) throw new Error('El clip no contiene video válido.');
  return { ancho: v.width, alto: v.height, duracion };
}
