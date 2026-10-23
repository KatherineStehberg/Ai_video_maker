/**
 * SMOKE DEL FOCO AL ESCRIBIR EN EL PANEL.
 *
 * El panel se repinta entero en cada pulsacion (es lo que mantiene el estado y
 * la vista previa sincronizados). Si al repintar no se devuelve el foco, el
 * campo desaparece a mitad de palabra: se escribe una letra y el teclado se
 * queda sin campo, la vista salta y hay que volver a pinchar.
 *
 * Esto se comprueba TECLEANDO DE VERDAD en un navegador: escribir el valor por
 * JavaScript no reproduce el problema, porque no hay foco que perder.
 */
import { chromium } from '../.tmp/browser-tools/node_modules/playwright-core/index.mjs';
import { createServer } from '../src/server.js';
import { createStudio } from '../src/studio/service.js';
import { deleteProject } from '../src/core/project.js';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = '';
process.env.LLM_PROVIDER = 'none';

const GUION = [
  '# Primera escena',
  '',
  'Una escena con texto suficiente para que el panel tenga contenido real.',
  '',
  '# Segunda escena',
  '',
  'Otra escena distinta para poder cambiar de seleccion durante la prueba.',
].join('\n');

const server = createServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let browser;
let proyecto = null;
const paso = (t, d) => console.log(`  ✓ ${t}${d ? ' — ' + d : ''}`);

try {
  proyecto = createStudio({ title: 'Smoke de foco', script: GUION, aspectRatio: '16:9', template: 'video-explicativo' });
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const errores = [];
  page.on('pageerror', e => errores.push(e.message));

  await page.goto(`${base}/project-editor.html?id=${proyecto.id}`);
  await page.waitForSelector('#panel-cuerpo .bloque');

  // ---- 1. «Qué imagen buscar»: se teclea letra a letra ----
  const campo = page.locator('#panel-cuerpo input[maxlength="300"]').first();
  await campo.click();
  // El campo ya trae lo que buscó el guion: se escribe al final, no donde
  // cayera el clic.
  await page.keyboard.press('End');
  // Lo que se mide es DONDE SE VE el campo, no el scrollTop: el panel puede
  // encoger por encima del campo y el navegador compensa, y eso no mueve nada
  // de lo que la usuaria ve.
  const donde = () => page.evaluate(() => Math.round(document.activeElement.getBoundingClientRect().top));
  const sitioAntes = await donde();

  const texto = 'atardecer sereno';
  for (const letra of texto) {
    await page.keyboard.type(letra);
    // Tras CADA letra el campo tiene que seguir siendo el elemento enfocado.
    const enfocado = await page.evaluate(() => {
      const a = document.activeElement;
      return { tag: a?.tagName, max: a?.getAttribute('maxlength'), valor: a?.value, cursor: a?.selectionStart };
    });
    assert.equal(enfocado.tag, 'INPUT', `tras escribir «${letra}» el foco se fue a ${enfocado.tag}`);
    assert.equal(enfocado.max, '300', 'el foco saltó a otro campo del panel');
  }

  const fin = await page.evaluate(() => ({ valor: document.activeElement.value, cursor: document.activeElement.selectionStart }));
  assert.equal(fin.valor.endsWith(texto), true, `se perdieron letras: «${fin.valor}»`);
  assert.equal(fin.cursor, fin.valor.length, `el cursor no quedó al final: ${fin.cursor} de ${fin.valor.length}`);
  paso('se escribe la frase entera sin perder el foco ni el cursor', `«${fin.valor}»`);

  const sitioDespues = await donde();
  assert.ok(Math.abs(sitioDespues - sitioAntes) <= 2,
    `el campo se movió de sitio mientras se escribía: ${sitioAntes}px -> ${sitioDespues}px`);
  paso('el campo no se mueve de sitio al teclear', `y=${sitioDespues}px`);

  // ---- 2. La narración, que es un textarea, se comporta igual ----
  const narr = page.locator('#panel-cuerpo textarea').first();
  await narr.click();
  await page.evaluate(() => { const t = document.querySelector('#panel-cuerpo textarea'); t.setSelectionRange(0, 0); });
  await page.keyboard.type('Hola. ');
  const narrEstado = await page.evaluate(() => {
    const a = document.activeElement;
    return { tag: a?.tagName, valor: a?.value, cursor: a?.selectionStart };
  });
  assert.equal(narrEstado.tag, 'TEXTAREA', 'el foco se fue del área de narración');
  assert.equal(narrEstado.valor.startsWith('Hola. '), true, `se escribió mal: «${narrEstado.valor.slice(0, 20)}»`);
  assert.equal(narrEstado.cursor, 6, `el cursor no se quedó donde se escribía: ${narrEstado.cursor}`);
  paso('al escribir en medio del texto, el cursor se queda donde estaba');

  assert.deepEqual(errores, [], `errores en la página: ${errores.join(' | ')}`);
  console.log('\nSMOKE DE FOCO: OK');
} finally {
  await browser?.close();
  if (proyecto) deleteProject(proyecto.id);
  server.close();
}
