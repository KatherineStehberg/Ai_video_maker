import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { makeProject, saveProject, loadProject, deleteProject } from '../src/core/project.js';
import { renderProject } from '../src/core/renderer.js';
import { buildNarrationTrack } from '../src/core/tts.js';
import { loadBrand } from '../src/core/brands.js';
import { ffmpegRun, resolveFfmpeg } from '../src/lib/ffmpeg.js';
import { workDir, rel, abs } from '../src/lib/paths.js';
import { derivar, guardar } from '../src/project-editor/service.js';
import { vozEn, gananciaVoz, avisoAudio, TOLERANCIA_SEG } from '../src/ui/project-editor/audio.js';

/**
 * AUDIO: de la voz generada al MP4, pasando por la vista previa.
 *
 * Todo local. Las voces de prueba son tonos generados con FFmpeg: no hace
 * falta un motor TTS para comprobar que el sonido llega, a que nivel y con
 * que duracion.
 */

// ------------------------------------------------------------- utilidades

async function ffprobeJson(file) {
  const { ffprobe } = await resolveFfmpeg();
  const r = spawnSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

/** Nivel medio y maximo del audio, en dB. */
async function nivel(file) {
  const { ffmpeg } = await resolveFfmpeg();
  const r = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const media = Number(/mean_volume: (-?[\d.]+|-inf) dB/.exec(r.stderr)?.[1]);
  const max = Number(/max_volume: (-?[\d.]+|-inf) dB/.exec(r.stderr)?.[1]);
  return { media: Number.isFinite(media) ? media : -Infinity, max: Number.isFinite(max) ? max : -Infinity };
}

/**
 * Proyecto de tres escenas con una "voz" por escena (tono de 440 Hz a nivel
 * de voz hablada), igual que la dejaria el TTS: un WAV por escena y la pista
 * montada en narration.wav.
 */
async function proyectoConVoz(extra = {}) {
  const p = makeProject({
    title: 'Prueba de audio',
    aspectRatio: '16:9',
    brand: 'personal',
    captions: { enabled: false, burnIn: false },
    scenes: [
      { text: 'Primera escena.', duration: 2, transition: 'none', kenBurns: 'none' },
      { text: 'Segunda escena.', duration: 2, transition: 'none', kenBurns: 'none' },
      { text: 'Tercera escena.', duration: 2, transition: 'none', kenBurns: 'none' },
    ],
    ...extra,
  });
  const dir = path.join(workDir(p.id), 'audio');
  fs.mkdirSync(dir, { recursive: true });
  for (const [i, s] of p.scenes.entries()) {
    const wav = path.join(dir, `${s.id}.wav`);
    // 1,5 s de tono en una escena de 2 s: igual que una voz real, que no
    // llena la escena entera. -12 dBFS de pico ~ nivel de voz grabada.
    await ffmpegRun(['-f', 'lavfi', '-i', `sine=frequency=${440 + i * 110}:duration=1.5`,
      '-af', 'volume=0.25', '-ar', '48000', '-ac', '2', wav]);
    s.narrationPath = rel(wav);
  }
  saveProject(p);
  return p;
}

async function renderizar(p) {
  const track = await buildNarrationTrack(p);
  const r = await renderProject(p, loadBrand(p.brand), { aspectRatio: '16:9', subtitlesPath: null });
  return { ...r, track };
}

const limpiar = p => {
  try { deleteProject(p.id); } catch { /* ya borrado */ }
  try { fs.rmSync(workDir(p.id), { recursive: true, force: true }); } catch { /* nada */ }
};

// ------------------------------------------------ 1. PURAS (VISTA PREVIA)

test('la vista previa sabe qué voz toca en cada instante', () => {
  const escenas = [
    { index: 0, start: 0, end: 2, narracion: { url: '/file?path=a.wav' } },
    { index: 1, start: 2, end: 4, narracion: { url: '/file?path=b.wav' } },
    { index: 2, start: 4, end: 6, narracion: null },
  ];
  assert.deepEqual(vozEn(escenas, 0.5), { index: 0, url: '/file?path=a.wav', offset: 0.5, start: 0 });
  assert.deepEqual(vozEn(escenas, 3.25), { index: 1, url: '/file?path=b.wav', offset: 1.25, start: 2 });
  assert.deepEqual(vozEn(escenas, 5), { index: 2, url: null, offset: 0, start: 4 }, 'escena sin voz: silencio, no error');
  assert.equal(vozEn(escenas, 99), null);
});

test('una escena excluida nunca suena en la vista previa', () => {
  const escenas = [
    { index: 0, start: 0, end: 2, narracion: { url: 'a' } },
    { index: 1, start: 2, end: 2, excluida: true, narracion: { url: 'excluida' } },
    { index: 2, start: 2, end: 4, narracion: { url: 'c' } },
  ];
  assert.equal(vozEn(escenas, 2.5).url, 'c', 'tras una excluida suena la siguiente, sin hueco');
});

test('la ganancia de la voz respeta los mismos límites que el render', () => {
  assert.equal(gananciaVoz({ voice: { gain: 1 } }), 1);
  assert.equal(gananciaVoz({ voice: { gain: 1.4 } }), 1.4);
  assert.equal(gananciaVoz({ voice: { gain: 5 } }), 2, 'nunca más de 2x');
  assert.equal(gananciaVoz({ voice: { gain: -1 } }), 0);
  assert.equal(gananciaVoz({ voice: {} }), 1, 'sin valor, 100 %; nunca 0 por accidente');
  assert.equal(gananciaVoz({ voice: { gain: 1, enabled: false } }), 0, 'silenciada suena a 0');
  assert.ok(TOLERANCIA_SEG > 0 && TOLERANCIA_SEG < 1);
});

test('un proyecto sin audio, silenciado o al 0 % lo dice junto al Play', () => {
  const derivado = (conVoz, musica = null) => ({ audio: { narracion: { escenasConVoz: conVoz, escenas: 3 }, musica, aviso: null } });

  assert.equal(avisoAudio({ voice: { enabled: true, gain: 1 } }, derivado(0)).texto, 'Sin audio');
  assert.equal(avisoAudio({ voice: { enabled: false, gain: 1 } }, derivado(3)).texto, 'Voz silenciada');
  assert.equal(avisoAudio({ voice: { enabled: true, gain: 0 } }, derivado(3)).texto, 'Voz al 0 %');
  assert.equal(avisoAudio({ voice: { enabled: true, gain: 1 } }, derivado(3)), null, 'con voz normal no hay aviso');
});

// ------------------------------------------- 2. DATOS DERIVADOS (BACKEND)

test('cada escena con voz lleva la URL de su audio para la vista previa', async () => {
  const p = await proyectoConVoz();
  try {
    const d = derivar(loadProject(p.id));
    for (const e of d.escenas) {
      assert.ok(e.narracion?.url, `la escena ${e.numero} no expone su voz`);
      assert.match(e.narracion.url, /^\/file\?path=output/);
      assert.equal(e.tieneNarracion, true);
    }
    assert.equal(d.audio.narracion.escenasConVoz, 3);
    assert.equal(d.audio.exportaraAudio, true);
    assert.equal(d.audio.aviso, null);
  } finally { limpiar(p); }
});

test('una escena excluida no ocupa tiempo: la voz no se desfasa', () => {
  const p = makeProject({ title: 'x', scenes: [
    { text: 'uno.', duration: 6 }, { text: 'dos.', duration: 3, excluida: true }, { text: 'tres.', duration: 4 },
  ] });
  const d = derivar(p);
  assert.equal(d.duracion, 10);
  assert.deepEqual(d.escenas.map(e => [e.start, e.end]), [[0, 6], [6, 6], [6, 10]],
    'antes la tercera iba de 9 a 13 y el reloj se cortaba en 10');
});

test('sin voz ni música, el backend lo declara', () => {
  const d = derivar(makeProject({ title: 'mudo', scenes: [{ text: 'hola.', duration: 2 }] }));
  assert.equal(d.audio.exportaraAudio, false);
  assert.match(d.audio.aviso, /no tiene audio/);
});

// ------------------------------------------------ 3. RENDER REAL CON AUDIO

test('el render con narración produce una pista AAC que cubre el video', { timeout: 300000 }, async () => {
  const p = await proyectoConVoz();
  try {
    const r = await renderizar(p);
    const j = await ffprobeJson(r.absolute);
    const v = j.streams.find(s => s.codec_type === 'video');
    const a = j.streams.filter(s => s.codec_type === 'audio');

    assert.ok(v, 'el MP4 debe tener video');
    assert.equal(a.length, 1, 'exactamente una pista de audio: no se usó -an');
    assert.equal(a[0].codec_name, 'aac');
    assert.equal(a[0].channels, 2);
    assert.equal(Number(a[0].sample_rate), 48000);
    assert.equal(Number(a[0].start_time), 0, 'el audio empieza en 0');
    assert.ok(Number(a[0].duration) >= Number(v.duration) - 0.2,
      `el audio (${a[0].duration}) termina antes que el video (${v.duration})`);

    const n = await nivel(r.absolute);
    assert.ok(n.media > -40, `el audio tiene que oírse: media ${n.media} dB`);
  } finally { limpiar(p); }
});

test('el render sin audio produce un MP4 válido y sin pista falsa', { timeout: 300000 }, async () => {
  const p = makeProject({
    title: 'Prueba sin audio', aspectRatio: '16:9', brand: 'personal',
    voice: { enabled: false }, captions: { enabled: false },
    scenes: [{ text: 'Sin voz.', duration: 2, transition: 'none', kenBurns: 'none' }],
  });
  saveProject(p);
  try {
    const r = await renderProject(p, loadBrand(p.brand), { aspectRatio: '16:9', subtitlesPath: null });
    const j = await ffprobeJson(r.absolute);
    assert.ok(j.streams.some(s => s.codec_type === 'video'), 'tiene video');
    assert.equal(j.streams.filter(s => s.codec_type === 'audio').length, 0, 'no inventa una pista de silencio');
    assert.ok(Number(j.format.duration) > 1.5);
  } finally { limpiar(p); }
});

test('voice.gain cambia el volumen sin quitar la pista', { timeout: 300000 }, async () => {
  const normal = await proyectoConVoz();
  const baja = await proyectoConVoz({ voice: { enabled: true, gain: 0.5 } });
  try {
    const a = await renderizar(normal);
    const b = await renderizar(baja);
    const na = await nivel(a.absolute);
    const nb = await nivel(b.absolute);
    assert.equal((await ffprobeJson(b.absolute)).streams.filter(s => s.codec_type === 'audio').length, 1);
    // 0.5 de ganancia son -6 dB. Se deja margen por la codificacion AAC.
    const diferencia = na.max - nb.max;
    assert.ok(diferencia > 4.5 && diferencia < 7.5, `se esperaban ~6 dB menos y hay ${diferencia.toFixed(2)}`);
  } finally { limpiar(normal); limpiar(baja); }
});

test('un volumen de 0 silencia a propósito y se avisa', { timeout: 300000 }, async () => {
  const p = await proyectoConVoz({ voice: { enabled: true, gain: 0 } });
  try {
    const r = await renderizar(p);
    const j = await ffprobeJson(r.absolute);
    assert.equal(j.streams.filter(s => s.codec_type === 'audio').length, 1, 'la pista sigue ahí');
    const n = await nivel(r.absolute);
    assert.ok(n.max < -80, `con ganancia 0 no puede oírse nada: max ${n.max} dB`);

    const d = derivar(loadProject(p.id));
    assert.match(d.audio.aviso, /0 %/, 'el silencio se declara, no se descubre al escuchar');
  } finally { limpiar(p); }
});

// ------------------------------------------------------- 4. PERSISTENCIA

test('el volumen de voz y música sobrevive a guardar y recargar', async () => {
  const p = makeProject({ title: 'vol', scenes: [{ text: 'a.', duration: 2 }] });
  saveProject(p);
  try {
    await guardar(p.id, { revision: 1, voice: { gain: 0.35 }, music: { volume: 0.4 } });
    const l = loadProject(p.id);
    assert.equal(l.voice.gain, 0.35);
    assert.equal(l.music.volume, 0.4);

    // Un control vacío no puede convertirse en silencio por accidente.
    await guardar(p.id, { revision: 2, voice: { gain: '' } });
    assert.notEqual(loadProject(p.id).voice.gain, 0, 'un valor vacío no puede dejar la voz a 0');
  } finally { deleteProject(p.id); }
});
