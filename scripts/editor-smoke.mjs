/**
 * Smoke test del flujo completo desde el navegador, contra el backend real:
 *   subir -> analizar -> propuesta -> aprobar -> exportar -> descargar
 *
 * Requiere Node 20+ y playwright-core en .tmp/browser-tools (ver README).
 * No usa Gemini ni hace ninguna llamada externa.
 */
import { chromium } from '../.tmp/browser-tools/node_modules/playwright-core/index.mjs';
import { createServer } from '../src/server.js';
import { ffmpegRun } from '../src/lib/ffmpeg.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = '';   // nunca una llamada de pago desde un smoke test

const dir = path.resolve('.tmp/editor-smoke');
await fs.mkdir(dir, { recursive: true });
const fixture = path.join(dir, 'editor-source.mp4');
const hash = async f => { const h = createHash('sha256'); for await (const b of createReadStream(f)) h.update(b); return h.digest('hex'); };

// 4 s a 30 FPS: dos planos con corte en 1.65 s y clics cada 0.5 s (120 BPM).
await ffmpegRun(['-f', 'lavfi', '-i', 'color=c=navy:s=320x180:r=30:d=1.65',
  '-f', 'lavfi', '-i', 'color=c=teal:s=320x180:r=30:d=2.35',
  '-f', 'lavfi', '-i', 'aevalsrc=if(lt(mod(t\\,0.5)\\,0.03)\\,0.8*sin(2*PI*1000*t)\\,0):s=16000:d=4',
  '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a',
  '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', fixture]);
const sourceHash = await hash(fixture);

const server = createServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
const steps = [];
const step = (name, detail) => { steps.push({ name, detail }); console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); };

try {
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  // Se registra la URL concreta: un 404 silencioso es un fallo que hay que ver.
  page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });

  await page.goto(`${base}/editor.html`);
  await page.waitForFunction(() => document.getElementById('config-hint').textContent.includes('este equipo'));
  step('Carga de la página', 'modo local, sin clave Gemini');

  // Pantalla inicial: dos modos. Este smoke cubre el de subir un MP4.
  assert.equal(await page.locator('#mode-chooser').isVisible(), true);
  assert.equal(await page.locator('#panel-upload').isVisible(), false, 'el panel no se muestra hasta elegir modo');
  await page.locator('#mode-upload').click();
  await page.waitForFunction(() => !document.getElementById('panel-upload').hidden);
  assert.equal(await page.locator('#mode-chooser').isVisible(), false);
  step('Elección de modo', 'editar un video existente');

  // Estado inicial: todo bloqueado.
  assert.equal(await page.locator('#btn-analyze').isDisabled(), true);
  assert.equal(await page.locator('#btn-export').isDisabled(), true);
  assert.equal(await page.locator('#state-pill').textContent(), 'Listo');
  step('Estado inicial', 'analizar y exportar deshabilitados');

  // 1. Subir el MP4.
  await page.locator('#file').setInputFiles(fixture);
  await page.waitForFunction(() => !document.getElementById('btn-analyze').disabled);
  assert.match(await page.locator('#file-facts').textContent(), /editor-source\.mp4/);
  step('Archivo seleccionado', 'botón de análisis habilitado');

  // 2. Analizar, con polling real.
  await page.locator('#btn-analyze').click();
  await page.waitForFunction(() => document.getElementById('state-pill').textContent === 'Análisis completado', null, { timeout: 120000 });
  const facts = await page.locator('#file-facts').textContent();
  assert.match(facts, /30\.000 \(nominal 30\.000, CFR\)/);
  assert.match(facts, /320 × 180/);
  assert.match(facts, /h264/);
  assert.match(facts, /1 pista · aac/);
  const tempo = await page.locator('#tempo-summary').textContent();
  assert.match(tempo, /\d+\.\d+ BPM/);
  step('Análisis completado', tempo.slice(0, 60));

  // La timeline se dibujó con cortes y ritmo.
  assert.ok(await page.locator('.corte').count() >= 1, 'se esperaba al menos un corte en la timeline');
  assert.ok(await page.locator('.beat').count() >= 2, 'se esperaban beats en la timeline');
  step('Timeline', `${await page.locator('.corte').count()} cortes, ${await page.locator('.beat').count()} beats`);

  // El reproductor del original decodifica la previsualización.
  await page.waitForFunction(() => document.getElementById('source-player').readyState >= 2, null, { timeout: 30000 });
  step('Reproductor del original', 'previsualización decodificada');

  // Exportar sigue bloqueado: no hay propuesta.
  assert.equal(await page.locator('#btn-export').isDisabled(), true);
  assert.match(await page.locator('#export-blocked').textContent(), /crea una propuesta/);

  // 3. Crear propuesta en 9:16.
  await page.selectOption('#format', '9:16');
  await page.locator('#btn-propose').click();
  await page.waitForFunction(() => document.getElementById('state-pill').textContent === 'Aprobación pendiente', null, { timeout: 60000 });
  assert.match(await page.locator('#resumen').textContent(), /9:16/);
  assert.match(await page.locator('#resumen').textContent(), /1080×1920/);
  assert.match(await page.locator('#proposal-summary').textContent(), /Pendiente de tu aprobación/);
  assert.ok(await page.locator('.segmento').count() >= 1, 'se esperaban segmentos en la timeline');
  step('Propuesta creada', await page.locator('#proposal-summary').textContent());

  // 4. Exportar debe seguir bloqueado hasta aprobar.
  assert.equal(await page.locator('#btn-export').isDisabled(), true);
  assert.match(await page.locator('#export-blocked').textContent(), /debe aprobarse antes de exportar/);
  step('Bloqueo de exportación', 'sin aprobación no se puede exportar');

  // Las advertencias de sincronía son visibles si el backend las envía.
  const warningsVisible = await page.locator('#warnings').isVisible();
  const warningsText = warningsVisible ? await page.locator('#warnings').textContent() : '';
  if (warningsText.includes('atempo')) step('Advertencia de atempo', 'visible en la interfaz');

  // 4bis. Panel de segmentos editable: cambiar velocidad obliga a reaprobar.
  assert.equal(await page.locator('#segments-card').isVisible(), true);
  const filas = await page.locator('.segmento-fila').count();
  assert.ok(filas >= 1, 'se esperaba al menos un trozo editable');
  assert.equal(await page.locator('#btn-apply-segments').isDisabled(), true, 'sin cambios no hay nada que aplicar');
  // Sin tocar nada, el panel no debe acusar al usuario de haber vaciado el montaje.
  const notaInicial = await page.locator('#segments-note').textContent();
  assert.ok(!notaInicial.includes('al menos un trozo'), `nota inicial engañosa: ${notaInicial}`);
  assert.equal(await page.locator('#btn-reset-segments').isDisabled(), true, 'sin cambios no hay nada que deshacer');
  await page.locator('.segmento-velocidad').first().fill('1.25');
  await page.locator('.segmento-velocidad').first().dispatchEvent('input');
  await page.waitForFunction(() => !document.getElementById('btn-apply-segments').disabled);
  // Una velocidad imposible se avisa en la interfaz y bloquea el guardado.
  await page.locator('.segmento-velocidad').first().fill('9');
  await page.locator('.segmento-velocidad').first().dispatchEvent('input');
  await page.waitForFunction(() => document.getElementById('segments-note').textContent.includes('debe estar entre'));
  assert.equal(await page.locator('#btn-apply-segments').isDisabled(), true);
  await page.locator('.segmento-velocidad').first().fill('1.25');
  await page.locator('.segmento-velocidad').first().dispatchEvent('input');
  await page.waitForFunction(() => !document.getElementById('btn-apply-segments').disabled);
  await page.locator('#btn-apply-segments').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('Apruébalo de nuevo'));
  assert.equal(await page.locator('#btn-export').isDisabled(), true, 'editar debe invalidar la aprobación');
  step('Segmentos editables', `${filas} trozos; velocidad cambiada y aprobación invalidada`);

  // 5. Aprobar.
  await page.locator('#btn-approve').click();
  await page.waitForFunction(() => document.getElementById('state-pill').textContent === 'Aprobado', null, { timeout: 30000 });
  assert.equal(await page.locator('#btn-export').isDisabled(), false);
  assert.equal(await page.locator('.paso[data-paso="aprobacion"]').getAttribute('data-hecho'), 'si');
  step('Aprobación', 'exportación habilitada, paso marcado');

  // 6. Exportar (doble clic inmediato: no debe lanzar dos exportaciones).
  await page.locator('#btn-export').click();
  await page.waitForFunction(() => document.getElementById('state-pill').textContent === 'Exportando con FFmpeg');
  assert.equal(await page.locator('#btn-export').isDisabled(), true, 'el botón debe bloquearse durante la exportación');
  await page.waitForFunction(() => document.getElementById('state-pill').textContent === 'Exportado', null, { timeout: 300000 });
  const status = await page.locator('#status').textContent();
  assert.match(status, /1080×1920/);
  step('Exportación', status);

  // 7. Reproductor del exportado y descarga del MP4.
  await page.waitForFunction(() => document.getElementById('export-player').readyState >= 2, null, { timeout: 60000 });
  step('Reproductor del exportado', 'MP4 resultante decodificado en el navegador');

  const download = page.waitForEvent('download');
  await page.locator('.descarga-principal').click();
  const file = await download;
  const saved = path.join(dir, 'descargado.mp4');
  await file.saveAs(saved);
  const bytes = (await fs.stat(saved)).size;
  assert.ok(bytes > 1000, 'el MP4 descargado está vacío');
  step('Descarga del MP4', `${bytes} bytes`);

  // Descargas del análisis.
  for (const label of ['Datos del análisis (JSON)', 'Lista de cortes (CSV)']) {
    const d = page.waitForEvent('download');
    await page.locator('.descarga', { hasText: label }).click();
    await (await d).saveAs(path.join(dir, label.includes('JSON') ? 'analisis.json' : 'cortes.csv'));
  }
  step('Descargas del análisis', 'JSON y CSV');

  await page.screenshot({ path: path.join(dir, 'editor.png'), fullPage: true });

  assert.equal(await hash(fixture), sourceHash, 'el original cambió');
  assert.deepEqual(errors, [], 'la página no debe producir errores');

  const result = {
    browser: await browser.version(), steps: steps.map(s => s.name),
    sourceUnchanged: true, sourceSHA256: sourceHash,
    exportStatus: status, downloadedBytes: bytes,
    pageErrors: errors, gemini: 'not called',
  };
  await fs.writeFile(path.join(dir, 'editor-smoke-result.json'), JSON.stringify(result, null, 2));
  console.log('\n' + JSON.stringify(result));
} finally {
  if (browser) await browser.close();
  await new Promise(r => server.close(r));
}
