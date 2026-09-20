/**
 * Smoke de diseño: comprueba que la interfaz no desborda ni falla en
 * 1366x768, 1920x1080 y 390 px, y que se puede navegar con teclado.
 */
import { chromium } from '../.tmp/browser-tools/node_modules/playwright-core/index.mjs';
import path from 'node:path';
import fs from 'node:fs/promises';

const dir = path.resolve('.tmp/vista-estudio');
await fs.mkdir(dir, { recursive: true });
import { createServer } from '../src/server.js';
import assert from 'node:assert/strict';
const server = createServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/editor.html`;
const exe = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const b = await chromium.launch({ executablePath: exe, headless: true });

const errores = [];
const informe = [];

async function medir(page, etiqueta) {
  const m = await page.evaluate(() => ({
    scrollH: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    ancho: document.documentElement.scrollWidth,
    cliente: document.documentElement.clientWidth,
    // Elementos que se salen del viewport por la derecha
    desbordan: [...document.querySelectorAll('body *')]
      .filter(n => n.getBoundingClientRect().right > document.documentElement.clientWidth + 2)
      .slice(0, 5).map(n => n.tagName + (n.id ? '#' + n.id : '.' + String(n.className).split(' ')[0])),
  }));
  informe.push({ etiqueta, ...m });
  return m;
}

for (const [w, h, nombre] of [[1366, 768, '1366'], [1920, 1080, '1920'], [390, 844, '390']]) {
  const page = await b.newPage({ viewport: { width: w, height: h } });
  page.on('pageerror', e => errores.push(`${nombre}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errores.push(`${nombre} consola: ${m.text()}`); });
  page.on('response', r => { if (r.status() >= 400) errores.push(`${nombre}: HTTP ${r.status()} ${r.url()}`); });

  await page.goto(BASE);
  await page.waitForFunction(() => document.getElementById('gen-provider-hint').textContent.length > 10, null, { timeout: 30000 });
  await medir(page, `${nombre} inicio`);
  await page.screenshot({ path: path.join(dir, `${nombre}-inicio.png`), fullPage: false });

  // Pantalla de creación
  await page.locator('#ir-crear').click();
  await page.waitForFunction(() => !document.querySelector('[data-pantalla="crear"]').hidden);
  await medir(page, `${nombre} crear`);
  await page.screenshot({ path: path.join(dir, `${nombre}-crear.png`), fullPage: false });

  // Una sección "Próximamente"
  await page.locator('.nav-item[data-seccion="plantillas"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-pantalla="proximamente"]').hidden);
  await medir(page, `${nombre} proximamente`);
  if (nombre === '1366') await page.screenshot({ path: path.join(dir, 'proximamente.png') });

  await page.close();
}

// La navegación debe funcionar con teclado, no sólo con ratón.
const page = await b.newPage({ viewport: { width: 1366, height: 768 } });
await page.goto(BASE);
await page.waitForFunction(() => document.getElementById('gen-provider-hint').textContent.length > 10);
await page.keyboard.press('Tab');
const foco = await page.evaluate(() => document.activeElement?.className || document.activeElement?.tagName);
const navegables = await page.evaluate(() =>
  [...document.querySelectorAll('button, a[href], select, input, textarea')].filter(n => !n.disabled && n.offsetParent !== null).length);
await page.close();
await b.close();
await new Promise(r => server.close(r));

// Comprobaciones duras: si fallan, el diseño está roto.
for (const m of informe) {
  assert.equal(m.scrollH, false, `${m.etiqueta}: hay scroll horizontal (${m.ancho} > ${m.cliente})`);
}
assert.deepEqual(errores, [], 'la interfaz no debe producir errores');
assert.ok(navegables > 8, `se esperaban controles alcanzables por teclado, hubo ${navegables}`);

console.log(JSON.stringify({ informe, errores, foco, navegables }, null, 1));
