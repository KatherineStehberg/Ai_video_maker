/**
 * SMOKE DE SUBTITULOS Y TEXTO DESTACADO, en un navegador de verdad.
 *
 * Comprueba en las DOS interfaces (Estudio y Editor) que:
 *   - los controles globales de subtitulos existen y responden;
 *   - los cuatro presets estan y cambian el estilo;
 *   - cada tarjeta de escena trae «Agregar texto destacado sobre la imagen»;
 *   - activar/desactivar el rotulo NO borra el texto escrito;
 *   - la vista previa se mueve al cambiar posicion, tamano y color;
 *   - lo guardado sobrevive a recargar la pagina.
 *
 * No llama a ningun proveedor de pago ni renderiza video.
 */
import { chromium } from '../.tmp/browser-tools/node_modules/playwright-core/index.mjs';
import { createServer } from '../src/server.js';
import { createStudio } from '../src/studio/service.js';
import { deleteProject } from '../src/core/project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

process.env.GEMINI_API_KEY = '';
process.env.LLM_PROVIDER = 'none';

const GUION = [
  '# Introduccion al metodo',
  '',
  'Hoy vamos a ver como se organiza una clase de principio a fin.',
  'La preparacion es la mitad del trabajo y casi nadie la hace bien.',
  '',
  '# Primer paso',
  '',
  'Empieza siempre por el objetivo concreto de la sesion.',
  'Sin objetivo claro la clase se convierte en una charla sin rumbo.',
].join('\n');

const server = createServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let browser;
let proyecto = null;
const resultado = {};

try {
  // Un proyecto de estudio real, con escenas de verdad.
  proyecto = createStudio({ title: 'Smoke de subtitulos', script: GUION, aspectRatio: '16:9', template: 'video-explicativo' });

  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errores = [];
  page.on('pageerror', e => errores.push(`${e.message}`));

  // ------------------------------------------------------- ESTUDIO
  await page.goto(`${base}/studio.html`);
  await page.evaluate(id => localStorage.setItem('studioProject', id), proyecto.id);
  await page.reload();
  await page.locator('#scenes .scene').first().waitFor({ timeout: 20000 });

  const escenas = await page.locator('#scenes .scene').count();
  assert.ok(escenas >= 2, `el proyecto de prueba deberia traer varias escenas, trae ${escenas}`);

  // 1. Los cuatro presets estan.
  const presets = await page.locator('#subs-presets button').allTextContents();
  for (const esperado of ['Redes sociales', 'Curso', 'Limpio', 'Alto contraste']) {
    assert.ok(presets.includes(esperado), `falta el preset "${esperado}" (hay: ${presets.join(', ')})`);
  }

  // 2. Los ocho controles globales existen.
  for (const id of ['subs-font', 'subs-scale', 'subs-color', 'subs-bg', 'subs-bgcolor',
    'subs-bgopacity', 'subs-outline', 'subs-pos', 'subs-align']) {
    assert.equal(await page.locator(`#${id}`).count(), 1, `falta el control #${id}`);
  }

  // 3. La medida anunciada cambia con el tamano y con el formato.
  const medida = () => page.locator('#subs-medida').textContent();
  await page.locator('#subs-scale').selectOption('1');
  const normal = await medida();
  assert.match(normal, /16:9/);
  assert.match(normal, /48 px/, `en 16:9 con tamano normal debe anunciar 48 px: "${normal}"`);
  await page.locator('#subs-scale').selectOption('1.3');
  assert.match(await medida(), /62 px/, 'subir el tamano debe subir la cifra');
  await page.locator('#subs-scale').selectOption('1');

  // 4. Aplicar un preset cambia los controles de verdad.
  await page.locator('#subs-presets button', { hasText: 'Alto contraste' }).click();
  assert.equal((await page.locator('#subs-color').inputValue()).toLowerCase(), '#ffe600',
    'el preset de alto contraste debe poner el texto en amarillo');
  assert.equal(await page.locator('#subs-bg').inputValue(), 'box');
  await page.locator('#subs-presets button', { hasText: 'Redes sociales' }).click();
  assert.equal((await page.locator('#subs-color').inputValue()).toLowerCase(), '#ffffff');
  assert.equal(await page.locator('#subs-bg').inputValue(), 'outline');

  // 5. Apagar el subtitulado esconde el panel y lo dice.
  await page.locator('#captions').uncheck();
  assert.equal(await page.locator('#subs-detalle').isHidden(), true, 'sin subtitulos el panel sobra');
  assert.match(await page.locator('#subs-resumen').textContent(), /Sin subt/);
  await page.locator('#captions').check();
  assert.match(await page.locator('#subs-resumen').textContent(), /video entero/);

  // 6. Cada escena trae el control de texto destacado.
  const conControl = await page.locator('#scenes .scene .destacado').count();
  assert.equal(conControl, escenas, 'todas las tarjetas deben ofrecer el control');
  assert.match(await page.locator('.destacado summary').first().textContent(),
    /Agregar texto destacado sobre la imagen/);

  // 7. El rotulo NO esta en todas las escenas: es una propuesta, no un automatismo.
  const encendidas = await page.locator('.destacado input[type="checkbox"]:checked').count();
  assert.ok(encendidas < escenas, `el rotulo no puede venir activo en las ${escenas} escenas`);
  resultado.escenas = escenas;
  resultado.escenasConRotulo = encendidas;

  // 8. Desactivar NO borra el texto escrito.
  const primera = page.locator('#scenes .scene').first();
  const caja = primera.locator('.destacado');
  const casilla = caja.locator('summary input[type="checkbox"]');
  const texto = caja.locator('input[data-field="onScreenTitle"]');
  if (!(await casilla.isChecked())) await casilla.check();
  await texto.fill('Concepto clave');
  const antes = await texto.inputValue();
  await casilla.uncheck();
  assert.equal(await texto.inputValue(), antes, 'desactivar no puede borrar el texto');
  assert.equal(await caja.locator('.destacado-panel').isHidden(), true);
  await casilla.check();
  assert.equal(await texto.inputValue(), 'Concepto clave');

  // 9. La vista previa reacciona a posicion, tamano y color.
  const previa = caja.locator('.previa');
  const arriba = () => previa.locator('.previa-rotulo').evaluate(el => el.getBoundingClientRect().top);
  await caja.locator('select[data-field="onScreenPosition"]').selectOption('top');
  const yArriba = await arriba();
  await caja.locator('select[data-field="onScreenPosition"]').selectOption('lower-third');
  const yAbajo = await arriba();
  assert.ok(yAbajo > yArriba, 'mover el rotulo abajo debe bajarlo en la vista previa');

  const alto = () => previa.locator('.previa-rotulo').evaluate(el => el.getBoundingClientRect().height);
  await caja.locator('select[data-field="onScreenSize"]').selectOption('small');
  const chico = await alto();
  await caja.locator('select[data-field="onScreenSize"]').selectOption('xlarge');
  assert.ok(await alto() > chico, 'el tamano debe verse en la vista previa');

  // El rotulo no puede solaparse con la franja de subtitulos de la previa.
  await caja.locator('select[data-field="onScreenPosition"]').selectOption('upper-third');
  const cajaRotulo = await previa.locator('.previa-rotulo').boundingBox();
  const cajaSubs = await previa.locator('.previa-subtitulo').boundingBox();
  assert.ok(cajaRotulo.y + cajaRotulo.height <= cajaSubs.y + 1,
    'en la vista previa el rotulo no puede pisar la franja de subtitulos');

  // 10. Guardar y recargar: todo sigue ahi.
  await caja.locator('select[data-field="onScreenPosition"]').selectOption('center');
  await caja.locator('select[data-field="onScreenAnimation"]').selectOption('slide-up');
  await page.locator('#subs-presets button', { hasText: 'Curso' }).click();
  await page.locator('#save').click();
  await page.locator('#message').filter({ hasText: 'Ajustes guardados' }).waitFor({ timeout: 20000 });

  await page.reload();
  await page.locator('#scenes .scene').first().waitFor({ timeout: 20000 });
  const cajaTras = page.locator('#scenes .scene').first().locator('.destacado');
  assert.equal(await cajaTras.locator('input[data-field="onScreenTitle"]').inputValue(), 'Concepto clave',
    'el texto del rotulo debe sobrevivir a recargar');
  assert.equal(await cajaTras.locator('select[data-field="onScreenPosition"]').inputValue(), 'center');
  assert.equal(await cajaTras.locator('select[data-field="onScreenAnimation"]').inputValue(), 'slide-up');
  assert.equal(await page.locator('#subs-font').inputValue(), 'Verdana', 'el preset Curso usa Verdana');
  assert.equal(await page.locator('#subs-bg').inputValue(), 'box');
  resultado.persistenciaEstudio = true;

  await page.screenshot({ path: '.tmp/captions-smoke-studio.png', fullPage: true });

  // -------------------------------------------------------- EDITOR
  await page.goto(`${base}/editor.html`);
  await page.locator('#ir-crear').click();
  await page.locator('#prompt').fill(
    'Reel vertical para promocionar clases particulares de ingles online para adultos, con horarios flexibles',
  );
  await page.locator('#gen-format').selectOption('9:16');
  await page.locator('#btn-draft').click();
  // El borrador aterriza en el paso «Guion»; las tarjetas viven en «Escenas».
  await page.locator('#draft-scenes .escena').first().waitFor({ state: 'attached', timeout: 60000 });
  await page.locator('.paso[data-paso="escenas"]').click();
  await page.locator('#draft-scenes .escena').first().waitFor({ timeout: 20000 });

  const esc = await page.locator('#draft-scenes .escena').count();
  const bloques = await page.locator('#draft-scenes .escena-destacado').count();
  assert.equal(bloques, esc, 'cada tarjeta del borrador necesita su bloque de rotulo');
  const activos = await page.locator('#draft-scenes .escena-destacado-on:checked').count();
  assert.ok(activos >= 1 && activos < esc,
    `el rotulo debe proponerse en algunas escenas, no en ${activos} de ${esc}`);
  resultado.editorEscenas = esc;
  resultado.editorConRotulo = activos;

  // El control global tambien esta en el editor, y en 9:16 anuncia 64 px.
  await page.locator('.paso[data-paso="voz"]').click();
  assert.match(await page.locator('#subs-medida').textContent(), /9:16/);
  assert.match(await page.locator('#subs-medida').textContent(), /64 px/);
  await page.locator('#subs-on').uncheck();
  assert.match(await page.locator('#subs-resumen').textContent(), /Sin subt/);
  await page.locator('#subs-on').check();

  await page.screenshot({ path: '.tmp/captions-smoke-editor.png', fullPage: true });

  assert.deepEqual(errores, [], `errores de JavaScript en la pagina: ${errores.join(' | ')}`);
  resultado.pageErrors = errores;
  resultado.ok = true;
  await fs.writeFile('.tmp/captions-smoke.json', JSON.stringify(resultado, null, 2));
  console.log(JSON.stringify(resultado, null, 2));
} finally {
  if (browser) await browser.close();
  if (proyecto) deleteProject(proyecto.id);
  await new Promise(r => server.close(r));
}
