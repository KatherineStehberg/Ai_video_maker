/**
 * BIBLIOTECA DE RECURSOS DEL EDITOR: imagenes gratuitas y musica con licencia.
 *
 * REGLA DE ORO: el navegador nunca habla con un proveedor con credenciales ni
 * decide que se descarga. Pide «busca esto» y «usa el resultado N»; el backend
 * vuelve a preguntar al proveedor por ese id, comprueba de donde viene el
 * archivo y lo guarda en la cache local. Asi:
 *   - la clave de Pexels nunca sale del servidor;
 *   - no se puede usar el editor para descargar una URL cualquiera;
 *   - cada recurso queda con su autor, licencia y origen al lado.
 *
 * CACHE LOCAL (todo gitignorado, nunca va al repositorio):
 *   data/assets/images/_library/pexels/<id>.jpg        imagen descargada
 *   data/assets/images/_library/pexels/<id>.jpg.json   su ficha de origen
 *   data/assets/music/<pista>.<ext>                     musica local
 *   data/assets/music/<pista>.<ext>.json                su licencia
 *
 * La ficha va AL LADO del archivo (`<archivo>.json`), igual que ya hacian las
 * importaciones del Estudio. Es lo que permite, al guardar, tomar el credito
 * del disco en vez de fiarse de lo que mande el navegador.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PATHS, ensureDir, rel } from '../lib/paths.js';
import { CONFIG } from '../config.js';
import { resolveFfmpeg } from '../lib/ffmpeg.js';

// ============================================================== IMAGENES

export const LICENCIA_PEXELS = {
  nombre: 'Licencia de Pexels',
  resumen: 'Uso gratuito, también comercial. La atribución no es obligatoria pero se recomienda. '
    + 'No se puede vender la foto sin modificar ni dar a entender que la persona retratada respalda un producto.',
  url: 'https://www.pexels.com/license/',
};

/** Unico host desde el que se aceptan descargas de imagen. */
const HOSTS_IMAGEN = new Set(['images.pexels.com']);

/** Tope de tamano de una imagen descargada: una foto de banco no pesa mas. */
const IMAGEN_MAX_BYTES = 25 * 1024 * 1024;

export const dirImagenes = () => path.join(PATHS.assetsImages, '_library', 'pexels');

export function imagenesDisponibles() {
  return Boolean(CONFIG.image.pexelsKey);
}

/**
 * Idioma de la busqueda para Pexels.
 *
 * Sin `locale`, Pexels interpreta el texto como ingles: «naturaleza espiritual»
 * devolvia una obra en construccion en Espiritu Santo (Espana), porque
 * emparejaba «espiritual» con el nombre del lugar. Con `es-ES` los resultados
 * son pertinentes y las descripciones llegan en espanol.
 */
export function localeDe(idioma) {
  return String(idioma || '').toLowerCase().startsWith('en') ? 'en-US' : 'es-ES';
}

/** Orientacion de Pexels que mejor encaja con un formato de video. */
export function orientacionDe(aspecto) {
  if (aspecto === '16:9') return 'landscape';
  if (aspecto === '1:1') return 'square';
  return 'portrait';   // 9:16 y 4:5
}

/** Una foto de Pexels, reducida a lo que el navegador necesita ver. Sin claves. */
function tarjetaFoto(f) {
  return {
    proveedor: 'pexels',
    id: String(f.id),
    ancho: f.width,
    alto: f.height,
    autor: f.photographer || 'Autor desconocido',
    autorUrl: f.photographer_url || null,
    paginaUrl: f.url || null,
    descripcion: f.alt || '',
    colorMedio: f.avg_color || null,
    // Miniatura y vista previa se cargan directamente desde el CDN publico de
    // Pexels: son imagenes sin credenciales. La descarga final no se hace asi.
    miniatura: f.src?.medium || f.src?.small || null,
    vistaPrevia: f.src?.large || f.src?.medium || null,
    licencia: LICENCIA_PEXELS.nombre,
  };
}

/**
 * Busca imagenes en Pexels.
 *
 * Sin clave configurada NO lanza: devuelve `disponible: false` y un motivo en
 * lenguaje llano, para que la interfaz ofrezca los archivos locales.
 */
export async function buscarImagenes({ consulta, aspecto = '9:16', idioma = 'es', pagina = 1, porPagina = 15, fetchImpl = fetch } = {}) {
  const q = String(consulta || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!imagenesDisponibles()) {
    return {
      disponible: false,
      motivo: 'La biblioteca de imágenes gratuitas no está disponible en este equipo. Puedes usar tus propios archivos o los fondos locales.',
      resultados: [],
    };
  }
  if (!q) return { disponible: true, consulta: q, resultados: [], motivo: 'Escribe qué quieres buscar.' };

  const p = Math.max(1, Math.min(50, Number(pagina) || 1));
  const n = Math.max(1, Math.min(40, Number(porPagina) || 15));
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}`
    + `&orientation=${orientacionDe(aspecto)}&per_page=${n}&page=${p}&locale=${localeDe(idioma)}`;

  let res;
  try {
    res = await fetchImpl(url, { headers: { authorization: CONFIG.image.pexelsKey }, signal: AbortSignal.timeout(20_000) });
  } catch {
    return { disponible: true, consulta: q, resultados: [], motivo: 'No hay conexión con la biblioteca de imágenes. Prueba de nuevo en un momento.' };
  }
  if (!res.ok) {
    // Nunca se reenvia el cuerpo del proveedor: podria llevar detalles de la cuenta.
    const motivo = res.status === 429
      ? 'Se alcanzó el límite de búsquedas por hora de la biblioteca. Prueba de nuevo más tarde.'
      : 'La biblioteca de imágenes no respondió. Prueba de nuevo en un momento.';
    return { disponible: true, consulta: q, resultados: [], motivo };
  }
  const data = await res.json();
  const resultados = (data?.photos || []).map(tarjetaFoto).filter(f => f.miniatura);
  return {
    disponible: true,
    consulta: q,
    pagina: p,
    total: Number(data?.total_results) || resultados.length,
    resultados,
    motivo: resultados.length ? null : `No se encontraron imágenes para «${q}». Prueba con otras palabras.`,
    licencia: LICENCIA_PEXELS,
  };
}

/**
 * Descarga una foto de Pexels a la cache local y escribe su ficha.
 *
 * Solo se acepta el ID: la URL de descarga se obtiene del propio Pexels, y se
 * comprueba que apunte a su CDN antes de bajar nada. Si ya estaba en cache no
 * se vuelve a descargar.
 */
export async function importarImagen({ id, consulta = '', fetchImpl = fetch } = {}) {
  if (!imagenesDisponibles()) throw new Error('La biblioteca de imágenes gratuitas no está disponible en este equipo.');
  const remoto = String(id ?? '').trim();
  if (!/^\d{1,15}$/.test(remoto)) throw new Error('Identificador de imagen no válido.');

  const dir = ensureDir(dirImagenes());
  const archivo = path.join(dir, `${remoto}.jpg`);
  const ficha = `${archivo}.json`;
  if (fs.existsSync(archivo) && fs.existsSync(ficha)) {
    return { path: rel(archivo), credito: JSON.parse(fs.readFileSync(ficha, 'utf8')), cache: true };
  }

  const meta = await fetchImpl(`https://api.pexels.com/v1/photos/${remoto}`, {
    headers: { authorization: CONFIG.image.pexelsKey }, signal: AbortSignal.timeout(20_000),
  });
  if (!meta.ok) throw new Error('No se pudo obtener esa imagen de la biblioteca.');
  const foto = await meta.json();
  const descarga = foto?.src?.large2x || foto?.src?.original || foto?.src?.large;
  comprobarHost(descarga, HOSTS_IMAGEN);

  const img = await fetchImpl(descarga, { signal: AbortSignal.timeout(60_000) });
  if (!img.ok) throw new Error('No se pudo descargar la imagen.');
  const tipo = String(img.headers?.get?.('content-type') || '');
  if (tipo && !/^image\//.test(tipo)) throw new Error('El archivo recibido no es una imagen.');
  const bytes = Buffer.from(await img.arrayBuffer());
  if (!bytes.length) throw new Error('La imagen descargada está vacía.');
  if (bytes.length > IMAGEN_MAX_BYTES) throw new Error('La imagen es demasiado grande.');

  const credito = {
    proveedor: 'pexels',
    idRemoto: remoto,
    urlDescarga: descarga,
    autor: foto.photographer || 'Autor desconocido',
    autorUrl: foto.photographer_url || null,
    urlAtribucion: foto.url || null,
    licencia: LICENCIA_PEXELS.nombre,
    licenciaUrl: LICENCIA_PEXELS.url,
    licenciaResumen: LICENCIA_PEXELS.resumen,
    consulta: String(consulta || '').slice(0, 100),
    descargadaEn: new Date().toISOString(),
    archivoLocal: rel(archivo),
    ancho: foto.width || null,
    alto: foto.height || null,
  };
  // Escritura en dos pasos: primero la imagen, luego la ficha. Si algo falla a
  // medias no queda una ficha apuntando a una imagen que no existe.
  fs.writeFileSync(`${archivo}.tmp`, bytes);
  fs.renameSync(`${archivo}.tmp`, archivo);
  fs.writeFileSync(ficha, JSON.stringify(credito, null, 2), 'utf8');
  return { path: rel(archivo), credito, cache: false };
}

/** Rechaza cualquier URL que no sea https hacia un host permitido. */
export function comprobarHost(url, permitidos) {
  let u;
  try { u = new URL(String(url || '')); } catch { throw new Error('La biblioteca devolvió una dirección de descarga no válida.'); }
  if (u.protocol !== 'https:' || !permitidos.has(u.hostname)) {
    throw new Error(`Descarga rechazada: ${u.hostname || 'origen desconocido'} no es un origen permitido.`);
  }
  return u;
}

// ================================================================ MUSICA

const EXT_AUDIO = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.opus']);

export const dirMusica = () => PATHS.assetsMusic;

/**
 * Proveedores de musica. Hoy solo existe el local.
 *
 * Para anadir uno remoto (por ejemplo un banco con licencia CC0 y API) hay que
 * implementar este mismo contrato y registrarlo aqui:
 *
 *   {
 *     id, nombre,
 *     disponible(): boolean,                      // sin clave -> false, sin error
 *     buscar({ consulta, maxDuracion }): pistas[], // cada pista CON su licencia
 *     importar({ id }): { path, credito },         // descarga a data/assets/music
 *   }
 *
 * y cumplir tres condiciones: ir detras del backend, no exponer claves, y no
 * devolver NINGUNA pista cuya licencia no conste. Hasta que se elija un
 * proveedor y se verifique su licencia, no hay ninguno remoto.
 */
export const PROVEEDORES_MUSICA = {
  local: { id: 'local', nombre: 'Biblioteca local (data/assets/music)', remoto: false },
};

/** Duracion de un archivo de audio, cacheada por tamano y fecha. */
const cacheDuracion = new Map();
function duracionAudio(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const clave = `${file}|${st.size}|${st.mtimeMs}`;
  if (cacheDuracion.has(clave)) return cacheDuracion.get(clave);
  const ffprobe = globalThis.__ffprobeResuelto;
  if (!ffprobe) return null;
  const r = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' });
  const d = Number.parseFloat(r.stdout);
  const valor = Number.isFinite(d) && d > 0 ? Number(d.toFixed(2)) : null;
  cacheDuracion.set(clave, valor);
  return valor;
}

async function asegurarFfprobe() {
  if (!globalThis.__ffprobeResuelto) {
    const { ffprobe } = await resolveFfmpeg();
    globalThis.__ffprobeResuelto = ffprobe || null;
  }
}

/**
 * Lee la ficha de licencia de una pista. Devuelve el motivo si no sirve.
 *
 * Una pista SIN licencia declarada no se ofrece nunca: es la unica forma de
 * no acabar usando musica con copyright sin darse cuenta.
 */
export function fichaMusica(file) {
  const ruta = `${file}.json`;
  if (!fs.existsSync(ruta)) return { ok: false, motivo: 'Falta la ficha de licencia (<archivo>.json).' };
  let f;
  try { f = JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch { return { ok: false, motivo: 'La ficha de licencia no es un JSON válido.' }; }
  if (!String(f.licencia || '').trim()) return { ok: false, motivo: 'La ficha no declara licencia.' };
  if (!String(f.fuente || '').trim()) return { ok: false, motivo: 'La ficha no declara la fuente.' };
  return { ok: true, ficha: f };
}

/**
 * Pistas de la biblioteca local, con todo lo que la tarjeta necesita.
 * Las que no tienen licencia clara se devuelven aparte, con el motivo.
 */
export async function listarMusica({ consulta = '', maxDuracion = null, dir = dirMusica() } = {}) {
  await asegurarFfprobe();
  const pistas = [];
  const rechazadas = [];
  if (fs.existsSync(dir)) {
    for (const nombre of fs.readdirSync(dir).sort()) {
      const ext = path.extname(nombre).toLowerCase();
      if (!EXT_AUDIO.has(ext)) continue;
      const file = path.join(dir, nombre);
      const f = fichaMusica(file);
      if (!f.ok) { rechazadas.push({ archivo: nombre, motivo: f.motivo }); continue; }
      const ficha = f.ficha;
      pistas.push({
        proveedor: 'local',
        id: rel(file),
        path: rel(file),
        url: `/file?path=${encodeURIComponent(rel(file))}`,
        titulo: ficha.titulo || path.basename(nombre, ext),
        duracion: duracionAudio(file),
        formato: ext.slice(1).toUpperCase(),
        bytes: fs.statSync(file).size,
        genero: ficha.genero || null,
        ambiente: ficha.ambiente || null,
        etiquetas: Array.isArray(ficha.etiquetas) ? ficha.etiquetas : [],
        licencia: ficha.licencia,
        licenciaUrl: ficha.licenciaUrl || null,
        fuente: ficha.fuente,
        autor: ficha.autor || null,
        atribucion: ficha.atribucion || null,
        requiereAtribucion: Boolean(ficha.requiereAtribucion),
      });
    }
  }

  const q = String(consulta || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  const max = Number(maxDuracion) > 0 ? Number(maxDuracion) : null;
  const filtradas = pistas.filter((p) => {
    if (max && p.duracion && p.duracion > max) return false;
    if (!q) return true;
    const texto = [p.titulo, p.genero, p.ambiente, ...p.etiquetas].join(' ')
      .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    return q.split(/\s+/).every(w => texto.includes(w));
  });

  return {
    disponible: true,
    proveedores: Object.values(PROVEEDORES_MUSICA),
    pistas: filtradas,
    total: pistas.length,
    rechazadas,
    motivo: !pistas.length
      ? 'La biblioteca de música está vacía. Añade archivos con su ficha de licencia en data/assets/music/.'
      : !filtradas.length ? 'Ninguna pista coincide con la búsqueda.' : null,
  };
}

/**
 * ¿Se puede usar esta musica en un proyecto? Devuelve el credito si si.
 *
 * Solo dos origenes valen: la biblioteca local con licencia declarada, o un
 * archivo importado en el Estudio con la declaracion de autorizacion de la
 * usuaria. Cualquier otra ruta se rechaza, este donde este.
 */
export function creditoDeMusica(rutaRelativa) {
  const abs = path.resolve(PATHS.root, String(rutaRelativa || ''));
  const dentroDe = base => { const r = path.relative(base, abs); return !r.startsWith('..') && !path.isAbsolute(r); };

  if (!fs.existsSync(abs)) throw new Error('La música indicada no existe.');
  if (!EXT_AUDIO.has(path.extname(abs).toLowerCase())) throw new Error('El archivo indicado no es de audio.');

  if (dentroDe(PATHS.assetsMusic)) {
    const f = fichaMusica(abs);
    if (!f.ok) throw new Error(`Esa música no se puede usar: ${f.motivo}`);
    return {
      proveedor: 'local', archivoLocal: rel(abs), titulo: f.ficha.titulo || path.basename(abs),
      licencia: f.ficha.licencia, licenciaUrl: f.ficha.licenciaUrl || null, fuente: f.ficha.fuente,
      autor: f.ficha.autor || null, atribucion: f.ficha.atribucion || null,
      requiereAtribucion: Boolean(f.ficha.requiereAtribucion),
    };
  }
  const importados = path.join(PATHS.data, 'studio-imports');
  if (dentroDe(importados)) {
    let m = null;
    try { m = JSON.parse(fs.readFileSync(`${abs}.json`, 'utf8')); } catch { /* sin ficha */ }
    if (!m?.authorized || m.kind !== 'music') throw new Error('Esa música no tiene la declaración de autorización.');
    return {
      proveedor: 'archivo-propio', archivoLocal: rel(abs), titulo: m.name || path.basename(abs),
      licencia: 'Archivo propio: la usuaria declaró tener autorización', fuente: m.originalReference || 'local',
      autor: null, atribucion: null, requiereAtribucion: false,
    };
  }
  throw new Error('Esa música no está en una carpeta permitida.');
}

/** Credito de una imagen a partir de su ficha en disco. null si no la tiene. */
export function creditoDeImagen(rutaRelativa) {
  const abs = path.resolve(PATHS.root, String(rutaRelativa || ''));
  try { return JSON.parse(fs.readFileSync(`${abs}.json`, 'utf8')); } catch { return null; }
}
