/**
 * FLUJO REAL DE LA BIBLIOTECA EN EL EDITOR, contra el servidor en marcha.
 *
 *   Recursos -> buscar «naturaleza espiritual» en Pexels -> elegir -> guardar
 *   -> F5 -> sigue elegida -> Audio -> biblioteca -> escuchar la vista previa
 *   -> usar -> volumen -> guardar -> F5 -> exportar -> comprobar el MP4
 *
 * Usa Pexels DE VERDAD (hace falta PEXELS_API_KEY en el .env del servidor) y
 * trabaja sobre una COPIA del proyecto que se le indique: el original no se
 * toca. La copia se deja en disco para poder escucharla.
 *
 * Uso: node scripts/editor-library-smoke.mjs <idProyecto> [urlBase]
 */
import { chromium } from '../.tmp/browser-tools/node_modules/playwright-core/index.mjs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadProject, saveProject, makeProject } from '../src/core/project.js';
import { resolveFfmpeg } from '../src/lib/ffmpeg.js';
import { abs } from '../src/lib/paths.js';

const origenId = process.argv[2];
const base = process.argv[3] || 'http://127.0.0.1:4321';
if (!origenId) { console.error('Uso: node scripts/editor-library-smoke.mjs <idProyecto> [urlBase]'); process.exit(1); }

const pasos = [];
const paso = (n, d) => { pasos.push(n); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };

// ---------------------------------------------------------- copia de trabajo
const origen = loadProject(origenId);
assert.ok(origen, `no existe el proyecto ${origenId}`);
const copia = makeProject({
  ...origen, id: undefined, title: `${origen.title} · biblioteca`, editor: null, outputs: {}, outputPath: null,
  music: { path: null, enabled: false, volume: 0.12 },
  scenes: origen.scenes.map(s => ({ ...s, id: undefined })),
});
saveProject(copia);
console.log(`Copia de trabajo: ${copia.id} (${copia.scenes.length} escenas, formato ${copia.aspectRatio})`);

const { ffmpeg, ffprobe } = await resolveFfmpeg();
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await b.newPage({ viewport: { width: 1366, height: 768 } });
const errores = [];
page.on('pageerror', e => errores.push(e.message));
page.on('response', r => { if (r.status() >= 500) errores.push(`HTTP ${r.status()} ${r.url()}`); });
const estado = () => page.locator('#estado-guardado').textContent();
const url = `${base}/project-editor.html?id=${copia.id}`;

try {
  await page.goto(url);
  await page.waitForSelector('.escena-item', { timeout: 60000 });
  const imagenAntes = loadProject(copia.id).scenes[0].assetPath;

  // -------------------------------------------------- 1-4. BUSCAR Y ELEGIR
  await page.locator('.herr[data-herr="recursos"]').click();
  const buscador = page.locator('.panel-cuerpo input[type="search"]');
  await buscador.fill('naturaleza espiritual');
  await page.locator('.panel-cuerpo button', { hasText: 'Buscar imágenes gratuitas' }).click();
  await page.waitForSelector('.biblio-tarjeta', { timeout: 30000 });
  const n = await page.locator('.biblio-tarjeta').count();
  assert.ok(n > 0, 'la búsqueda tiene que devolver imágenes');
  paso('Búsqueda en Pexels', `${n} imágenes para «naturaleza espiritual»`);

  await page.locator('.biblio-tarjeta').nth(1).click();
  await page.waitForSelector('.biblio-previa img');
  const atribPrevia = await page.locator('.biblio-previa .atribucion').textContent();
  assert.match(atribPrevia, /Foto de .+ en Pexels · Licencia de Pexels/);
  paso('Vista previa antes de elegir', atribPrevia.trim());

  await page.locator('.biblio-previa button', { hasText: /imagen/ }).first().click();
  await page.waitForFunction(() => document.getElementById('estado-guardado').textContent.includes('sin guardar'), null, { timeout: 60000 });
  const srcPreview = await page.locator('#marco-img').getAttribute('src');
  assert.match(decodeURIComponent(srcPreview), /_library\/pexels\/\d+\.jpg/, 'la vista previa tiene que mostrar la imagen elegida ya');
  paso('Imagen elegida', `preview → ${decodeURIComponent(srcPreview).split('path=')[1]} · «Cambios sin guardar»`);

  // ----------------------------------------------------- 5-7. GUARDAR Y F5
  await page.locator('#guardar').click();
  await page.waitForFunction(() => document.getElementById('estado-guardado').textContent.trim() === 'Guardado', null, { timeout: 30000 });
  await page.reload();
  await page.waitForSelector('.escena-item', { timeout: 60000 });
  const tras = loadProject(copia.id).scenes[0];
  assert.match(tras.assetPath, /_library\/pexels\/\d+\.jpg$/);
  assert.notEqual(tras.assetPath, imagenAntes);
  assert.equal(tras.assetCredit?.proveedor, 'pexels');
  await page.locator('.herr[data-herr="recursos"]').click();
  const atrib = await page.locator('.panel-cuerpo .atribucion').first().textContent();
  assert.match(atrib, /en Pexels/);
  paso('Persistencia de la imagen', `tras F5: ${tras.assetPath} · ${tras.assetCredit.autor}`);

  // ---------------------------------------------- 8-11. MUSICA Y SU PREVIEW
  await page.locator('.herr[data-herr="audio"]').click();
  await page.locator('.panel-cuerpo button', { hasText: 'Agregar música' }).click();
  await page.waitForSelector('.musica-tarjeta', { timeout: 20000 });
  const tarjetas = await page.locator('.musica-tarjeta').count();
  const primera = page.locator('.musica-tarjeta').first();
  const titulo = await primera.locator('strong').textContent();
  const detalle = await primera.locator('.mini').allTextContents();
  paso('Biblioteca de música', `${tarjetas} pistas · «${titulo}» · ${detalle.join(' | ')}`);

  // Escuchar la vista previa: el <audio> de la tarjeta tiene que avanzar.
  const escucha = await primera.locator('audio').evaluate(async (a) => {
    a.muted = false; a.volume = 1;
    await a.play();
    await new Promise(r => setTimeout(r, 1500));
    const r = { pausado: a.paused, t: Number(a.currentTime.toFixed(2)), bytes: a.webkitAudioDecodedByteCount ?? null };
    a.pause();
    return r;
  });
  assert.equal(escucha.pausado, false);
  assert.ok(escucha.t > 0.8, `la vista previa tiene que avanzar: ${escucha.t}`);
  paso('Preview de música', `sonó ${escucha.t} s · ${escucha.bytes} bytes decodificados`);

  await primera.locator('button', { hasText: 'Usar esta música' }).click();
  await page.waitForFunction(() => document.getElementById('estado-guardado').textContent.includes('sin guardar'));
  assert.ok(await page.locator('.tl-pista[data-pista="musica"]').count() === 1, 'la pista de música aparece ya en la línea de tiempo');

  const vol = page.locator('.panel-cuerpo input[type="range"]').nth(1);   // 0: voz, 1: música
  await vol.evaluate(n => { n.value = '0.3'; n.dispatchEvent(new Event('input', { bubbles: true })); n.dispatchEvent(new Event('change', { bubbles: true })); });
  paso('Música elegida', `«${titulo}» al 30 % · pista en la línea de tiempo`);

  // --------------------------------------------------- 12-13. GUARDAR Y F5
  await page.locator('#guardar').click();
  await page.waitForFunction(() => document.getElementById('estado-guardado').textContent.trim() === 'Guardado', null, { timeout: 30000 });
  await page.reload();
  await page.waitForSelector('.escena-item', { timeout: 60000 });
  await page.waitForTimeout(1500);
  const m = loadProject(copia.id).music;
  assert.equal(m.volume, 0.3);
  assert.equal(m.enabled, true);
  assert.ok(m.credit?.licencia, 'la música guarda su licencia');
  const ondas = await page.locator('.tl-pista[data-pista="musica"] canvas').count();
  assert.equal(ondas, 1, 'tras guardar, la pista de música muestra su forma de onda real');
  // El deslizador tiene que MOSTRAR el volumen guardado. Antes nacia con el
  // rango por defecto (0-100, paso 1) y 0.3 se dibujaba como 0.
  await page.locator('.herr[data-herr="audio"]').click();
  const deslizador = await page.locator('.panel-cuerpo input[type="range"]').nth(1).inputValue();
  assert.equal(Number(deslizador), 0.3, `el control de volumen tiene que mostrar 0.3 y muestra ${deslizador}`);
  paso('Persistencia de la música', `tras F5: ${m.path} · ${m.volume * 100} % (el control lo muestra) · ${m.credit.licencia} · onda real en la línea de tiempo`);
  await page.screenshot({ path: '.tmp/biblioteca-editor.png' });
  await page.locator('.herr[data-herr="recursos"]').click();
  await page.locator('.panel-cuerpo input[type="search"]').fill('naturaleza espiritual');
  await page.locator('.panel-cuerpo button', { hasText: 'Buscar imágenes gratuitas' }).click();
  await page.waitForSelector('.biblio-tarjeta', { timeout: 30000 });
  await page.screenshot({ path: '.tmp/biblioteca-recursos.png' });
  await page.locator('.herr[data-herr="audio"]').click();
  await page.locator('.panel-cuerpo button', { hasText: /Cambiar música|Agregar música/ }).first().click();
  await page.waitForSelector('.musica-tarjeta', { timeout: 20000 });
  await page.screenshot({ path: '.tmp/biblioteca-audio.png' });

  // ------------------------------------------------------------ 14. EXPORTAR
  await page.locator('#exportar').click();
  await page.waitForFunction(() => /Listo|MP4 exportado/.test(document.getElementById('panel-pista').textContent), null, { timeout: 900000 });
  const fin = loadProject(copia.id);
  const mp4 = abs(fin.outputPath);
  assert.ok(fs.existsSync(mp4), 'la exportación tiene que dejar el MP4');
  assert.equal(fin.editor.exportedRevision, fin.editor.revision);
  paso('Exportación', fin.outputPath);

  // ------------------------------------------------ 15-17. EL MP4 POR DENTRO
  const j = JSON.parse(spawnSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', mp4], { encoding: 'utf8' }).stdout);
  const v = j.streams.find(s => s.codec_type === 'video');
  const a = j.streams.filter(s => s.codec_type === 'audio');
  assert.equal(a.length, 1);
  assert.equal(a[0].codec_name, 'aac');
  assert.ok(Number(a[0].duration) >= Number(v.duration) - 0.2, 'el audio cubre todo el video');

  const nivel = (desde, dur) => {
    const e = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-ss', String(desde), '-t', String(dur), '-i', mp4, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const x = /mean_volume: (-?[\d.]+|-inf) dB/.exec(e)?.[1];
    return x === '-inf' || x === undefined ? -Infinity : Number(x);
  };
  // Hueco sin voz: el final de la escena 1, entre su WAV y la escena 2. Ahi
  // solo puede sonar la musica. Con voz, el nivel tiene que ser mas alto.
  const s1 = fin.scenes[0];
  const vozSeg = Number(spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', abs(s1.narrationPath)], { encoding: 'utf8' }).stdout);
  const hueco = nivel(vozSeg + 0.1, Math.max(0.2, s1.duration - vozSeg - 0.2));
  const conVoz = nivel(0.2, Math.max(0.5, vozSeg - 0.4));
  assert.ok(hueco > -60, `en el hueco sin voz tiene que oírse la música: ${hueco} dB`);
  assert.ok(conVoz > hueco + 3, `con voz el nivel tiene que subir sobre la música: voz+música ${conVoz} dB, solo música ${hueco} dB`);
  paso('Voz y música en el MP4', `AAC ${a[0].channels} canales, ${Number(a[0].duration).toFixed(2)} s de ${Number(v.duration).toFixed(2)} · voz+música ${conVoz} dB · solo música ${hueco} dB`);

  const ass = path.join('output', 'drafts', copia.id, `captions_${fin.aspectRatio.replace(':', 'x')}.ass`);
  assert.ok(fs.existsSync(ass), 'se generaron los subtítulos del formato');
  const lineas = fs.readFileSync(ass, 'utf8').split('\n').filter(l => l.startsWith('Dialogue:')).length;
  assert.ok(lineas > 0);
  paso('Subtítulos', `${lineas} subtítulos quemados`);

  // La imagen cubre la escena entera: al principio y al final de la escena 1.
  const dir = path.resolve('.tmp/biblioteca-frames');
  fs.mkdirSync(dir, { recursive: true });
  for (const [nombre, t] of [['inicio', 0.1], ['final', s1.duration - 0.15]]) {
    spawnSync(ffmpeg, ['-y', '-ss', String(t), '-i', mp4, '-frames:v', '1', path.join(dir, `escena1-${nombre}.png`)]);
  }
  paso('Fotogramas', `${dir}\\escena1-inicio.png y escena1-final.png`);

  assert.deepEqual(errores, [], `errores: ${errores.join(' | ')}`);
  console.log(JSON.stringify({ ok: true, copia: copia.id, mp4: fin.outputPath, pasos }, null, 2));
} finally {
  await b.close();
}
