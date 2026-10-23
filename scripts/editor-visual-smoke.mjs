/**
 * SMOKE DEL EDITOR VISUAL, en un navegador real a 1366x768.
 *
 * Recorre el flujo completo que se pidio:
 *   home intacta -> abrir proyecto -> Editar -> seleccionar escena ->
 *   cambiar narracion -> cambiar rotulo -> cambiar subtitulos -> volumen ->
 *   guardar -> recargar -> comprobar persistencia
 *
 * Comprueba ademas lo que no se puede ver desde el backend: que a 1366x768 no
 * haya scroll de pagina, que los botones no se solapen y que la linea de
 * tiempo se vea entera.
 *
 * No exporta el MP4 aqui: eso tarda minutos y se verifica aparte.
 */
import { chromium } from '../.tmp/browser-tools/node_modules/playwright-core/index.mjs';
import { createServer } from '../src/server.js';
import { createStudio } from '../src/studio/service.js';
import { deleteProject, loadProject } from '../src/core/project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

process.env.GEMINI_API_KEY = '';
process.env.LLM_PROVIDER = 'none';

const VISTA = { width: 1366, height: 768 };

const GUION = [
  '# El metodo en tres pasos',
  '',
  'Antes de empezar conviene tener claro a donde queremos llegar con la sesion.',
  'Sin un objetivo concreto la clase se convierte en una conversacion sin rumbo.',
  '',
  '# Primer paso',
  '',
  'Escribe el objetivo en una sola frase y tenlo delante todo el rato.',
  'Cada actividad que propongas tiene que acercarte a esa frase.',
  '',
  '# Cierre',
  '',
  'Repasa al final lo que se ha conseguido y anota lo que quedo pendiente.',
].join('\n');

const server = createServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let browser;
let proyecto = null;
const pasos = [];
const paso = (nombre, detalle) => { pasos.push(nombre); console.log(`  ✓ ${nombre}${detalle ? ' — ' + detalle : ''}`); };
const resultado = { vista: `${VISTA.width}x${VISTA.height}`, urlBase: base };

try {
  proyecto = createStudio({ title: 'Smoke del editor', script: GUION, aspectRatio: '16:9', template: 'video-explicativo' });
  resultado.projectId = proyecto.id;
  resultado.url = `${base}/project-editor.html?id=${proyecto.id}`;

  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
  });
  const page = await browser.newPage({ viewport: VISTA });
  const errores = [];
  page.on('pageerror', e => errores.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errores.push(`console: ${m.text()}`); });
  page.on('response', r => { if (r.status() >= 400) errores.push(`HTTP ${r.status()} ${r.url()}`); });

  // ------------------------------------------------- 1. LA HOME NO CAMBIA
  await page.goto(`${base}/editor.html`);
  await page.waitForFunction(() => document.getElementById('gen-provider-hint').textContent.length > 10);
  assert.equal(await page.locator('[data-pantalla="inicio"] h1').textContent(), '¿Qué quieres hacer hoy?');
  assert.equal(await page.locator('#ir-crear').count(), 1, 'la home conserva «Crear video con IA»');
  assert.equal(await page.locator('#ir-subir').count(), 1, 'la home conserva «Editar un video existente»');
  assert.equal(await page.locator('.nav-item').count(), 7, 'la home conserva sus 7 secciones');
  await page.screenshot({ path: '.tmp/editor-visual-home.png', fullPage: false });
  paso('Home preservada', '7 secciones y las dos acciones de siempre');

  // ------------------------------------------------------ 2. ABRIR EDITOR
  await page.goto(resultado.url);
  await page.waitForSelector('.escena-item', { timeout: 30000 });
  assert.equal(await page.locator('#cargando').isHidden(), true);

  // Estructura completa: barra, herramientas, panel, preview, timeline.
  for (const sel of ['.ed-top', '.ed-herramientas', '.ed-panel', '.ed-escenario', '.ed-timeline', '#marco', '#tl-pistas']) {
    assert.equal(await page.locator(sel).isVisible(), true, `falta ${sel}`);
  }
  assert.equal(await page.locator('.herr').count(), 8, 'ocho herramientas');
  paso('Editor abierto', `${await page.locator('.escena-item').count()} escenas`);

  // --------------------------------------- 3. CABE EN 1366x768, SIN SOLAPES
  const desborde = await page.evaluate(() => ({
    scrollY: document.documentElement.scrollHeight - window.innerHeight,
    scrollX: document.documentElement.scrollWidth - window.innerWidth,
  }));
  assert.ok(desborde.scrollY <= 1, `la página se desborda ${desborde.scrollY}px en vertical`);
  assert.ok(desborde.scrollX <= 1, `la página se desborda ${desborde.scrollX}px en horizontal`);

  // La línea de tiempo y sus pistas tienen que verse enteras.
  const tl = await page.locator('.ed-timeline').boundingBox();
  assert.ok(tl.y + tl.height <= VISTA.height + 1, 'la línea de tiempo se sale de la pantalla');
  assert.ok(await page.locator('.tl-pista').count() >= 2, 'deben dibujarse varias pistas');

  // Botones de la barra superior: ninguno puede montarse sobre otro.
  const cajas = await page.locator('.ed-top .btn, .ed-top .segmentado, .ed-top .conmutador').evaluateAll(
    nodos => nodos.map(n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, t: n.textContent.trim().slice(0, 16) }; }),
  );
  for (let i = 0; i < cajas.length; i++) {
    for (let j = i + 1; j < cajas.length; j++) {
      const a = cajas[i], b = cajas[j];
      const solapa = a.x < b.x + b.w - 1 && a.x + a.w - 1 > b.x && a.y < b.y + b.h - 1 && a.y + a.h - 1 > b.y;
      assert.ok(!solapa, `los controles "${a.t}" y "${b.t}" se solapan`);
    }
  }
  resultado.timeline = { alto: Math.round(tl.height), pistas: await page.locator('.tl-pista').count() };
  paso('Cabe en 1366×768', `sin scroll de página, ${resultado.timeline.pistas} pistas visibles`);

  // ------------------------------------------- 4. SELECCIONAR UNA ESCENA
  const marcoAntes = await page.locator('#marco').boundingBox();
  await page.locator('.escena-item').nth(1).click();
  await page.waitForFunction(() => document.querySelectorAll('.escena-item[aria-current="true"]').length === 1);
  const tiempo = await page.locator('#tiempo').textContent();
  assert.notEqual(tiempo, '0:00 / 0:00');
  // El cabezal se movió con la selección.
  const cabezal = await page.locator('#tl-cabezal').evaluate(n => parseFloat(n.style.left));
  assert.ok(cabezal > 0, 'el cabezal debe moverse al seleccionar la escena 2');
  paso('Selección de escena', `cabezal en ${cabezal.toFixed(0)}px · ${tiempo}`);

  // ------------------------------------------------- 5. CAMBIAR NARRACIÓN
  const NARRACION = 'Narración cambiada desde el editor visual para la prueba.';
  await page.locator('.panel-cuerpo textarea').first().fill(NARRACION);
  await page.waitForFunction(() => document.getElementById('estado-guardado').textContent.includes('sin guardar'));
  assert.equal(await page.locator('#deshacer').isDisabled(), false, 'deshacer debe activarse tras editar');
  paso('Edición de narración', 'el proyecto queda marcado como «Cambios sin guardar»');

  // --------------------------------------------------- 6. TEXTO DESTACADO
  await page.locator('.herr[data-herr="texto"]').click();
  await page.waitForFunction(() => document.getElementById('panel-titulo').textContent.includes('Texto'));
  const rotOn = page.locator('.panel-cuerpo input[type="checkbox"]').first();
  if (!(await rotOn.isChecked())) await rotOn.check();
  await page.locator('.panel-cuerpo input[type="text"]').first().fill('Idea central');
  await page.waitForFunction(() => {
    const r = document.getElementById('rotulo');
    return r && !r.hidden && r.textContent.includes('Idea central');
  }, null, { timeout: 5000 });
  paso('Texto destacado', 'el rótulo aparece en la vista previa al escribirlo');

  // El rótulo no puede caer sobre el subtítulo.
  const solapeOverlays = await page.evaluate(() => {
    const r = document.getElementById('rotulo');
    const s = document.getElementById('subtitulo');
    if (!r || !s || r.hidden || s.hidden) return false;
    const a = r.getBoundingClientRect(), b = s.getBoundingClientRect();
    return a.top < b.bottom - 1 && a.bottom - 1 > b.top;
  });
  assert.equal(solapeOverlays, false, 'el rótulo se está pintando sobre el subtítulo');
  paso('Rótulo y subtítulo', 'conviven sin solaparse en la vista previa');

  // ------------------------------------------------------ 7. SUBTÍTULOS
  await page.locator('.herr[data-herr="subtitulos"]').click();
  await page.waitForFunction(() => document.getElementById('panel-titulo').textContent === 'Subtítulos');
  const textoSubs = await page.locator('.panel-cuerpo').textContent();
  assert.match(textoSubs, /48 px/, `en 16:9 debe anunciar 48 px · vi: ${textoSubs.slice(0, 200)}`);
  assert.match(textoSubs, /Cobertura 100/, 'debe declarar la cobertura real');
  for (const p of ['Redes sociales', 'Curso', 'Limpio', 'Alto contraste']) {
    assert.ok(textoSubs.includes(p), `falta el preset ${p}`);
  }
  await page.locator('.panel-cuerpo button', { hasText: 'Curso' }).click();
  await page.waitForFunction(() => document.getElementById('estado-guardado').textContent.includes('sin guardar'));
  paso('Subtítulos', '48 px en 16:9, cobertura 100 %, preset aplicado');

  // Zonas seguras.
  await page.locator('#zonas-seguras').check();
  assert.equal(await page.locator('#zona-abajo').isVisible(), true, 'las zonas seguras deben dibujarse');
  const altoZona = await page.locator('#zona-abajo').evaluate(n => parseFloat(n.style.height));
  assert.ok(altoZona > 5, `la franja inferior de 16:9 debe rondar el 10 % · vi ${altoZona}`);
  paso('Zonas seguras', `franja inferior al ${altoZona.toFixed(0)} % del alto`);
  await page.screenshot({ path: '.tmp/editor-visual-subtitulos.png' });

  // ---------------------------------------------------------- 8. AUDIO
  await page.locator('.herr[data-herr="audio"]').click();
  await page.waitForFunction(() => document.getElementById('panel-titulo').textContent === 'Audio');
  // `fill()` no dispara `change` en un input[type=range]: se pone el valor y
  // se emite el evento a mano, que es lo que hace el navegador al soltar.
  const rango = page.locator('.panel-cuerpo input[type="range"]').first();
  await rango.evaluate(n => {
    n.value = '1.4';
    n.dispatchEvent(new Event('input', { bubbles: true }));
    n.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => document.getElementById('estado-guardado').textContent.includes('sin guardar'));
  paso('Audio', 'volumen de narración ajustado a 140 %');

  // --------------------------------------------------------- 9. GUARDAR
  await page.locator('#guardar').click();
  await page.waitForFunction(() => document.getElementById('estado-guardado').textContent.trim() === 'Guardado', null, { timeout: 30000 });
  assert.equal(await page.locator('#guardar').isDisabled(), true, 'sin cambios, «Guardar» se apaga');
  paso('Guardado', 'el estado vuelve a «Guardado»');

  await page.screenshot({ path: '.tmp/editor-visual-editor.png' });
  await page.locator('.herr[data-herr="escenas"]').click();
  await page.locator('.ed-timeline').screenshot({ path: '.tmp/editor-visual-timeline.png' });

  // ------------------------------------------------------- 10. RECARGAR
  await page.reload();
  await page.waitForSelector('.escena-item', { timeout: 30000 });
  await page.locator('.escena-item').nth(1).click();
  const narracionTras = await page.locator('.panel-cuerpo textarea').first().inputValue();
  assert.equal(narracionTras, NARRACION, 'la narración editada debe sobrevivir a recargar');

  await page.locator('.herr[data-herr="texto"]').click();
  const rotuloTras = await page.locator('.panel-cuerpo input[type="text"]').first().inputValue();
  assert.equal(rotuloTras, 'Idea central', 'el rótulo debe sobrevivir a recargar');

  await page.locator('.herr[data-herr="subtitulos"]').click();
  const subsTras = await page.locator('.panel-cuerpo').textContent();
  assert.match(subsTras, /44 px/, 'el preset Curso (0.92×) debe seguir aplicado tras recargar');
  paso('Persistencia', 'narración, rótulo y estilo de subtítulos sobreviven a recargar');

  // Y en disco, que es lo que de verdad importa.
  const enDisco = loadProject(proyecto.id);
  assert.equal(enDisco.scenes[1].text, NARRACION);
  assert.equal(enDisco.scenes[1].onScreenTitle, 'Idea central');
  assert.equal(enDisco.scenes[1].showOnScreenText, true);
  assert.equal(enDisco.captions.style.preset, 'curso');
  assert.equal(enDisco.voice.gain, 1.4);
  resultado.persistencia = {
    narracion: true, rotulo: true, presetSubtitulos: enDisco.captions.style.preset,
    gananciaVoz: enDisco.voice.gain, revision: enDisco.editor?.revision,
  };
  paso('Persistencia en disco', `revisión ${enDisco.editor?.revision} · ganancia ${enDisco.voice.gain}`);

  // --------------------------------------------- 11. FORMATO 9:16 Y 16:9
  for (const formato of ['9:16', '16:9']) {
    await page.locator(`#formatos button:text-is("${formato}")`).click();
    await page.waitForFunction(f => document.getElementById('marco').dataset.formato === f, formato);
    const caja = await page.locator('#marco').boundingBox();
    const ratio = caja.width / caja.height;
    const esperado = formato === '9:16' ? 9 / 16 : 16 / 9;
    assert.ok(Math.abs(ratio - esperado) < 0.05, `${formato}: la proporción del marco es ${ratio.toFixed(2)}`);
    assert.ok(caja.height <= VISTA.height, `${formato}: el preview se sale de la pantalla`);
    await page.screenshot({ path: `.tmp/editor-visual-preview-${formato.replace(':', 'x')}.png` });
  }
  paso('Preview 9:16 y 16:9', 'proporción correcta y dentro de la pantalla');

  // ------------------------------------------- 12. NADA SIMULADO NI ROTO
  const proximamente = await page.locator('.proximamente').count();
  const proximamenteActivos = await page.locator('.proximamente:not([disabled])').count();
  assert.equal(proximamenteActivos, 0, 'lo etiquetado como «Próximamente» debe estar deshabilitado');
  assert.equal(await page.locator('[draggable="true"]').count(), 0, 'no debe haber arrastre simulado');
  resultado.proximamente = proximamente;
  paso('Sin funciones simuladas', `${proximamente} controles «Próximamente», todos deshabilitados`);

  assert.deepEqual(errores, [], `errores en la página: ${errores.join(' | ')}`);
  resultado.pasos = pasos;
  resultado.pageErrors = errores;
  resultado.ok = true;
  await fs.writeFile('.tmp/editor-visual-smoke.json', JSON.stringify(resultado, null, 2));
  console.log('\n' + JSON.stringify(resultado, null, 2));
} finally {
  if (browser) await browser.close();
  if (proyecto) deleteProject(proyecto.id);
  await new Promise(r => server.close(r));
}
