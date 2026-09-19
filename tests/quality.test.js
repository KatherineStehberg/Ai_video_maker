import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { ffmpegRun, probeDuration } from '../src/lib/ffmpeg.js';

import { cuesToSrt, buildCues } from '../src/core/subtitles.js';
import { draftScript, extraerTema, draftLocal, recortarPalabras, palabrasQueCaben, wpmEfectivo, duracionGuion } from '../src/generation/script.js';
import { elegirVoz, puntuarVoz } from '../src/generation/voice.js';
import { terminoVisual, provideImage } from '../src/providers/image/index.js';
import { ajustarDuracion, TOLERANCIA_SEGUNDOS } from '../src/providers/video-generation/pipeline.js';
import { getTemplate } from '../src/templates/index.js';

const dir = path.resolve('.tmp/quality-test');
const ACENTOS = ['inglés', 'educación', 'promoción', 'rápido', '¿Quieres aprender?'];

// ---------------------------------------------------------------- 1. UTF-8

test('UTF-8 de extremo a extremo: guion, JSON, SRT y drawtext', { timeout: 300000 }, async () => {
  await fs.mkdir(dir, { recursive: true });
  const prompt = `Video sobre ${ACENTOS.join(', ')} para la educación de adultos`;

  // a) El guion conserva los acentos y no introduce U+FFFD.
  const d = await draftScript({ prompt, duration: 15 }, { templateId: 'reel-promocional' });
  const texto = JSON.stringify(d);
  assert.ok(!texto.includes('�'), 'el guion trae el carácter de reemplazo');
  assert.match(d.tema, /inglés|educación/);

  // b) El servidor responde JSON declarando charset y con bytes UTF-8 válidos.
  const server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/video-generation/draft`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, duration: 15, format: '9:16' }),
    });
    assert.match(res.headers.get('content-type'), /charset=utf-8/i);
    const crudo = Buffer.from(await res.arrayBuffer());
    for (const palabra of ['inglés', 'educación']) {
      assert.ok(crudo.includes(Buffer.from(palabra, 'utf8')), `"${palabra}" no viaja como UTF-8`);
    }
    const json = JSON.parse(crudo.toString('utf8'));
    assert.ok(!JSON.stringify(json).includes('�'));

    // El análisis usa otro `reply`: también debe declarar charset.
    const cfg = await fetch(`${base}/api/analysis/config`);
    assert.match(cfg.headers.get('content-type'), /charset=utf-8/i);
  } finally { await new Promise(r => server.close(r)); }

  // c) El SRT se escribe en UTF-8 legible.
  const cues = buildCues({ captions: { maxCharsPerLine: 60 }, scenes: [{ text: ACENTOS.join(' '), duration: 4 }] });
  assert.ok(cues.length > 0, 'buildCues no produjo subtítulos');
  const srt = path.join(dir, 'acentos.srt');
  await fs.writeFile(srt, cuesToSrt(cues), 'utf8');
  const leido = await fs.readFile(srt);
  for (const palabra of ACENTOS) {
    assert.ok(leido.includes(Buffer.from(palabra, 'utf8')), `el SRT perdió "${palabra}"`);
  }
  assert.ok(!leido.toString('utf8').includes('�'));

  // d) FFmpeg acepta los acentos en drawtext y produce un PNG legible.
  const png = path.join(dir, 'acentos.png');
  await ffmpegRun(['-f', 'lavfi', '-i', 'color=c=0x1b4f86:s=640x360:d=1', '-frames:v', '1',
    '-vf', `drawtext=text='${ACENTOS[0]} y ${ACENTOS[1]}':fontcolor=white:fontsize=36:x=20:y=100`, png]);
  const bytes = await fs.stat(png);
  assert.ok(bytes.size > 1000, 'drawtext no produjo imagen con texto acentuado');
});

// ------------------------------------------------------------ 2. DURACIÓN

test('duración: el presupuesto de palabras respeta el objetivo pedido', () => {
  const template = getTemplate('reel-promocional');
  // El ritmo de presupuesto nunca es más optimista que el TTS real.
  assert.ok(wpmEfectivo(template) <= template.wpm);
  assert.equal(palabrasQueCaben(60, 120), 120);
  assert.equal(palabrasQueCaben(15, 120), 30);

  // Recortar no parte palabras por la mitad.
  assert.equal(recortarPalabras('una dos tres cuatro cinco', 3), 'una dos tres.');
  assert.equal(recortarPalabras('corto', 10), 'corto');
  assert.ok(!recortarPalabras('supercalifragilistico esdrujulo', 1).includes('esdru'));

  // A distintas duraciones, el guion se ajusta a cada objetivo.
  for (const objetivo of [10, 15, 30, 60]) {
    const d = draftLocal({ prompt: 'Reel sobre clases particulares de inglés online con horarios flexibles y conversación' , duration: objetivo }, template);
    const total = duracionGuion(d.escenas);
    assert.ok(Math.abs(total - objetivo) <= TOLERANCIA_SEGUNDOS,
      `objetivo ${objetivo}s -> estimado ${total}s`);
    assert.ok(d.escenas.length >= 2, 'siempre quedan al menos gancho y cierre');
    // Nunca se corta una frase a media palabra.
    for (const e of d.escenas) assert.ok(!/\s$/.test(e.text) && e.text.length > 3);
  }
});

test('ajustarDuracion corrige el desfase sin cortar audio', async () => {
  await fs.mkdir(dir, { recursive: true });
  // Proyecto sintético: dos "narraciones" de 3 s para un objetivo de 4 s.
  const escenas = [];
  for (const n of [1, 2]) {
    const wav = path.join(dir, `voz${n}.wav`);
    await ffmpegRun(['-f', 'lavfi', '-i', 'sine=frequency=300:duration=3', '-c:a', 'pcm_s16le', wav]);
    escenas.push({ id: `sc${n}`, duration: 3.45, narrationPath: path.relative(process.cwd(), wav).split(path.sep).join('/') });
  }
  const project = { id: 'vid_test_dur', scenes: escenas, voice: { enabled: true }, music: {} };
  const r = await ajustarDuracion(project, 4, {});
  assert.equal(r.ajustado, true);
  assert.equal(r.metodo, 'atempo');
  assert.ok(r.factor > 1, 'para acortar hay que acelerar');
  assert.ok(Math.abs(r.estimada - 4) <= TOLERANCIA_SEGUNDOS, `estimada ${r.estimada}`);
  // El audio sigue existiendo y suena: no se truncó a cero.
  for (const s of project.scenes) {
    const d = await probeDuration(path.resolve(s.narrationPath));
    assert.ok(d > 0.5, 'la narración quedó vacía');
  }

  // Un objetivo imposible se avisa en vez de destrozar la voz.
  const imposible = await ajustarDuracion(
    { id: 'vid_x', scenes: JSON.parse(JSON.stringify(escenas)), voice: {}, music: {} }, 1.5, {});
  assert.equal(imposible.limitado, true);
  assert.match(imposible.aviso, /Acorta el guion/);
});

// ----------------------------------------------------------------- 3. VOZ

test('voz: prioriza español de Chile y avisa cuando no hay ninguna', () => {
  const zira = { name: 'Microsoft Zira Desktop', language: 'en-US', provider: 'sapi' };
  const helena = { name: 'Microsoft Helena Desktop', language: 'es-ES', provider: 'sapi' };
  const catalina = { name: 'Microsoft Catalina Desktop', language: 'es-CL', provider: 'sapi' };
  const dalia = { name: 'Microsoft Dalia Desktop', language: 'es-MX', provider: 'sapi' };

  assert.equal(elegirVoz([zira, helena, catalina, dalia]).nombre, 'Microsoft Catalina Desktop');
  assert.equal(elegirVoz([zira, helena, dalia]).nombre, 'Microsoft Dalia Desktop', 'latinoamericano antes que España');
  assert.equal(elegirVoz([zira, helena]).nombre, 'Microsoft Helena Desktop');
  assert.equal(elegirVoz([zira, helena, catalina]).esEspanol, true);
  assert.equal(elegirVoz([zira, helena, catalina]).aviso, null);

  // Sólo voz inglesa: se usa, pero AVISANDO. Nunca en silencio.
  const soloIngles = elegirVoz([zira]);
  assert.equal(soloIngles.esEspanol, false);
  assert.equal(soloIngles.nombre, 'Microsoft Zira Desktop');
  assert.match(soloIngles.aviso, /No hay ninguna voz en español/);
  assert.match(soloIngles.aviso, /Piper|Configuración/);

  // Sin ninguna voz instalada.
  assert.match(elegirVoz([]).aviso, /sin narración/);

  // Modelos de Piper que declaran el idioma en el nombre del archivo.
  assert.equal(puntuarVoz({ name: 'es_CL-facundo-medium', provider: 'piper' }).esEspanol, true);
  assert.equal(puntuarVoz({ name: 'es_CL-facundo-medium' }).puntos, 100);
  assert.equal(puntuarVoz({ name: 'en_US-amy-medium' }).esEspanol, false);
  assert.equal(elegirVoz([zira, { name: 'es_MX-voz-medium', provider: 'piper' }]).provider, 'piper');
});

// -------------------------------------------------------------- 4. PEXELS

test('Pexels: términos visuales, sin repetir foto y con atribución (mock, sin red)', async () => {
  // Traducción de términos: el banco es anglosajón.
  assert.match(terminoVisual('clases de inglés para adultos'), /english/);
  assert.match(terminoVisual('horarios flexibles'), /schedule/);
  assert.ok(!terminoVisual('para con del las los').includes('para'), 'las palabras vacías se descartan');
  assert.ok(terminoVisual('').length >= 0);

  const previa = process.env.PEXELS_API_KEY;
  process.env.PEXELS_API_KEY = 'CLAVE-DE-PRUEBA';
  const { CONFIG } = await import('../src/config.js');
  CONFIG.image.pexelsKey = 'CLAVE-DE-PRUEBA';
  await fs.mkdir(dir, { recursive: true });

  try {
    let peticiones = 0;
    const fetchImpl = async (url, init = {}) => {
      peticiones++;
      if (String(url).includes('api.pexels.com')) {
        // La clave viaja en la cabecera, nunca en la URL.
        assert.equal(init.headers.authorization, 'CLAVE-DE-PRUEBA');
        assert.ok(!String(url).includes('CLAVE-DE-PRUEBA'), 'la clave no puede ir en la URL');
        return { ok: true, json: async () => ({ photos: [
          { id: 1, photographer: 'Ana', photographer_url: 'https://pexels.com/@ana', url: 'https://pexels.com/photo/1', src: { large2x: 'https://img/1.jpg' } },
          { id: 2, photographer: 'Beto', photographer_url: 'https://pexels.com/@beto', url: 'https://pexels.com/photo/2', src: { large2x: 'https://img/2.jpg' } },
        ] }) };
      }
      return { ok: true, arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).buffer };
    };

    const ctx = { project: { id: 'vid_pexels_test' }, width: 1080, height: 1920, fetchImpl };
    const a = await provideImage({ ...ctx, prompt: 'clases de inglés', scene: { id: 'sc1' } }, 'pexels');
    assert.equal(a.provider, 'pexels');
    assert.equal(a.credit.autor, 'Ana');
    assert.equal(a.credit.fuente, 'Pexels');
    assert.match(a.credit.licencia, /Pexels License/);
    assert.match(a.credit.url, /pexels\.com/);
    assert.match(a.credit.consulta, /english/);

    // Segunda escena: NO debe repetir la misma foto.
    const b = await provideImage({ ...ctx, prompt: 'conversación', scene: { id: 'sc2' } }, 'pexels');
    assert.equal(b.credit.autor, 'Beto', 'se repitió la misma foto en dos escenas');
    assert.notEqual(a.credit.id, b.credit.id);

    // Agotadas las fotos, cae al degradado y lo identifica como tal.
    const c = await provideImage({ ...ctx, prompt: 'otra cosa', scene: { id: 'sc3' } }, 'pexels');
    assert.equal(c.provider, 'placeholder', 'sin fotos nuevas debe caer al fondo generado');
    assert.equal(c.credit, null);
    assert.ok(peticiones > 0);
  } finally {
    process.env.PEXELS_API_KEY = previa;
    const { CONFIG } = await import('../src/config.js');
    CONFIG.image.pexelsKey = previa || '';
  }
});

test('sin PEXELS_API_KEY se usa el degradado y se identifica claramente', async () => {
  const { CONFIG } = await import('../src/config.js');
  const previa = CONFIG.image.pexelsKey;
  CONFIG.image.pexelsKey = '';
  try {
    const r = await provideImage({
      prompt: 'clases de inglés', scene: { id: 'sc_fb', onScreenTitle: 'Clases' },
      project: { id: 'vid_fb' }, brand: {}, width: 1080, height: 1920,
    }, 'pexels');
    assert.equal(r.provider, 'placeholder');
    assert.equal(r.credit, null, 'un fondo generado no tiene autor que acreditar');
  } finally { CONFIG.image.pexelsKey = previa; }
});

// ------------------------------------------------------------- 5. GUION

test('guion concreto: usa los beneficios del prompt y no inventa datos', () => {
  const prompt = 'Crea un reel vertical de 15 segundos para promocionar clases particulares de inglés online '
    + 'para adultos. Tono cercano y profesional. Destaca horarios flexibles, conversación y objetivos laborales. '
    + 'Termina invitando a solicitar información.';
  const d = draftLocal({ prompt, duration: 15 }, getTemplate('reel-promocional'));
  const todo = d.escenas.map(e => e.text).join(' ').toLowerCase();

  assert.equal(extraerTema(prompt), 'clases particulares de inglés online para adultos');
  // Lo que el prompt manda destacar sobrevive al recorte por duración.
  assert.match(todo, /horarios flexibles/);
  assert.match(todo, /conversaci[oó]n/);
  assert.match(d.escenas.at(-1).text, /[Ss]olicita información/);

  // Nada de relleno vacío del guion anterior.
  assert.ok(!/lo esencial|forma concreta de avanzar/i.test(todo), `frases vacías: ${todo}`);

  // Y NADA inventado: ni precios, ni testimonios, ni contacto.
  assert.ok(!/\$|\beuros?\b|\bpesos\b|\bgratis\b|\bdescuento\b/i.test(todo), 'no debe inventar precios');
  assert.ok(!/\b\d{6,}\b|@|\bwww\.|\.com\b/i.test(todo), 'no debe inventar datos de contacto');
  assert.ok(!/garantiz|100%|el mejor|resultados asegurados/i.test(todo), 'no debe prometer resultados');

  // Si el prompt pide WhatsApp, el cierre lo recoge (porque lo dijo el prompt).
  const wa = draftLocal({ prompt: 'Reel de clases de inglés online, escribir por WhatsApp', duration: 15 }, getTemplate('reel-promocional'));
  assert.match(wa.escenas.at(-1).text, /WhatsApp/);
});
