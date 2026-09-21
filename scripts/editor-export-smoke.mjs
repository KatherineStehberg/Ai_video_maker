/**
 * FLUJO COMPLETO DEL EDITOR, HASTA EL MP4.
 *
 * Es la parte del flujo que el smoke de navegador no hace porque tarda:
 *   editar -> guardar -> recargar -> exportar -> comprobar que el MP4 CONTIENE
 *   los cambios (duracion, subtitulos quemados y rotulo).
 *
 * Sin navegador: se llama a la misma API que usa el editor.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { createStudio } from '../src/studio/service.js';
import { loadProject, deleteProject } from '../src/core/project.js';
import { abs } from '../src/lib/paths.js';
import { probeDuration } from '../src/lib/ffmpeg.js';

process.env.GEMINI_API_KEY = '';
process.env.LLM_PROVIDER = 'none';
process.env.IMAGE_PROVIDER = 'local';   // fondos de marca: sin red ni Pexels

const GUION = [
  'Este es el primer tramo de la prueba del editor visual.',
  '',
  'Y este es el segundo tramo, que se va a cambiar desde el editor.',
  '',
  'El tercer tramo cierra la prueba del montaje.',
].join('\n');

const server = createServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const API = `${base}/api/project-editor`;

const pasos = [];
const paso = (n, d) => { pasos.push(n); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };

const get = async (ruta) => {
  const r = await fetch(API + ruta);
  const b = await r.json();
  if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`);
  return b;
};
const escribir = async (ruta, method, cuerpo) => {
  const r = await fetch(API + ruta, {
    method, headers: { 'content-type': 'application/json', 'x-editor-request': '1' }, body: JSON.stringify(cuerpo),
  });
  const b = await r.json();
  if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`);
  return b;
};

let proyecto = null;
const resultado = {};

try {
  proyecto = createStudio({ title: 'Export del editor', script: GUION, aspectRatio: '16:9', template: 'video-explicativo' });
  resultado.projectId = proyecto.id;

  let vista = await get(`/projects/${proyecto.id}`);
  const escenas = vista.derivado.escenas;
  assert.ok(escenas.length >= 3, `se esperaban varias escenas, hay ${escenas.length}`);
  paso('Proyecto abierto', `${escenas.length} escenas · ${vista.derivado.duracion} s`);

  // ------------------------------------------------------------ 1. EDITAR
  const NARRACION = 'Segundo tramo reescrito por completo desde el editor visual.';
  const ROTULO = 'Idea principal';
  vista = await escribir(`/projects/${proyecto.id}`, 'PATCH', {
    revision: vista.derivado.revision,
    title: 'Export del editor · editado',
    scenes: [
      { id: escenas[1].id, text: NARRACION, showOnScreenText: true, onScreenTitle: ROTULO, onScreenPosition: 'top' },
      // La última se excluye: el MP4 tiene que salir más corto.
      { id: escenas.at(-1).id, excluida: true },
    ],
    captions: { enabled: true, style: { preset: 'alto-contraste' } },
    voice: { gain: 1.2 },
  });
  const duracionEsperada = vista.derivado.duracion;
  assert.equal(vista.derivado.escenas[1].onScreenTitle, ROTULO);
  assert.equal(vista.derivado.escenas.at(-1).excluida, true);
  paso('Editado y guardado', `duración ahora ${duracionEsperada} s (la última escena queda excluida)`);

  // --------------------------------------------------------- 2. RECARGAR
  const recargado = await get(`/projects/${proyecto.id}`);
  assert.equal(recargado.derivado.escenas[1].text, NARRACION);
  assert.equal(recargado.derivado.escenas[1].onScreenTitle, ROTULO);
  assert.equal(recargado.proyecto.captions.style.preset, 'alto-contraste');
  assert.equal(recargado.proyecto.voice.gain, 1.2);
  assert.notEqual(recargado.derivado.exportedRevision, recargado.derivado.revision,
    'tras editar, lo exportado debe quedar marcado como anterior');
  paso('Persistencia', 'la edición sobrevive a releer el proyecto');

  // --------------------------------------------------------- 3. EXPORTAR
  console.log('    exportando (esto tarda)…');
  const t0 = Date.now();
  await escribir(`/projects/${proyecto.id}/export`, 'POST', {});
  let job = null;
  for (;;) {
    const r = await get(`/projects/${proyecto.id}/job`);
    job = r.job;
    if (job?.status !== 'running') break;
    await new Promise(res => setTimeout(res, 1500));
  }
  assert.equal(job.status, 'complete', `la exportación falló: ${job.error}`);
  const segundos = ((Date.now() - t0) / 1000).toFixed(0);
  paso('Exportación', `terminada en ${segundos} s`);

  // ------------------------------------------- 4. EL MP4 TRAE LOS CAMBIOS
  const fin = await get(`/projects/${proyecto.id}`);
  assert.ok(fin.derivado.salida, 'no se registró ninguna salida');
  assert.equal(fin.derivado.salida.alDia, true, 'el MP4 debe corresponder a la revisión guardada');

  const archivo = abs(fin.derivado.salida.path);
  assert.ok(fs.existsSync(archivo), `el MP4 no está en disco: ${archivo}`);
  const real = await probeDuration(archivo);
  assert.ok(real > 0, 'el MP4 no tiene duración');
  // La escena excluida NO puede estar en el montaje.
  assert.ok(Math.abs(real - duracionEsperada) < 1.5,
    `el MP4 dura ${real.toFixed(2)} s y la línea de tiempo dice ${duracionEsperada} s`);

  // Los subtítulos quemados salen del .ass del formato, con la narración nueva.
  const ass = path.join('output', 'drafts', proyecto.id, 'captions_16x9.ass');
  assert.ok(fs.existsSync(ass), 'no se generó el .ass del formato');
  const textoAss = fs.readFileSync(ass, 'utf8');
  assert.ok(textoAss.includes('Segundo tramo reescrito'), 'el subtítulo no recoge la narración editada');
  assert.ok(!textoAss.includes('tercer tramo cierra'), 'la escena excluida no puede tener subtítulo');
  const estilo = textoAss.match(/^Style: Main,(.+)$/m)[1].split(',');
  assert.equal(estilo[1], '50', 'el preset «alto contraste» da 50 px en 16:9');

  const enDisco = loadProject(proyecto.id);
  assert.equal(enDisco.scenes[1].showOnScreenText, true, 'el rótulo debe seguir activo tras exportar');
  assert.equal(enDisco.editor.exportedRevision, enDisco.editor.revision);

  resultado.mp4 = {
    path: fin.derivado.salida.path,
    MB: Number((fin.derivado.salida.bytes / 1e6).toFixed(2)),
    duracionMedida: Number(real.toFixed(2)),
    duracionEsperada,
    subtituloEditadoPresente: true,
    escenaExcluidaAusente: true,
    tamanoLetraAss: Number(estilo[1]),
  };
  paso('El MP4 contiene los cambios', `${resultado.mp4.duracionMedida} s · ${resultado.mp4.MB} MB · letra ${estilo[1]} px`);

  resultado.pasos = pasos;
  resultado.ok = true;
  await fs.promises.writeFile('.tmp/editor-export-smoke.json', JSON.stringify(resultado, null, 2));
  console.log('\n' + JSON.stringify(resultado, null, 2));
} finally {
  if (proyecto) deleteProject(proyecto.id);
  await new Promise(r => server.close(r));
}
