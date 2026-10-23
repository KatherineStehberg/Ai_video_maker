/**
 * SMOKE DE AUDIO DEL EDITOR, en un navegador real a 1366x768.
 *
 * Demuestra que al pulsar Play SALE SONIDO, no solo que hay un elemento de
 * audio: un AnalyserNode conectado a la cadena de la voz mide la energia de
 * las muestras que llegan al altavoz.
 *
 * Tambien comprueba que:
 *   - antes de pulsar Play no suena nada (sin autoplay);
 *   - no se fuerza `muted` al cambiar de escena;
 *   - Play despues de seleccionar otra escena vuelve a sonar;
 *   - la vista previa del MP4 exportado suena con su propia pista;
 *   - un proyecto sin audio lo avisa.
 *
 * Crea un proyecto corto con voces de prueba (tonos) y lo borra al acabar.
 */
import { chromium } from '../.tmp/browser-tools/node_modules/playwright-core/index.mjs';
import { createServer } from '../src/server.js';
import { makeProject, saveProject, deleteProject } from '../src/core/project.js';
import { renderProject } from '../src/core/renderer.js';
import { buildNarrationTrack } from '../src/core/tts.js';
import { loadBrand } from '../src/core/brands.js';
import { ffmpegRun } from '../src/lib/ffmpeg.js';
import { workDir, rel } from '../src/lib/paths.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const pasos = [];
const paso = (n, d) => { pasos.push(n); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };

async function proyecto({ conVoz }) {
  const p = makeProject({
    title: conVoz ? 'Smoke de audio' : 'Smoke sin audio', aspectRatio: '16:9', brand: 'personal',
    voice: { enabled: conVoz, gain: 1 },
    scenes: [
      { text: 'Primera escena con voz de prueba.', duration: 3, transition: 'none', kenBurns: 'none' },
      { text: 'Segunda escena con voz de prueba.', duration: 3, transition: 'none', kenBurns: 'none' },
      { text: 'Tercera escena con voz de prueba.', duration: 3, transition: 'none', kenBurns: 'none' },
    ],
  });
  if (conVoz) {
    const dir = path.join(workDir(p.id), 'audio');
    fs.mkdirSync(dir, { recursive: true });
    for (const [i, s] of p.scenes.entries()) {
      const wav = path.join(dir, `${s.id}.wav`);
      await ffmpegRun(['-f', 'lavfi', '-i', `sine=frequency=${330 + i * 110}:duration=2.6`, '-af', 'volume=0.3', '-ar', '48000', '-ac', '2', wav]);
      s.narrationPath = rel(wav);
    }
  }
  saveProject(p);
  return p;
}

/** Energia RMS de lo que sale por la cadena de la voz, medida durante `ms`. */
const medirVoz = (page, ms = 700) => page.evaluate(async (ms) => {
  const a = window.__audioEditor;
  if (!a?.contexto || !a?.nodoVoz) return { rms: 0, motivo: 'sin grafo de audio' };
  const an = a.contexto.createAnalyser();
  an.fftSize = 2048;
  a.nodoVoz.connect(an);
  const buf = new Float32Array(an.fftSize);
  let max = 0;
  const fin = performance.now() + ms;
  while (performance.now() < fin) {
    an.getFloatTimeDomainData(buf);
    let s = 0; for (const v of buf) s += v * v;
    max = Math.max(max, Math.sqrt(s / buf.length));
    await new Promise(r => setTimeout(r, 50));
  }
  a.nodoVoz.disconnect(an);
  return { rms: Number(max.toFixed(4)), estado: a.contexto.state };
}, ms);

const estadoMedios = page => page.evaluate(() => [...document.querySelectorAll('audio,video')].map(m => ({
  id: m.id, src: (m.getAttribute('src') || '').split('path=')[1]?.slice(-30) || '', muted: m.muted,
  volume: m.volume, paused: m.paused, autoplay: m.autoplay, t: Number(m.currentTime.toFixed(2)),
})));

const server = createServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
const creados = [];
const resultado = {};

try {
  const conVoz = await proyecto({ conVoz: true });
  const sinVoz = await proyecto({ conVoz: false });
  creados.push(conVoz, sinVoz);
  // MP4 exportado de verdad para probar tambien ese modo.
  await buildNarrationTrack(conVoz);
  const mp4 = await renderProject(conVoz, loadBrand('personal'), { aspectRatio: '16:9', subtitlesPath: null });
  conVoz.outputs = { '16:9': mp4.file }; conVoz.outputPath = mp4.file;
  conVoz.editor = { version: 1, revision: 1, exportedRevision: 1, savedAt: null, job: null };
  saveProject(conVoz);

  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const errores = [];
  page.on('pageerror', e => errores.push(e.message));
  page.on('response', r => { if (r.status() >= 400) errores.push(`HTTP ${r.status()} ${r.url()}`); });
  const peticionesAudio = [];
  page.on('response', r => {
    const u = decodeURIComponent(r.url());
    if (/\.(wav|mp4)$/.test(u.split('&')[0])) peticionesAudio.push({ archivo: u.split('path=')[1], status: r.status(), tipo: r.headers()['content-type'] });
  });

  await page.goto(`${base}/project-editor.html?id=${conVoz.id}`);
  await page.waitForSelector('.escena-item', { timeout: 30000 });
  await page.waitForTimeout(800);

  // ----------------------------------------------- 1. NADA SUENA SOLO
  const antes = await estadoMedios(page);
  assert.ok(antes.every(m => m.paused), 'antes de Play nada puede estar sonando');
  assert.ok(antes.every(m => !m.autoplay), 'ningún medio con autoplay');
  assert.ok(antes.every(m => !m.muted), 'ningún medio silenciado a la fuerza');
  paso('Sin autoplay', 'antes de pulsar Play todo está en pausa y sin silenciar');

  // ---------------------------------------- 2. PLAY: SALE SONIDO DE VERDAD
  await page.locator('#play').click();
  await page.waitForTimeout(600);
  const tras = await estadoMedios(page);
  const voz = tras.find(m => m.id === 'audio-voz');
  assert.equal(voz.paused, false, 'tras Play la voz debe estar sonando');
  assert.ok(voz.src.endsWith('.wav'), `la voz debe cargar el WAV de la escena · src=${voz.src}`);
  assert.equal(voz.muted, false);
  const m1 = await medirVoz(page);
  // El generador `sine` de FFmpeg emite a 1/8 de amplitud: con volume=0.3 el
  // pico es 0.0375 y el RMS teorico ~0.027. Silencio real da < 0.001.
  assert.ok(m1.rms > 0.01, `tras Play tiene que salir sonido (RMS esperado ~0.02-0.027) · rms=${m1.rms} (${m1.motivo || m1.estado})`);
  paso('Play suena', `voz en reproducción · energía ${m1.rms} · contexto ${m1.estado}`);

  // ----------------------------------------------- 3. PAUSA = SILENCIO
  await page.locator('#play').click();
  await page.waitForTimeout(300);
  assert.ok((await estadoMedios(page)).every(m => m.paused), 'Pausa tiene que parar todo');
  paso('Pausa', 'todos los medios en pausa');

  // ------------------------- 4. CAMBIO DE ESCENA: NI MUTED NI SILENCIO
  await page.locator('.escena-item').nth(2).click();
  await page.waitForTimeout(300);
  assert.ok((await estadoMedios(page)).every(m => !m.muted), 'cambiar de escena no puede forzar muted');
  await page.locator('#play').click();
  await page.waitForTimeout(700);
  const e3 = (await estadoMedios(page)).find(m => m.id === 'audio-voz');
  assert.equal(e3.paused, false, 'Play tras elegir la escena 3 tiene que sonar');
  const idEscena3 = conVoz.scenes[2].id;
  assert.ok(e3.src.includes(idEscena3.slice(-8)), 'debe sonar la voz de la escena 3');
  const m3 = await medirVoz(page);
  assert.ok(m3.rms > 0.01, `la escena 3 tiene que sonar · rms=${m3.rms}`);
  await page.locator('#play').click();
  paso('Cambio de escena', `Play tras elegir la escena 3 suena su voz · energía ${m3.rms}`);

  // ---------------------------- 5. VOLUMEN DE ESCUCHA Y GANANCIA DE LA VOZ
  await page.locator('.escena-item').nth(0).click();
  await page.locator('#volumen-escucha').evaluate(n => { n.value = '0.25'; n.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('#play').click();
  await page.waitForTimeout(600);
  const bajo = await medirVoz(page);
  await page.locator('#play').click();
  assert.ok(bajo.rms > 0.001 && bajo.rms < m1.rms * 0.5, `al 25 % debe sonar más bajo · ${bajo.rms} vs ${m1.rms}`);
  await page.locator('#volumen-escucha').evaluate(n => { n.value = '1'; n.dispatchEvent(new Event('input', { bubbles: true })); });
  paso('Volumen de escucha', `al 25 % la energía baja de ${m1.rms} a ${bajo.rms}`);

  // --------------------------------- 6. VOZ AL 0 %: SILENCIO VISIBLE
  await page.locator('.herr[data-herr="audio"]').click();
  await page.locator('.panel-cuerpo input[type="range"]').first().evaluate(n => {
    n.value = '0'; n.dispatchEvent(new Event('input', { bubbles: true })); n.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#aviso-audio').isVisible(), true, 'con la voz al 0 % tiene que verse un aviso');
  const textoAviso = await page.locator('#aviso-audio').textContent();
  assert.match(textoAviso, /0 %/);
  await page.locator('#play').click();
  await page.waitForTimeout(600);
  const cero = await medirVoz(page);
  await page.locator('#play').click();
  assert.ok(cero.rms < 0.001, `con la voz al 0 % no debe sonar · ${cero.rms}`);
  await page.locator('#deshacer').click();   // se deja el proyecto como estaba
  paso('Voz al 0 %', `silencio (${cero.rms}) y aviso visible: «${textoAviso}»`);

  // ------------------------------------------------- 7. MP4 EXPORTADO
  await page.locator('#ver-mp4').click();
  await page.waitForTimeout(500);
  await page.locator('#play').click();
  await page.waitForTimeout(1500);
  const v = (await estadoMedios(page)).find(m => m.id === 'marco-video');
  assert.equal(v.paused, false, 'el MP4 exportado tiene que reproducirse al pulsar Play');
  assert.ok(v.t > 0.5, `el MP4 tiene que avanzar · t=${v.t}`);
  assert.equal(v.muted, false);
  const pistasMp4 = await page.evaluate(() => {
    const el = document.getElementById('marco-video');
    return { audioTracks: el.audioTracks?.length ?? null, webkitAudio: el.webkitAudioDecodedByteCount ?? null };
  });
  assert.ok(pistasMp4.webkitAudio > 0 || pistasMp4.audioTracks > 0, `el navegador tiene que decodificar audio del MP4 · ${JSON.stringify(pistasMp4)}`);
  await page.locator('#play').click();
  paso('MP4 exportado', `se reproduce y decodifica ${pistasMp4.webkitAudio} bytes de audio`);

  // ------------------------------------------------- 8. PROYECTO SIN AUDIO
  await page.goto(`${base}/project-editor.html?id=${sinVoz.id}`);
  await page.waitForSelector('.escena-item', { timeout: 30000 });
  await page.waitForTimeout(500);
  assert.equal(await page.locator('#aviso-audio').isVisible(), true, 'sin audio tiene que avisarse');
  const avisoSin = await page.locator('#aviso-audio').textContent();
  await page.locator('#play').click();
  // El reloj muestra segundos enteros: hace falta pasar de 1 s para verlo.
  await page.waitForTimeout(1600);
  const reloj = await page.locator('#tiempo').textContent();
  await page.locator('#play').click();
  assert.notEqual(reloj.split(' / ')[0], '0:00', 'sin audio la vista previa sigue avanzando');
  paso('Proyecto sin audio', `aviso «${avisoSin}» y la vista previa sigue funcionando`);

  // ------------------------------------------------- 9. ARCHIVOS SERVIDOS
  const wavs = peticionesAudio.filter(p => p.archivo?.endsWith('.wav'));
  assert.ok(wavs.length > 0, 'la vista previa tiene que pedir los WAV de voz');
  assert.ok(wavs.every(p => [200, 206].includes(p.status) && /audio\/wav/.test(p.tipo)), JSON.stringify(wavs));
  const mp4s = peticionesAudio.filter(p => p.archivo?.endsWith('.mp4'));
  assert.ok(mp4s.every(p => [200, 206].includes(p.status) && /video\/mp4/.test(p.tipo)), JSON.stringify(mp4s));
  paso('Archivos servidos', `${wavs.length} peticiones WAV (audio/wav) y ${mp4s.length} MP4 (video/mp4)`);

  assert.deepEqual(errores, [], `errores: ${errores.join(' | ')}`);
  resultado.ok = true;
  resultado.pasos = pasos;
  resultado.energia = { play: m1.rms, escena3: m3.rms, volumen25: bajo.rms, voz0: cero.rms };
  console.log('\n' + JSON.stringify(resultado, null, 2));
} finally {
  if (browser) await browser.close();
  for (const p of creados) {
    try { deleteProject(p.id); } catch { /* ya borrado */ }
    try { fs.rmSync(workDir(p.id), { recursive: true, force: true }); } catch { /* nada */ }
  }
  for (const f of fs.readdirSync('output/final').filter(f => creados.some(p => f.includes(p.id)))) {
    fs.rmSync(path.join('output/final', f), { force: true });
  }
  await new Promise(r => server.close(r));
}
