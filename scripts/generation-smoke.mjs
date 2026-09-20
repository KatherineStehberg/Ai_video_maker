/**
 * Smoke test del flujo de generación con IA, desde el navegador:
 *   prompt -> guion -> escenas -> voz -> subtitulos -> MP4 -> analisis ->
 *   edicion -> aprobacion -> exportacion
 *
 * Requiere Node 20+ y playwright-core en .tmp/browser-tools (ver README).
 * Usa el proveedor `pipeline`: montaje local real, sin creditos ni red.
 */
import { chromium } from '../.tmp/browser-tools/node_modules/playwright-core/index.mjs';
import { createServer } from '../src/server.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = '';        // nunca una llamada de pago desde un smoke
process.env.VIDEO_GEN_PROVIDER = 'pipeline';   // montaje local real, no el mock

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
  await page.waitForFunction(() => document.getElementById('gen-provider-hint').textContent.length > 20);
  step('Carga de la página', await page.locator('#gen-provider-hint').textContent());

  // 1. Elegir el modo de generación.
  await page.locator('#ir-crear').click();
  await page.waitForFunction(() => !document.querySelector('[data-pantalla="crear"]').hidden);
  assert.ok(await page.locator('#gen-style option').count() >= 1, 'los estilos deben venir del backend');
  assert.ok(await page.locator('#gen-duration option').count() >= 5, 'debe ofrecer varias duraciones');
  assert.equal(await page.locator('.paso').count(), 7, 'el flujo tiene 7 pasos');
  step('Modo elegido', 'crear video con un prompt');

  // 2. Un prompt vacío no lanza nada. «Crear video» además nace bloqueado:
  // no se puede producir sin haber revisado antes un borrador.
  assert.equal(await page.locator('#btn-generate').isDisabled(), true);
  await page.locator('#btn-draft').click();
  await page.waitForFunction(() => !document.getElementById('error').hidden);
  assert.match(await page.locator('#error').textContent(), /Escribe primero/);
  step('Validación', 'prompt vacío rechazado en la interfaz');

  // 3. Rellenar el formulario y pedir el BORRADOR (sin producir nada).
  await page.locator('#prompt').fill(PROMPT);
  await page.selectOption('#gen-duration', '15');
  await page.selectOption('#gen-format', '9:16');
  await page.selectOption('#gen-platform', 'TikTok');

  assert.equal(await page.locator('#btn-generate').isDisabled(), true, 'sin borrador no se puede crear el video');
  await page.locator('#btn-draft').click();
  await page.waitForFunction(() => !document.querySelector('[data-paso-panel="guion"]').hidden, null, { timeout: 60000 });
  const escenas = await page.locator('.escena').count();
  assert.ok(escenas >= 3, `se esperaban varias escenas, hubo ${escenas}`);
  // El guion tiene que hablar del tema del prompt, no ser texto de relleno.
  const narraciones = await page.$$eval('.escena-text', nodos => nodos.map(n => n.value));
  assert.ok(narraciones.some(t => /ingl[eé]s/i.test(t)), `el guion no menciona el tema: ${JSON.stringify(narraciones)}`);
  assert.match(await page.locator('#draft-cost').textContent(), /Sin coste|créditos/);
  step('Borrador de guion', `${escenas} escenas · ${await page.locator('#draft-source').textContent()}`);

  // 4. Editar una escena y regenerar otra (paso «Escenas»).
  await page.locator('.paso[data-paso="escenas"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-paso-panel="escenas"]').hidden);
  await page.locator('.escena-titulo').first().fill('Aprende inglés online');
  await page.locator('.escena-text').first().fill('Aprende inglés online a tu ritmo, con clases pensadas para adultos.');
  await page.locator('.escena').nth(1).locator('button', { hasText: 'Regenerar' }).first().click();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('regenerada'), null, { timeout: 60000 });
  // Duplicar y excluir: el montaje cambia sin perder escenas.
  const antes = await page.locator('.escena').count();
  await page.locator('.escena').first().locator('button', { hasText: 'Duplicar' }).click();
  await page.waitForFunction(n => document.querySelectorAll('.escena').length === n + 1, antes);
  await page.locator('.escena').nth(1).locator('button', { hasText: 'Excluir' }).click();
  await page.waitForFunction(() => document.querySelector('.escena[data-incluida="no"]') !== null);
  assert.equal(await page.locator('.escena').count(), antes + 1, 'excluir no debe borrar la escena');
  step('Edición del guion', `escena editada, regenerada, duplicada y una excluida (${antes} → ${antes + 1})`);

  // 5. Producir el video real (paso «Voz y recursos»).
  await page.locator('.paso[data-paso="voz"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-paso-panel="voz"]').hidden);
  assert.equal(await page.locator('#btn-generate').isDisabled(), false);
  await page.locator('#btn-generate').click();

  await page.waitForFunction(() => document.getElementById('estado-pill').textContent === 'Generando video', null, { timeout: 30000 });
  step('Generación en curso', 'estado visible durante el proceso');

  // 6. El encadenado termina con la propuesta lista y pendiente de aprobación.
  await page.waitForFunction(() => document.getElementById('estado-pill').textContent === 'Aprobación pendiente', null, { timeout: 900000 });
  assert.match(await page.locator('#titulo-proyecto').textContent(), /ingl[eé]s/i);
  step('Generación completada', await page.locator('#titulo-proyecto').textContent());

  // La procedencia de cada pieza tiene que estar a la vista.
  assert.equal(await page.locator('#warnings').isVisible(), true);
  const avisos = await page.locator('#warnings').textContent();
  assert.match(avisos, /Guion:/);
  assert.match(avisos, /Visuales:/);
  assert.ok(!/MOCK/i.test(avisos), 'el pipeline real no debe anunciarse como mock');
  step('Procedencia declarada', avisos.replace(/\s+/g, ' ').slice(0, 90));

  // 5. El análisis encadenado pobló resumen y timeline.
  assert.match(await page.locator('#export-resumen').textContent(), /Cortes detectados/);
  // Los cortes pueden ser 0 legítimamente: entre fotos con fundido no hay
  // cambio brusco que detectar. Lo que sí debe existir es el montaje.
  const cortes = await page.locator('.corte').count();
  assert.ok(await page.locator('.bloque').count() >= 1, 'se esperaban segmentos propuestos');
  assert.ok(await page.locator('.pista').count() >= 3, 'la timeline debe tener sus pistas');
  await page.waitForFunction(() => document.getElementById('source-player').readyState >= 2, null, { timeout: 60000 });
  step('Análisis y montaje', `${cortes} cortes, ${await page.locator('.bloque').count()} trozos`);

  // 6. Editar un segmento en el paso «Editar».
  await page.locator('.paso[data-paso="editor"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-paso-panel="editor"]').hidden);

  await page.locator('.segmento-velocidad').first().fill('1.15');
  await page.locator('.segmento-velocidad').first().dispatchEvent('input');
  await page.waitForFunction(() => !document.getElementById('btn-apply-segments').disabled);
  await page.locator('#btn-apply-segments').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('Apruébalo de nuevo'));
  step('Edición de segmentos', 'velocidad ajustada sobre el video generado');

  // 7. Exportar sigue bloqueado hasta aprobar.
  await page.locator('.paso[data-paso="exportar"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-paso-panel="exportar"]').hidden);
  assert.equal(await page.locator('#btn-export').isDisabled(), true);
  assert.match(await page.locator('#export-blocked').textContent(), /aprobarse antes de exportar/);
  step('Bloqueo de exportación', 'la aprobación humana sigue siendo obligatoria');

  // 8. Aprobar y exportar.
  await page.locator('#btn-approve').click();
  await page.waitForFunction(() => document.getElementById('estado-pill').textContent === 'Aprobado', null, { timeout: 30000 });
  await page.locator('#btn-export').click();
  await page.waitForFunction(() => document.getElementById('estado-pill').textContent === 'Exportado', null, { timeout: 300000 });
  const status = await page.locator('#status').textContent();
  assert.match(status, /1080×1920/);
  step('Exportación', status.trim());

  // 9. Reproducir y descargar el MP4 final.
  await page.waitForFunction(() => document.getElementById('export-player').readyState >= 2, null, { timeout: 60000 });
  const download = page.waitForEvent('download');
  await page.locator('#downloads a.btn-accion').click();
  const saved = path.join(dir, 'video-generado.mp4');
  await (await download).saveAs(saved);
  const bytes = (await fs.stat(saved)).size;
  assert.ok(bytes > 1000, 'el MP4 descargado está vacío');
  step('Descarga del MP4', `${bytes} bytes`);

  await page.screenshot({ path: path.join(dir, 'generacion.png'), fullPage: true });
  assert.deepEqual(errors, [], 'la página no debe producir errores');

  const result = { browser: await browser.version(), prompt: PROMPT, steps, exportStatus: status.trim(),
    downloadedBytes: bytes, pageErrors: errors, provider: process.env.VIDEO_GEN_PROVIDER, gemini: 'not called' };
  await fs.writeFile(path.join(dir, 'generation-smoke-result.json'), JSON.stringify(result, null, 2));
  console.log('\n' + JSON.stringify(result));
} finally {
  if (browser) await browser.close();
  await new Promise(r => server.close(r));
}
