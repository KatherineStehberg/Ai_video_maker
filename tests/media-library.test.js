import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { CONFIG } from '../src/config.js';
import { PATHS, workDir, rel } from '../src/lib/paths.js';
import { ffmpegRun, resolveFfmpeg } from '../src/lib/ffmpeg.js';
import { makeProject, saveProject, loadProject, deleteProject } from '../src/core/project.js';
import { renderProject } from '../src/core/renderer.js';
import { loadBrand } from '../src/core/brands.js';
import { createServer } from '../src/server.js';
import { derivar, guardar } from '../src/project-editor/service.js';
import {
  buscarImagenes, importarImagen, listarMusica, creditoDeMusica, creditoDeImagen,
  dirImagenes, comprobarHost, orientacionDe, localeDe, LICENCIA_PEXELS,
} from '../src/project-editor/media-library.js';

/**
 * BIBLIOTECA DE RECURSOS: imagenes de Pexels y musica local con licencia.
 *
 * Pexels se simula siempre: estas pruebas no hacen ni una peticion real y no
 * necesitan clave. La clave de prueba es un valor falso que se comprueba que
 * NUNCA aparece en lo que recibe el navegador.
 */

const CLAVE_FALSA = 'CLAVE-DE-PRUEBA-QUE-NO-DEBE-SALIR-0123456789';
const PREFIJO = 'zz-test-biblioteca-';

/** Simula la API de Pexels. `descarga` permite probar un origen malicioso. */
function pexelsFalso({ descarga = 'https://images.pexels.com/photos/555/foto.jpeg', vistas = [] } = {}) {
  const foto = (id) => ({
    id, width: 4000, height: 3000, url: `https://www.pexels.com/photo/${id}/`,
    photographer: 'Fotógrafa de Prueba', photographer_url: 'https://www.pexels.com/@prueba',
    alt: 'Montaña al amanecer', avg_color: '#556677',
    src: { medium: `https://images.pexels.com/photos/${id}/m.jpeg`, large: `https://images.pexels.com/photos/${id}/l.jpeg`, large2x: descarga },
  });
  return async (url, opts = {}) => {
    vistas.push({ url: String(url), auth: opts.headers?.authorization || null });
    const u = String(url);
    if (u.startsWith('https://api.pexels.com/v1/search')) {
      const q = new URL(u).searchParams.get('query');
      const photos = q === 'nada de nada' ? [] : [foto(555), foto(556)];
      return new Response(JSON.stringify({ photos, total_results: photos.length }), { status: 200 });
    }
    if (u.startsWith('https://api.pexels.com/v1/photos/')) return new Response(JSON.stringify(foto(Number(u.split('/').pop()))), { status: 200 });
    if (u.startsWith('https://images.pexels.com/')) {
      // Un JPEG minimo valido, generado una vez.
      return new Response(fs.readFileSync(jpegDePrueba()), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    return new Response('no', { status: 404 });
  };
}

let jpeg = null;
function jpegDePrueba() {
  if (jpeg) return jpeg;
  jpeg = path.resolve('.tmp/media-library-test/foto.jpg');
  fs.mkdirSync(path.dirname(jpeg), { recursive: true });
  spawnSync(globalThis.__ff, ['-y', '-f', 'lavfi', '-i', 'color=c=0x3a6b8c:s=1600x1200', '-frames:v', '1', jpeg]);
  return jpeg;
}

async function conClave(clave, fn) {
  const antes = CONFIG.image.pexelsKey;
  CONFIG.image.pexelsKey = clave;
  try { return await fn(); } finally { CONFIG.image.pexelsKey = antes; }
}

/** Crea una pista de prueba en la biblioteca local, con o sin ficha. */
async function pista(nombre, { ficha = {}, frecuencia = 1000, segundos = 3 } = {}) {
  fs.mkdirSync(PATHS.assetsMusic, { recursive: true });
  const file = path.join(PATHS.assetsMusic, `${PREFIJO}${nombre}.mp3`);
  await ffmpegRun(['-f', 'lavfi', '-i', `sine=frequency=${frecuencia}:duration=${segundos}`, '-af', 'volume=6', '-ac', '2', file]);
  if (ficha) fs.writeFileSync(`${file}.json`, JSON.stringify(ficha));
  return file;
}

const LIBRE = { titulo: 'Pista libre', licencia: 'CC0 1.0', fuente: 'Pruebas automáticas', genero: 'Ambiental', etiquetas: ['calma', 'espiritual'] };

function limpiarBiblioteca() {
  for (const f of fs.readdirSync(PATHS.assetsMusic)) if (f.startsWith(PREFIJO)) fs.rmSync(path.join(PATHS.assetsMusic, f), { force: true });
  for (const id of ['555', '556', '557']) {
    fs.rmSync(path.join(dirImagenes(), `${id}.jpg`), { force: true });
    fs.rmSync(path.join(dirImagenes(), `${id}.jpg.json`), { force: true });
  }
}

test.before(async () => {
  globalThis.__ff = (await resolveFfmpeg()).ffmpeg;
  limpiarBiblioteca();
});
test.after(() => limpiarBiblioteca());

// ================================================================ IMAGENES

test('buscar imágenes devuelve tarjetas sin exponer la clave', async () => {
  const vistas = [];
  const r = await conClave(CLAVE_FALSA, () => buscarImagenes({ consulta: 'naturaleza espiritual', aspecto: '16:9', fetchImpl: pexelsFalso({ vistas }) }));
  assert.equal(r.disponible, true);
  assert.equal(r.resultados.length, 2);
  const t = r.resultados[0];
  for (const campo of ['id', 'autor', 'miniatura', 'vistaPrevia', 'paginaUrl', 'licencia']) assert.ok(t[campo], `falta ${campo}`);
  assert.equal(JSON.stringify(r).includes(CLAVE_FALSA), false, 'la clave NUNCA puede llegar al navegador');
  // La clave si se usa, pero solo del backend hacia Pexels.
  assert.equal(vistas[0].auth, CLAVE_FALSA);
  assert.match(vistas[0].url, /orientation=landscape/, 'en 16:9 se piden fotos horizontales');
  // Sin idioma, Pexels lee la consulta como ingles y los resultados en
  // espanol salen desviados (ver localeDe).
  assert.match(vistas[0].url, /locale=es-ES/, 'la búsqueda va en español por defecto');
});

test('el idioma del proyecto decide el idioma de la búsqueda', () => {
  assert.equal(localeDe('es'), 'es-ES');
  assert.equal(localeDe('bilingual'), 'es-ES');
  assert.equal(localeDe('en'), 'en-US');
  assert.equal(localeDe(undefined), 'es-ES');
});

test('la orientación de la búsqueda sigue al formato del video', () => {
  assert.equal(orientacionDe('9:16'), 'portrait');
  assert.equal(orientacionDe('4:5'), 'portrait');
  assert.equal(orientacionDe('16:9'), 'landscape');
  assert.equal(orientacionDe('1:1'), 'square');
});

test('sin clave de Pexels la biblioteca lo dice, sin error técnico', async () => {
  const r = await conClave('', () => buscarImagenes({ consulta: 'lo que sea', fetchImpl: () => { throw new Error('no debería llamarse'); } }));
  assert.equal(r.disponible, false);
  assert.match(r.motivo, /no está disponible/);
  assert.match(r.motivo, /propios archivos|fondos locales/);
  assert.deepEqual(r.resultados, []);
});

test('una búsqueda sin resultados da un mensaje claro', async () => {
  const r = await conClave(CLAVE_FALSA, () => buscarImagenes({ consulta: 'nada de nada', fetchImpl: pexelsFalso() }));
  assert.equal(r.resultados.length, 0);
  assert.match(r.motivo, /No se encontraron/);
});

test('importar una imagen la cachea en local con su ficha completa', async () => {
  const vistas = [];
  const r = await conClave(CLAVE_FALSA, () => importarImagen({ id: '555', consulta: 'naturaleza espiritual', fetchImpl: pexelsFalso({ vistas }) }));
  const archivo = path.resolve(PATHS.root, r.path);
  assert.ok(fs.existsSync(archivo), 'la imagen tiene que quedar en disco');
  assert.ok(archivo.startsWith(dirImagenes()), 'y dentro de la cache de la biblioteca');
  const ficha = JSON.parse(fs.readFileSync(`${archivo}.json`, 'utf8'));
  for (const campo of ['proveedor', 'idRemoto', 'urlDescarga', 'autor', 'urlAtribucion', 'licencia', 'descargadaEn', 'consulta', 'archivoLocal']) {
    assert.ok(ficha[campo], `la ficha no guarda ${campo}`);
  }
  assert.equal(ficha.proveedor, 'pexels');
  assert.equal(ficha.licencia, LICENCIA_PEXELS.nombre);
  assert.equal(ficha.consulta, 'naturaleza espiritual');
  assert.equal(JSON.stringify(ficha).includes(CLAVE_FALSA), false);

  // Segunda vez: sale de la cache, sin volver a descargar.
  const antes = vistas.length;
  const otra = await conClave(CLAVE_FALSA, () => importarImagen({ id: '555', fetchImpl: pexelsFalso({ vistas }) }));
  assert.equal(otra.cache, true);
  assert.equal(vistas.length, antes, 'no debe volver a llamar a Pexels');
});

test('no se descarga nada fuera de las fuentes permitidas', async () => {
  // Pexels «devuelve» una URL de otro sitio: se rechaza antes de bajar nada.
  await assert.rejects(
    () => conClave(CLAVE_FALSA, () => importarImagen({ id: '557', fetchImpl: pexelsFalso({ descarga: 'https://evil.example.com/x.jpg' }) })),
    /no es un origen permitido/,
  );
  assert.equal(fs.existsSync(path.join(dirImagenes(), '557.jpg')), false, 'no puede quedar ningún archivo');

  await assert.rejects(() => conClave(CLAVE_FALSA, () => importarImagen({ id: '../../etc/passwd', fetchImpl: pexelsFalso() })), /no válido/);
  await assert.rejects(() => conClave(CLAVE_FALSA, () => importarImagen({ id: 'http://x', fetchImpl: pexelsFalso() })), /no válido/);
  assert.throws(() => comprobarHost('http://images.pexels.com/a.jpg', new Set(['images.pexels.com'])), /no es un origen permitido/);
  assert.throws(() => comprobarHost('file:///C:/Windows/win.ini', new Set(['images.pexels.com'])), /no es un origen permitido/);
});

test('la imagen elegida se guarda con su atribución y sobrevive a recargar', async () => {
  const img = await conClave(CLAVE_FALSA, () => importarImagen({ id: '556', consulta: 'luz', fetchImpl: pexelsFalso() }));
  const p = makeProject({ title: 'img', aspectRatio: '9:16', scenes: [{ text: 'Una escena.', duration: 3 }] });
  saveProject(p);
  try {
    await guardar(p.id, {
      revision: 1,
      // El navegador intenta colar otro autor: el backend lo ignora y usa la ficha.
      scenes: [{ id: p.scenes[0].id, assetPath: img.path, assetCredit: { autor: 'Suplantado' } }],
    });
    const l = loadProject(p.id);
    assert.equal(l.scenes[0].assetPath, img.path);
    assert.equal(l.scenes[0].assetProvider, 'pexels');
    assert.equal(l.scenes[0].assetCredit.autor, 'Fotógrafa de Prueba', 'el crédito sale de la ficha en disco');

    const d = derivar(l);
    assert.equal(d.escenas[0].recurso.estado, 'listo');
    assert.equal(d.escenas[0].recurso.credito.autor, 'Fotógrafa de Prueba', 'la atribución llega a la interfaz');
    assert.ok(d.escenas[0].recurso.credito.urlAtribucion);
    assert.equal(l.editor.exportedRevision === l.editor.revision, false, 'cambiar la imagen invalida el MP4 anterior');
  } finally { deleteProject(p.id); }
});

// ================================================================== MUSICA

test('la biblioteca lista sólo música con licencia declarada', async () => {
  await pista('con-licencia', { ficha: LIBRE });
  await pista('sin-ficha', { ficha: null });
  await pista('ficha-sin-licencia', { ficha: { titulo: 'x', fuente: 'y' } });

  const r = await listarMusica({});
  const mias = r.pistas.filter(p => p.path.includes(PREFIJO));
  assert.equal(mias.length, 1, 'solo la que declara licencia');
  const t = mias[0];
  for (const campo of ['titulo', 'duracion', 'formato', 'bytes', 'licencia', 'fuente', 'url']) assert.ok(t[campo], `falta ${campo}`);
  assert.equal(t.formato, 'MP3');
  assert.ok(Math.abs(t.duracion - 3) < 0.3, `duración leída del archivo: ${t.duracion}`);

  const rechazadas = r.rechazadas.filter(x => x.archivo.startsWith(PREFIJO)).map(x => x.motivo).join(' | ');
  assert.match(rechazadas, /Falta la ficha/);
  assert.match(rechazadas, /no declara licencia/);
});

test('buscar música por ambiente y por duración', async () => {
  await pista('larga', { ficha: { ...LIBRE, titulo: 'Larga', etiquetas: ['energía'] }, segundos: 8 });
  const porTexto = await listarMusica({ consulta: 'espiritual' });
  assert.ok(porTexto.pistas.some(p => p.path.includes(`${PREFIJO}con-licencia`)));
  assert.ok(!porTexto.pistas.some(p => p.path.includes(`${PREFIJO}larga`)));
  const cortas = await listarMusica({ maxDuracion: 5 });
  assert.ok(!cortas.pistas.some(p => p.path.includes(`${PREFIJO}larga`)), 'el filtro de duración funciona');
});

test('no se puede usar música sin licencia ni fuera de las carpetas permitidas', async () => {
  const sin = path.join(PATHS.assetsMusic, `${PREFIJO}sin-ficha.mp3`);
  assert.throws(() => creditoDeMusica(rel(sin)), /Falta la ficha/);
  assert.throws(() => creditoDeMusica('../../Windows/win.ini'), /no existe|no es de audio|carpeta permitida/);
  // Un audio real pero en una carpeta que no es de música: rechazado.
  const fuera = path.join(workDir('_media_test'), 'x.mp3');
  fs.mkdirSync(path.dirname(fuera), { recursive: true });
  fs.copyFileSync(path.join(PATHS.assetsMusic, `${PREFIJO}con-licencia.mp3`), fuera);
  assert.throws(() => creditoDeMusica(rel(fuera)), /carpeta permitida/);

  const p = makeProject({ title: 'm', scenes: [{ text: 'a.', duration: 2 }] });
  saveProject(p);
  try {
    await assert.rejects(() => guardar(p.id, { revision: 1, music: { path: rel(sin) } }), /no se puede usar/);
    assert.equal(loadProject(p.id).music.path, null, 'un rechazo no puede dejar la música a medias');
  } finally { deleteProject(p.id); fs.rmSync(path.dirname(fuera), { recursive: true, force: true }); }
});

test('la música elegida y su volumen sobreviven a guardar y recargar', async () => {
  const ruta = rel(path.join(PATHS.assetsMusic, `${PREFIJO}con-licencia.mp3`));
  const p = makeProject({ title: 'm', scenes: [{ text: 'a.', duration: 2 }] });
  saveProject(p);
  try {
    await guardar(p.id, { revision: 1, music: { path: ruta, enabled: true, volume: 0.3, credit: { licencia: 'Inventada' } } });
    const l = loadProject(p.id);
    assert.equal(l.music.path, ruta);
    assert.equal(l.music.enabled, true);
    assert.equal(l.music.volume, 0.3);
    assert.equal(l.music.credit.licencia, 'CC0 1.0', 'la licencia sale de la ficha, no del navegador');

    const d = derivar(l);
    assert.ok(d.audio.musica?.url, 'la interfaz recibe la música para la vista previa');
    assert.equal(d.audio.musica.titulo, 'Pista libre');
    assert.equal(d.pistas.musica, 1, 'aparece la pista en la línea de tiempo');

    // Silenciar la deja a la vista; quitarla la elimina.
    await guardar(p.id, { revision: 2, music: { enabled: false } });
    assert.equal(derivar(loadProject(p.id)).pistas.musica, 1, 'silenciada sigue visible');
    await guardar(p.id, { revision: 3, music: { path: null } });
    assert.equal(loadProject(p.id).music.path, null);
    assert.equal(derivar(loadProject(p.id)).pistas.musica, 0);
  } finally { deleteProject(p.id); }
});

// =================================================== MEZCLA Y EXPORTACION

async function nivelBanda(file, hz) {
  const r = spawnSync(globalThis.__ff, ['-hide_banner', '-nostdin', '-i', file, '-vn',
    '-af', `bandpass=f=${hz}:width_type=q:w=8,volumedetect`, '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /mean_volume: (-?[\d.]+|-inf) dB/.exec(r.stderr)?.[1];
  return m === '-inf' || m === undefined ? -Infinity : Number(m);
}

async function proyectoVozYMusica({ gain = 1, musica = true } = {}) {
  const ruta = rel(path.join(PATHS.assetsMusic, `${PREFIJO}con-licencia.mp3`));   // tono de 1000 Hz
  const p = makeProject({
    title: 'Voz y música', aspectRatio: '16:9', brand: 'personal',
    captions: { enabled: false, burnIn: false },
    voice: { enabled: true, gain },
    music: musica ? { path: ruta, enabled: true, volume: 0.5, credit: creditoDeMusica(ruta) } : {},
    scenes: [
      { text: 'Uno.', duration: 3, transition: 'none', kenBurns: 'none' },
      { text: 'Dos.', duration: 3, transition: 'none', kenBurns: 'none' },
    ],
  });
  const dir = path.join(workDir(p.id), 'audio');
  fs.mkdirSync(dir, { recursive: true });
  for (const s of p.scenes) {
    const wav = path.join(dir, `${s.id}.wav`);
    await ffmpegRun(['-f', 'lavfi', '-i', 'sine=frequency=300:duration=2.8', '-af', 'volume=4', '-ar', '48000', '-ac', '2', wav]);   // «voz» a 300 Hz
    s.narrationPath = rel(wav);
  }
  saveProject(p);
  return p;
}

const borrar = p => { try { deleteProject(p.id); } catch { /* */ } fs.rmSync(workDir(p.id), { recursive: true, force: true }); };

test('el MP4 lleva voz Y música mezcladas, cubriendo todo el video', { timeout: 300000 }, async () => {
  const p = await proyectoVozYMusica();
  try {
    const r = await renderProject(p, loadBrand('personal'), { aspectRatio: '16:9', subtitlesPath: null });
    const j = JSON.parse(spawnSync((await resolveFfmpeg()).ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', r.absolute], { encoding: 'utf8' }).stdout);
    const a = j.streams.filter(s => s.codec_type === 'audio');
    const v = j.streams.find(s => s.codec_type === 'video');
    assert.equal(a.length, 1, 'una pista de audio con la mezcla (no se usó -an)');
    assert.equal(a[0].codec_name, 'aac');
    assert.equal(Number(a[0].start_time), 0);
    assert.ok(Number(a[0].duration) >= Number(v.duration) - 0.2, 'el audio cubre el video');

    // Cada fuente en su frecuencia: si una faltara, su banda saldria muda.
    const voz = await nivelBanda(r.absolute, 300);
    const mus = await nivelBanda(r.absolute, 1000);
    assert.ok(voz > -45, `la narración tiene que oírse en el MP4: ${voz} dB`);
    assert.ok(mus > -45, `la música tiene que oírse en el MP4: ${mus} dB`);
  } finally { borrar(p); }
});

test('voice.gain sigue funcionando con música: a 0 sólo queda la música', { timeout: 300000 }, async () => {
  const p = await proyectoVozYMusica({ gain: 0 });
  try {
    const r = await renderProject(p, loadBrand('personal'), { aspectRatio: '16:9', subtitlesPath: null });
    const voz = await nivelBanda(r.absolute, 300);
    const mus = await nivelBanda(r.absolute, 1000);
    assert.ok(mus > -45, `la música sigue: ${mus} dB`);
    assert.ok(voz < mus - 20, `con la voz a 0 su banda tiene que caer muy por debajo: voz ${voz} dB, música ${mus} dB`);
  } finally { borrar(p); }
});

test('solo música, sin narración: el MP4 lleva la música', { timeout: 300000 }, async () => {
  const p = await proyectoVozYMusica();
  for (const s of p.scenes) s.narrationPath = null;
  saveProject(p);
  try {
    const r = await renderProject(p, loadBrand('personal'), { aspectRatio: '16:9', subtitlesPath: null });
    assert.ok(await nivelBanda(r.absolute, 1000) > -45, 'la música tiene que sonar aunque no haya voz');
  } finally { borrar(p); }
});

// ===================================================================== HTTP

test('HTTP: la biblioteca responde sin claves y la música se puede previsualizar', async () => {
  const server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const fetchReal = globalThis.fetch;
  // Solo las llamadas a Pexels se simulan; las del test al servidor son reales.
  globalThis.fetch = (url, opts) => (String(url).includes('pexels.com') ? pexelsFalso()(url, opts) : fetchReal(url, opts));
  try {
    await conClave(CLAVE_FALSA, async () => {
      const r = await fetchReal(`${base}/api/project-editor/library/images?q=bosque&aspecto=9:16`);
      const texto = await r.text();
      assert.equal(r.status, 200);
      assert.equal(texto.includes(CLAVE_FALSA), false, 'la clave no puede viajar en la respuesta HTTP');
      assert.equal(JSON.parse(texto).resultados.length, 2);

      const cfg = await (await fetchReal(`${base}/api/project-editor/config`)).text();
      assert.equal(cfg.includes(CLAVE_FALSA), false, 'ni en la configuración');
      assert.equal(JSON.parse(cfg).biblioteca.imagenes, true);

      // Importar exige la cabecera del editor, como cualquier escritura.
      const sin = await fetchReal(`${base}/api/project-editor/library/images/import`, { method: 'POST', body: '{"id":"555"}', headers: { 'content-type': 'application/json' } });
      assert.equal(sin.status, 403);
    });

    const m = await (await fetchReal(`${base}/api/project-editor/library/music`)).json();
    const t = m.pistas.find(p => p.path.includes(`${PREFIJO}con-licencia`));
    assert.ok(t, 'la pista aparece en la biblioteca');
    const audio = await fetchReal(`${base}${t.url}`, { headers: { range: 'bytes=0-999' } });
    assert.equal(audio.status, 206, 'la vista previa admite peticiones por rangos');
    assert.match(audio.headers.get('content-type'), /audio\/mpeg/);
  } finally {
    globalThis.fetch = fetchReal;
    await new Promise(r => server.close(r));
  }
});
