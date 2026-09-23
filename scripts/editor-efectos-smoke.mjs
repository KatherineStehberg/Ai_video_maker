/**
 * SMOKE DE LA BIBLIOTECA DE EFECTOS DE SONIDO.
 *
 * Lo que comprueba no es que el botón exista, sino que el efecto elegido
 * SOBREVIVA AL GUARDADO Y A LA RECARGA, que es donde se cae una función que
 * «funciona» solo en pantalla.
 *
 *   abrir Audio -> pestaña Efectos -> biblioteca -> Usar -> Guardar ->
 *   recargar -> el efecto sigue ahí, con su escena, su volumen y su licencia
 */
import { chromium } from '../.tmp/browser-tools/node_modules/playwright-core/index.mjs';
import { createServer } from '../src/server.js';
import { createStudio } from '../src/studio/service.js';
import { deleteProject, loadProject } from '../src/core/project.js';
import assert from 'node:assert/strict';

process.env.LLM_PROVIDER = 'none';

const GUION = [
  '# Primera escena',
  '',
  'Una escena con texto suficiente para que el proyecto tenga cuerpo.',
  '',
  '# Segunda escena',
  '',
  'Otra escena distinta, para poder anclar el efecto a una en concreto.',
].join('\n');

const server = createServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let browser;
let proyecto = null;
const paso = (t, d) => console.log(`  ✓ ${t}${d ? ' — ' + d : ''}`);

try {
  proyecto = createStudio({ title: 'Smoke de efectos', script: GUION, aspectRatio: '16:9', template: 'video-explicativo' });
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const errores = [];
  page.on('pageerror', e => errores.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errores.push(`console: ${m.text()}`); });

  await page.goto(`${base}/project-editor.html?id=${proyecto.id}`);
  await page.waitForSelector('#panel-cuerpo .bloque');

  // ---- 1. El panel de Audio tiene sus pestañas ----
  await page.click('.herr[data-herr="audio"]');
  await page.waitForSelector('.pestanas .pestana');
  const pestanas = await page.locator('.pestanas .pestana').allTextContents();
  for (const esperada of ['Narración', 'Música', 'Efectos']) {
    assert.ok(pestanas.some(t => t.startsWith(esperada)), `falta la pestaña ${esperada}: ${pestanas.join(' | ')}`);
  }
  paso('el panel de Audio separa las fuentes', pestanas.join(' · '));

  // ---- 2. La biblioteca solo ofrece efectos con licencia ----
  await page.click('.pestana:has-text("Efectos")');
  await page.click('button:has-text("Agregar efecto")');
  await page.waitForSelector('.biblio-musica .musica-tarjeta');
  const tarjetas = await page.locator('.biblio-musica .musica-tarjeta').count();
  assert.ok(tarjetas >= 6, `se esperaban los 6 efectos locales y hay ${tarjetas}`);

  const sinLicencia = await page.evaluate(() => [...document.querySelectorAll('.biblio-musica .musica-tarjeta')]
    .filter(t => !/CC0|licencia|dominio público/i.test(t.textContent)).length);
  assert.equal(sinLicencia, 0, `${sinLicencia} efectos se ofrecen sin declarar licencia`);
  paso('la biblioteca lista efectos y todos declaran licencia', `${tarjetas} efectos`);

  // ---- 3. Elegir uno lo deja pendiente de guardar ----
  const titulo = await page.locator('.biblio-musica .musica-tarjeta strong').first().textContent();
  await page.locator('.biblio-musica .musica-tarjeta button:has-text("Usar")').first().click();
  await page.waitForSelector('.fx-item');
  const estado = await page.locator('#estado-guardado').textContent();
  assert.match(estado, /sin guardar/i, `debería avisar de cambios sin guardar: «${estado}»`);
  paso('al elegir un efecto queda pendiente de guardar', `«${titulo.trim()}»`);

  // ---- 4. Guardar y recargar: tiene que seguir ahí ----
  await page.click('#guardar');
  await page.waitForFunction(() => /guardado/i.test(document.getElementById('estado-guardado').textContent));

  const enDisco = loadProject(proyecto.id).sfx;
  assert.equal(enDisco.length, 1, `el efecto no llegó al proyecto en disco: ${JSON.stringify(enDisco)}`);
  assert.ok(enDisco[0].path.includes('assets/sfx'), `ruta inesperada: ${enDisco[0].path}`);
  assert.ok(enDisco[0].credit?.licencia, 'el efecto se guardó sin licencia');
  assert.ok(enDisco[0].sceneId, 'el efecto se guardó sin escena a la que anclarse');
  paso('el efecto llega al archivo del proyecto', `${enDisco[0].credit.licencia}`);

  await page.reload();
  await page.waitForSelector('#panel-cuerpo .bloque');
  await page.click('.herr[data-herr="audio"]');
  await page.click('.pestana:has-text("Efectos")');
  await page.waitForSelector('.fx-item');
  const tras = await page.locator('.fx-item strong').first().textContent();
  assert.equal(tras.trim(), titulo.trim(), `tras recargar aparece otro efecto: «${tras}»`);
  paso('sobrevive a la recarga', `«${tras.trim()}»`);

  // ---- 5. Y el backend cuenta con él para la mezcla ----
  const aviso = await page.locator('#panel-cuerpo .mini').first().textContent();
  assert.match(aviso, /pista/i, `no se informa de las pistas que sonarán: «${aviso}»`);
  paso('el panel dice cuántas pistas sonarán', aviso.trim());

  // ---- 6. El efecto aparece en la línea de tiempo, en su sitio ----
  const pistaFx = await page.locator('.tl-pista[data-pista="efectos"] .tl-clip').count();
  assert.ok(pistaFx >= 1, 'el efecto no aparece en la línea de tiempo');
  const tituloFx = await page.locator('.tl-pista[data-pista="efectos"] .tl-clip').first().getAttribute('title');
  assert.match(tituloFx, /CC0|licencia/i, `el bloque no declara la licencia: «${tituloFx}»`);
  paso('el efecto sale en la línea de tiempo con su licencia', tituloFx);

  // ---- 7. Una transición real se dibuja entre las dos escenas ----
  // La primera escena no admite transición de entrada: se elige la segunda.
  await page.locator('.herr[data-herr="escenas"]').click();
  await page.locator('.escena-item').nth(1).click();
  await page.locator('.herr[data-herr="transiciones"]').click();
  await page.waitForSelector('#panel-cuerpo select');
  await page.selectOption('#panel-cuerpo select', 'slideleft');
  await page.waitForSelector('.tl-pista[data-pista="cortes"] .tl-clip[data-transicion]');

  const tituloTr = await page.locator('.tl-pista[data-pista="cortes"] .tl-clip[data-transicion]')
    .first().getAttribute('title');
  assert.match(tituloTr, /Deslizar/, `el bloque no dice qué transición es: «${tituloTr}»`);
  assert.match(tituloTr, /s ·|[0-9]\.[0-9]{2} s/, `el bloque no dice cuánto dura: «${tituloTr}»`);
  paso('la transición se ve en la línea de tiempo', tituloTr);

  assert.deepEqual(errores, [], `errores de página: ${errores.join(' | ')}`);
  console.log('\nSMOKE DE EFECTOS: OK');
} finally {
  await browser?.close();
  if (proyecto) deleteProject(proyecto.id);
  server.close();
}
