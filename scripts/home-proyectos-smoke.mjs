/**
 * SMOKE DEL INICIO: proyectos reconocibles de un vistazo.
 *
 * Comprueba lo que no se ve desde el backend: que las miniaturas CARGUEN en el
 * navegador (una ruta bien formada que devuelve 404 se ve igual de vacía que no
 * poner nada), que cada tarjeta lleve su nombre y que se pueda abrir el editor
 * desde ahí.
 */
import { chromium } from '../.tmp/browser-tools/node_modules/playwright-core/index.mjs';
import { createServer } from '../src/server.js';
import assert from 'node:assert/strict';

process.env.LLM_PROVIDER = 'none';

const server = createServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let browser;
const paso = (t, d) => console.log(`  ✓ ${t}${d ? ' — ' + d : ''}`);

try {
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const errores = [];
  const fallos404 = [];
  page.on('pageerror', e => errores.push(e.message));
  page.on('response', (r) => { if (r.status() >= 400) fallos404.push(`HTTP ${r.status()} ${r.url().slice(0, 90)}`); });

  await page.goto(`${base}/editor.html`);
  await page.waitForSelector('#proyectos-lista .proyecto', { timeout: 20000 });

  const tarjetas = await page.locator('#proyectos-lista .proyecto').count();
  assert.ok(tarjetas > 0, 'el inicio no listó ningún proyecto');
  paso('el inicio lista proyectos', `${tarjetas} tarjetas`);

  // Todas las tarjetas tienen que tener nombre visible.
  const sinNombre = await page.evaluate(() => [...document.querySelectorAll('#proyectos-lista .proyecto')]
    .filter(t => !t.querySelector('.proyecto-titulo')?.textContent.trim()).length);
  assert.equal(sinNombre, 0, `${sinNombre} tarjetas sin nombre`);
  paso('todas las tarjetas llevan su nombre');

  // Las miniaturas tienen que haber CARGADO de verdad, no solo existir el
  // <img>: una ruta mal formada deja la tarjeta igual de vacía.
  //
  // Solo se miran las que están EN PANTALLA: las tarjetas llevan
  // `loading="lazy"`, así que las de más abajo aún no se han pedido, y darlas
  // por rotas sería culpar a la imagen de una optimización que funciona.
  await page.waitForTimeout(1500);
  const visibles = await page.evaluate(() => [...document.querySelectorAll('#proyectos-lista .proyecto-mini img')]
    .filter((i) => { const r = i.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; })
    .map(i => ({ ok: i.complete && i.naturalWidth > 0, src: i.getAttribute('src') })));
  assert.ok(visibles.length > 0, 'ninguna tarjeta visible trae miniatura');
  const rotas = visibles.filter(i => !i.ok);
  assert.deepEqual(rotas, [], `miniaturas que no cargan: ${rotas.map(r => r.src).join(' ')}`);
  paso('las miniaturas en pantalla cargan de verdad', `${visibles.length} imágenes, 0 rotas`);

  // Y al bajar, las de abajo también cargan.
  await page.evaluate(() => document.getElementById('proyectos-lista').scrollIntoView({ block: 'end' }));
  await page.waitForTimeout(1500);
  const trasBajar = await page.evaluate(() => [...document.querySelectorAll('#proyectos-lista .proyecto-mini img')]
    .filter((i) => { const r = i.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; })
    .filter(i => !(i.complete && i.naturalWidth > 0)).map(i => i.getAttribute('src')));
  assert.deepEqual(trasBajar, [], `al bajar quedan miniaturas rotas: ${trasBajar.join(' ')}`);
  paso('al bajar por la lista también cargan');

  // El recuento dice cuántos hay y cuántos intentos quedaron sin proyecto.
  const total = await page.locator('#proyectos-total').textContent();
  assert.match(total, /guardados/, `el recuento no se ve: «${total}»`);
  paso('el recuento no esconde nada', total.trim());

  // Y desde la tarjeta se llega al editor de ESE proyecto.
  const href = await page.locator('#proyectos-lista .proyecto a.btn-principal').first().getAttribute('href');
  assert.match(href, /project-editor\.html\?id=vid_/, `enlace inesperado: ${href}`);
  paso('cada tarjeta abre su propio proyecto', href);

  assert.deepEqual(errores, [], `errores de página: ${errores.join(' | ')}`);
  assert.deepEqual(fallos404, [], `peticiones fallidas: ${fallos404.join(' | ')}`);
  console.log('\nSMOKE DEL INICIO: OK');
} finally {
  await browser?.close();
  server.close();
}
