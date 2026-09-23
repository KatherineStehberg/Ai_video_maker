import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ffmpegRun, probeDuration, resolveFfmpeg, run } from '../src/lib/ffmpeg.js';
import { renderProject } from '../src/core/renderer.js';
import { loadBrand } from '../src/core/brands.js';
import { makeProject, saveProject, deleteProject } from '../src/core/project.js';
import { normalizarEfecto } from '../src/project-editor/audio.js';
import { listarSfx } from '../src/project-editor/media-library.js';
import { abs } from '../src/lib/paths.js';

/**
 * EL AUDIO TIENE QUE LLEGAR AL MP4.
 *
 * No basta con que la interfaz enseñe el efecto ni con que el plan de mezcla lo
 * incluya: lo que cuenta es el archivo exportado. Aqui se renderiza de verdad y
 * se mide el resultado con ffprobe y con filtros de FFmpeg, no se inspecciona
 * el proyecto.
 *
 * Las medidas son de ENERGIA POR BANDA: la campanilla vive en torno a 1,5 kHz y
 * la musica de fondo esta filtrada por debajo de 2,2 kHz, asi que aislando esa
 * banda se puede afirmar que el efecto suena, y en su segundo, sin depender de
 * oirlo.
 */

const MUSICA = 'data/assets/music/calma-luminosa.mp3';

/** Nivel de pico en una banda y un tramo del archivo, en dBFS. */
async function nivel(file, { desde, hasta, banda = null }) {
  const filtros = [`atrim=${desde}:${hasta}`, 'asetpts=PTS-STARTPTS'];
  if (banda) filtros.push(`bandpass=f=${banda}:width_type=h:w=300`);
  filtros.push('volumedetect');
  const r = await ffmpegRun(['-i', file, '-af', filtros.join(','), '-f', 'null', '-']);
  const max = /max_volume: (\S+)/.exec(r.stderr)?.[1];
  return max === undefined ? -Infinity : Number(max);
}

/**
 * Pistas del archivo segun FFPROBE.
 *
 * No vale mirar la salida de `ffmpeg -i`: ahi aparecen tanto la pista de
 * ENTRADA como la de salida, y contar «2» donde hay una sola.
 */
async function streams(file) {
  const { ffprobe } = await resolveFfmpeg();
  const r = await run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  return JSON.parse(r.stdout).streams;
}

const hayMusica = fs.existsSync(abs(MUSICA));

test('el efecto elegido suena en el MP4 exportado, en su segundo', { timeout: 600000, skip: !hayMusica && 'falta la biblioteca de música local' }, async (t) => {
  const efectos = await listarSfx({});
  const campana = efectos.efectos.find(e => /campanilla/i.test(e.titulo));
  assert.ok(campana, 'no está el efecto de campanilla en la biblioteca local');

  const p = makeProject({
    title: 'Prueba de exportación con efecto',
    aspectRatio: '16:9',
    scenes: [
      { text: 'Primera escena.', duration: 3, kenBurns: 'none' },
      // La segunda entra con un fundido real; no debe acortar el video.
      { text: 'Segunda escena.', duration: 3, kenBurns: 'none', transition: { type: 'fade', duration: 0.5 } },
    ],
    captions: { enabled: false },
    voice: { enabled: false },
    music: { path: MUSICA, enabled: true, volume: 0.25 },
  });
  // La campanilla suena al empezar la SEGUNDA escena: segundo 3 del video.
  p.sfx = [normalizarEfecto({ path: campana.path, sceneId: p.scenes[1].id, start: 0, volume: 1 })];
  saveProject(p);

  try {
    const r = await renderProject(p, loadBrand(p.brand), { aspectRatio: '16:9' });
    const file = path.isAbsolute(r.file) ? r.file : abs(r.file);
    assert.ok(fs.existsSync(file), 'el render no dejó archivo');

    // ---- 1. Duración: la transición no puede robar tiempo ----
    const dur = await probeDuration(file);
    assert.ok(Math.abs(dur - 6) < 0.35, `el video dura ${dur} s y debería durar 6: la transición acortó el montaje`);

    // ---- 2. Hay UNA pista de audio, y es AAC ----
    const audio = (await streams(file)).filter(x => x.codec_type === 'audio');
    assert.equal(audio.length, 1, `se esperaba una pista de audio y hay ${audio.length}`);
    assert.equal(audio[0].codec_name, 'aac', `códec inesperado: ${audio[0].codec_name}`);

    // ---- 3. La campanilla suena DONDE se puso, y no antes ----
    // Se aísla su banda (1,5 kHz), donde la música apenas tiene energía.
    const enElEfecto = await nivel(file, { desde: 2.9, hasta: 3.9, banda: 1568 });
    const antes = await nivel(file, { desde: 0.5, hasta: 1.5, banda: 1568 });
    assert.ok(enElEfecto - antes > 6,
      `la campanilla no destaca en su segundo: ${enElEfecto.toFixed(1)} dB en el efecto frente a ${antes.toFixed(1)} dB antes`);
    t.diagnostic(`banda de la campanilla: ${antes.toFixed(1)} dB antes → ${enElEfecto.toFixed(1)} dB en el segundo 3`);

    // ---- 4. La música suena durante todo el video, no solo al principio ----
    const musicaInicio = await nivel(file, { desde: 0.5, hasta: 1.5 });
    const musicaFinal = await nivel(file, { desde: 4.5, hasta: 5.5 });
    assert.ok(musicaInicio > -60, `no se oye nada al principio: ${musicaInicio} dB`);
    assert.ok(musicaFinal > -60, `el audio se corta antes de acabar: ${musicaFinal} dB`);

    // ---- 5. Y no satura ----
    const pico = await nivel(file, { desde: 0, hasta: Math.min(6, dur) });
    assert.ok(pico <= 0.1, `la mezcla satura: pico de ${pico} dBFS`);
  } finally { deleteProject(p.id); }
});

test('sin ninguna fuente de audio, el MP4 sale sin pista, no con silencio', { timeout: 600000 }, async () => {
  const p = makeProject({
    title: 'Prueba de exportación muda',
    aspectRatio: '16:9',
    scenes: [{ text: 'Escena única.', duration: 2, kenBurns: 'none' }],
    captions: { enabled: false },
    // Sin voz generada, sin música y sin efectos no hay NADA que sonar.
    voice: { enabled: false },
  });
  saveProject(p);

  try {
    const r = await renderProject(p, loadBrand(p.brand), { aspectRatio: '16:9' });
    const file = path.isAbsolute(r.file) ? r.file : abs(r.file);
    const audio = (await streams(file)).filter(x => x.codec_type === 'audio');
    assert.equal(audio.length, 0, 'un video sin audio no debe llevar una pista de silencio para disimular');
    assert.ok((await probeDuration(file)) > 1.5, 'el video tiene que existir igualmente');
  } finally { deleteProject(p.id); }
});
