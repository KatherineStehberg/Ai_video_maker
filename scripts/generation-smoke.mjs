/**
 * Smoke test del flujo de generación con IA, desde el navegador:
 *   prompt -> generación (mock) -> análisis -> edición -> aprobación -> MP4
 *
 * Requiere Node 20+ y playwright-core en .tmp/browser-tools (ver README).
 * Usa el proveedor mock: no gasta créditos ni contacta ningún servicio externo.
 */
import { chromium } from '../.tmp/browser-tools/node_modules/playwright-core/index.mjs';
import { createServer } from '../src/server.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = '';        // nunca una llamada de pago desde un smoke
process.env.VIDEO_GEN_PROVIDER = 'mock';

const dir = path.resolve('.tmp/generation-smoke');
await fs.mkdir(dir, { recursive: true });

const PROMPT = 'Video vertical promocional sobre clases de inglés online para adultos, tono cercano y profesional.';

const server = createServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
const steps = [];
const step = (name, detail) => { steps.push(name); console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); };

try {
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });

  await page.goto(`${base}/editor.html`);
  await page.waitForFunction(() => document.getElementById('gen-provider-hint').textContent.includes('mock'));
  step('Carga de la página', 'proveedor mock anunciado como video de prueba');

  // 1. Elegir el modo de generación.
  await page.locator('#mode-prompt').click();
  await page.waitForFunction(() => !document.getElementById('panel-prompt').hidden);
  assert.equal(await page.locator('#panel-upload').isVisible(), false);
  assert.ok(await page.locator('#gen-style option').count() >= 1, 'los estilos deben venir del backend');
  step('Modo elegido', 'crear video con un prompt');

  // 2. Un prompt vacío no lanza nada.
  await page.locator('#btn-generate').click();
  await page.waitForFunction(() => !document.getElementById('error').hidden);
  assert.match(await page.locator('#error').textContent(), /Escribe un prompt/);
  step('Validación', 'prompt vacío rechazado en la interfaz');

  // 3. Rellenar el formulario y generar.
  await page.locator('#prompt').fill(PROMPT);
  await page.selectOption('#gen-duration', '8');
  await page.selectOption('#gen-format', '9:16');
  // Los campos opcionales viven tras un desplegable: hay que abrirlo.
  await page.locator('#panel-prompt summary', { hasText: 'Detalles opcionales' }).click();
  await page.locator('#gen-platform').fill('TikTok');
  await page.locator('#btn-generate').click();

  await page.waitForFunction(() => document.getElementById('state-pill').textContent === 'Generando video', null, { timeout: 30000 });
  step('Generación en curso', 'estado visible durante el proceso');

  // 4. El encadenado termina con la propuesta lista y pendiente de aprobación.
  await page.waitForFunction(() => document.getElementById('state-pill').textContent === 'Aprobación pendiente', null, { timeout: 300000 });
  assert.match(await page.locator('#prompt-used').textContent(), /clases de inglés online/);
  assert.match(await page.locator('#prompt-specs').textContent(), /TikTok/);
  assert.match(await page.locator('#gen-provider-badge').textContent(), /mock|prueba/i);
  step('Generación completada', 'prompt y parámetros visibles junto al resultado');

  // El aviso de que es material de prueba tiene que estar a la vista.
  assert.equal(await page.locator('#warnings').isVisible(), true);
  assert.match(await page.locator('#warnings').textContent(), /MOCK|prueba/i);
  step('Advertencia de mock', 'la interfaz no lo presenta como IA real');

  // 5. El análisis encadenado pobló resumen y timeline.
  assert.match(await page.locator('#resumen').textContent(), /Cortes detectados/);
  assert.ok(await page.locator('.corte').count() >= 1, 'se esperaban cortes en la timeline');
  assert.ok(await page.locator('.segmento').count() >= 1, 'se esperaban segmentos propuestos');
  await page.waitForFunction(() => document.getElementById('source-player').readyState >= 2, null, { timeout: 60000 });
  step('Análisis y montaje', `${await page.locator('.corte').count()} cortes, ${await page.locator('.segmento').count()} trozos`);

  // 6. Editar un segmento: debe seguir exigiendo aprobación.
  assert.equal(await page.locator('#segments-card').isVisible(), true);
  await page.locator('.segmento-velocidad').first().fill('1.15');
  await page.locator('.segmento-velocidad').first().dispatchEvent('input');
  await page.waitForFunction(() => !document.getElementById('btn-apply-segments').disabled);
  await page.locator('#btn-apply-segments').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('Apruébalo de nuevo'));
  step('Edición de segmentos', 'velocidad ajustada sobre el video generado');

  // 7. Exportar sigue bloqueado hasta aprobar.
  assert.equal(await page.locator('#btn-export').isDisabled(), true);
  assert.match(await page.locator('#export-blocked').textContent(), /aprobarse antes de exportar/);
  step('Bloqueo de exportación', 'la aprobación humana sigue siendo obligatoria');

  // 8. Aprobar y exportar.
  await page.locator('#btn-approve').click();
  await page.waitForFunction(() => document.getElementById('state-pill').textContent === 'Aprobado', null, { timeout: 30000 });
  await page.locator('#btn-export').click();
  await page.waitForFunction(() => document.getElementById('state-pill').textContent === 'Exportado', null, { timeout: 300000 });
  const status = await page.locator('#status').textContent();
  assert.match(status, /1080×1920/);
  step('Exportación', status.trim());

  // 9. Reproducir y descargar el MP4 final.
  await page.waitForFunction(() => document.getElementById('export-player').readyState >= 2, null, { timeout: 60000 });
  const download = page.waitForEvent('download');
  await page.locator('.descarga-principal').click();
  const saved = path.join(dir, 'video-generado.mp4');
  await (await download).saveAs(saved);
  const bytes = (await fs.stat(saved)).size;
  assert.ok(bytes > 1000, 'el MP4 descargado está vacío');
  step('Descarga del MP4', `${bytes} bytes`);

  await page.screenshot({ path: path.join(dir, 'generacion.png'), fullPage: true });
  assert.deepEqual(errors, [], 'la página no debe producir errores');

  const result = { browser: await browser.version(), prompt: PROMPT, steps, exportStatus: status.trim(),
    downloadedBytes: bytes, pageErrors: errors, provider: 'mock', gemini: 'not called' };
  await fs.writeFile(path.join(dir, 'generation-smoke-result.json'), JSON.stringify(result, null, 2));
  console.log('\n' + JSON.stringify(result));
} finally {
  if (browser) await browser.close();
  await new Promise(r => server.close(r));
}
