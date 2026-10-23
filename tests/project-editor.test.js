import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createServer } from '../src/server.js';
import { makeProject, saveProject, loadProject, deleteProject, activeScenes, totalDuration } from '../src/core/project.js';
import { buildCues, verifyCaptionCoverage } from '../src/core/subtitles.js';
import { derivar, guardar, capacidades, catalogoTransiciones, publico } from '../src/project-editor/service.js';
import { localStorageAdapter, setStorage, getStorage } from '../src/project-editor/storage.js';
import { peaks } from '../src/project-editor/waveform.js';
import { ffmpegRun } from '../src/lib/ffmpeg.js';

import {
  estadoInicial, cambiar, cambiarEscena, deshacer, rehacer, puedeDeshacer, puedeRehacer,
  haycambios, cuerpoGuardado, confirmarGuardado, proyectoVisible, escenasVisibles, escenaEn, reloj,
} from '../src/ui/project-editor/state.js';
import { partirEnLineas, subtituloEn } from '../src/ui/project-editor/preview.js';
import { zoomQueEncaja, PX_SEG_BASE } from '../src/ui/project-editor/timeline.js';

/**
 * EDITOR VISUAL
 *
 * Todo local: sin red, sin proveedores de pago. La única parte que toca FFmpeg
 * es la forma de onda, y se construye su fixture con FFmpeg mismo.
 */

const dir = path.resolve('.tmp/project-editor-test');

const proyectoDemo = (extra = {}) => makeProject({
  title: 'Editor de prueba',
  aspectRatio: '16:9',
  scenes: [
    { text: 'Primera escena de la prueba, con texto suficiente para varios subtítulos.', duration: 6 },
    { text: 'Segunda escena, más corta.', duration: 3 },
    { text: 'Tercera y última escena del proyecto.', duration: 4 },
  ],
  ...extra,
});

// ----------------------------------------------------- 1. ESTADO (SIN DOM)

test('el estado arranca limpio y detecta cuándo hay cambios sin guardar', () => {
  let s = estadoInicial();
  assert.equal(haycambios(s), false);
  assert.equal(puedeDeshacer(s), false);

  s = cambiar(s, 'title', 'Nuevo nombre');
  assert.equal(haycambios(s), true);
  assert.equal(puedeDeshacer(s), true);
  assert.equal(puedeRehacer(s), false);
});

test('deshacer y rehacer recorren el historial de verdad', () => {
  let s = estadoInicial();
  s = cambiar(s, 'title', 'uno');
  s = cambiar(s, 'title', 'dos');
  assert.equal(s.parche.title, 'dos');

  s = deshacer(s);
  assert.equal(s.parche.title, 'uno');
  assert.equal(puedeRehacer(s), true);

  s = deshacer(s);
  assert.equal(haycambios(s), false, 'deshacer hasta el principio deja el proyecto limpio');

  s = rehacer(s);
  assert.equal(s.parche.title, 'uno');
  s = rehacer(s);
  assert.equal(s.parche.title, 'dos');
  assert.equal(puedeRehacer(s), false);
});

test('un cambio nuevo invalida lo deshecho', () => {
  let s = estadoInicial();
  s = cambiar(s, 'title', 'uno');
  s = deshacer(s);
  assert.equal(puedeRehacer(s), true);
  s = cambiar(s, 'title', 'otro');
  assert.equal(puedeRehacer(s), false, 'tras editar no se puede rehacer lo viejo');
});

test('el parche se funde sobre el proyecto sin tocar el original', () => {
  let s = estadoInicial();
  s = { ...s, proyecto: { title: 'Original', captions: { enabled: true, style: { color: '#ffffff', preset: 'redes-sociales' } } } };
  s = cambiar(s, 'captions.style.color', '#ff0000');

  const visible = proyectoVisible(s);
  assert.equal(visible.captions.style.color, '#ff0000');
  assert.equal(visible.captions.style.preset, 'redes-sociales', 'el resto del estilo se conserva');
  assert.equal(visible.captions.enabled, true);
  assert.equal(s.proyecto.captions.style.color, '#ffffff', 'el proyecto del servidor NO se toca');
});

test('el cuerpo de guardado manda sólo lo que cambió', () => {
  let s = estadoInicial();
  s = { ...s, derivado: { revision: 7 } };
  s = cambiar(s, 'title', 'Nombre');
  s = cambiarEscena(s, 'sc_1', 'text', 'Narración nueva');
  s = cambiarEscena(s, 'sc_1', 'duration', 5);

  const cuerpo = cuerpoGuardado(s);
  assert.equal(cuerpo.revision, 7, 'la revisión viaja para detectar ediciones en paralelo');
  assert.equal(cuerpo.title, 'Nombre');
  assert.deepEqual(cuerpo.scenes, [{ id: 'sc_1', text: 'Narración nueva', duration: 5 }]);
  assert.equal(cuerpo.captions, undefined, 'no se manda lo que no se tocó');
});

test('tras guardar, el parche y el historial quedan vacíos', () => {
  let s = estadoInicial();
  s = cambiar(s, 'title', 'x');
  s = confirmarGuardado(s, { proyecto: { title: 'x' }, derivado: { revision: 2 } });
  assert.equal(haycambios(s), false);
  assert.equal(puedeDeshacer(s), false, 'el historial se cierra al guardar');
  assert.equal(s.derivado.revision, 2);
});

test('las escenas visibles llevan el parche encima', () => {
  let s = estadoInicial();
  s = { ...s, derivado: { escenas: [{ index: 0, id: 'a', text: 'vieja' }, { index: 1, id: 'b', text: 'otra' }] } };
  s = cambiarEscena(s, 'a', 'text', 'nueva');
  const e = escenasVisibles(s);
  assert.equal(e[0].text, 'nueva');
  assert.equal(e[1].text, 'otra');
});

test('escenaEn localiza la escena de un instante', () => {
  const escenas = [{ start: 0, end: 5 }, { start: 5, end: 9 }, { start: 9, end: 12 }];
  assert.equal(escenaEn(escenas, 0), 0);
  assert.equal(escenaEn(escenas, 4.9), 0);
  assert.equal(escenaEn(escenas, 5), 1);
  assert.equal(escenaEn(escenas, 11.9), 2);
  assert.equal(escenaEn(escenas, 99), 2, 'pasado el final se queda en la última');
  assert.equal(escenaEn([], 3), -1);
});

test('el reloj no muestra cadenas raras', () => {
  assert.equal(reloj(0), '0:00');
  assert.equal(reloj(65), '1:05');
  assert.equal(reloj(3700), '1:01:40');
  assert.equal(reloj(NaN), '0:00');
});

// ------------------------------------------------- 2. VISTA PREVIA (PURA)

test('la vista previa parte líneas sin cortar palabras', () => {
  const l = partirEnLineas('Una frase bastante larga que no cabe entera en una sola línea', 20, 2);
  assert.ok(l.length <= 2);
  for (const linea of l) assert.ok(linea.length <= 20 || !linea.includes(' '), `"${linea}" pasa del ancho`);
  assert.ok('Una frase bastante larga que no cabe entera en una sola línea'.startsWith(l[0]));
  assert.deepEqual(partirEnLineas('', 20), []);
});

test('el subtítulo de la vista previa avanza con el tiempo, como en el render', () => {
  const escena = { start: 0, duration: 6, text: 'Uno dos tres cuatro cinco seis siete ocho nueve diez once doce trece catorce.' };
  const alPrincipio = subtituloEn(escena, 0.1, 20, 2);
  const alFinal = subtituloEn(escena, 5.9, 20, 2);
  assert.ok(alPrincipio, 'al empezar ya hay subtítulo');
  assert.ok(alFinal, 'al acabar también');
  assert.notEqual(alPrincipio, alFinal, 'el subtítulo tiene que cambiar a lo largo de la escena');
  assert.ok(alPrincipio.split('\n').length <= 2);
  assert.equal(subtituloEn({ start: 0, duration: 3, text: '' }, 1, 20, 2), '');
});

test('el zoom inicial hace que un proyecto largo quepa de una vez', () => {
  // 28 minutos a 40 px/s serían 67 000 px: hay que reducir mucho.
  const z = zoomQueEncaja(1678, 1200);
  assert.ok(z < 0.1, `zoom ${z}`);
  assert.ok(z > 0, 'el zoom nunca puede ser cero');
  assert.ok(1678 * PX_SEG_BASE * z <= 1200 + 1, 'el proyecto entero debe caber en el ancho');
  // Un video corto no se amplía más allá de 1x.
  assert.equal(zoomQueEncaja(5, 1200), 1);
});

// --------------------------------------------- 3. DATOS DERIVADOS (BACKEND)

test('derivar da tiempos, estados e indicadores por escena', () => {
  const p = proyectoDemo();
  const d = derivar(p);

  assert.equal(d.escenas.length, 3);
  assert.equal(d.duracion, 13);
  assert.deepEqual(d.escenas.map(e => e.start), [0, 6, 9]);
  assert.deepEqual(d.escenas.map(e => e.end), [6, 9, 13]);

  // Sin imágenes ni voz, se declara tal cual: no se inventa nada.
  for (const e of d.escenas) {
    assert.equal(e.recurso.estado, 'falta');
    assert.equal(e.faltaRecurso, true);
    assert.equal(e.tieneNarracion, false);
    assert.equal(e.tieneSubtitulos, true, 'con texto y subtítulos activos siempre hay cue');
  }
  assert.equal(d.subtitulos.metrica.fontSize, 48, '16:9 debe dar 48 px');
  assert.equal(d.subtitulos.cobertura.ok, true);
  assert.equal(d.subtitulos.cobertura.porcentaje, 100);
});

test('las pistas de la línea de tiempo sólo cuentan lo que existe', () => {
  const p = proyectoDemo();
  const d = derivar(p);
  assert.equal(d.pistas.musica, 0, 'sin música no hay pista de música');
  assert.equal(d.pistas.narracion, 0, 'sin voz generada no hay pista de voz');
  assert.equal(d.pistas.textoDestacado, 0);
  assert.ok(d.pistas.subtitulos > 0);
});

test('con subtítulos apagados no se declara ni un cue', () => {
  const d = derivar(proyectoDemo({ captions: { enabled: false } }));
  assert.equal(d.subtitulos.activos, false);
  assert.equal(d.pistas.subtitulos, 0);
  for (const e of d.escenas) assert.equal(e.tieneSubtitulos, false);
});

test('sólo se ofrecen transiciones que el render distingue de verdad', async () => {
  const c = await capacidades();
  const catalogo = await catalogoTransiciones();
  assert.deepEqual(c.transiciones.map(t => t.id), catalogo.map(t => t.id));
  assert.ok(c.transiciones.some(t => t.id === 'fade' && t.disponible));
  // Cada transición dice si este FFmpeg puede hacerla. Las que no, salen
  // etiquetadas «Próximamente», nunca sustituidas por otro efecto.
  for (const t of c.transiciones) {
    assert.equal(typeof t.disponible, 'boolean', `${t.id} no declara disponibilidad`);
    if (!t.disponible) assert.equal(t.etiqueta, 'Próximamente', `${t.id} no avisa de que no está`);
  }
  assert.ok(c.pendiente.publicar, 'lo que no existe se declara');
  assert.ok(c.pendiente.arrastrarClips);
});

test('la vista pública no filtra rutas internas ni el guion completo', () => {
  const v = publico(proyectoDemo());
  assert.equal(v.script, undefined);
  assert.equal(v.renderLog, undefined);
  assert.equal(v.metadata, undefined);
  assert.ok(v.id && v.title && v.captions);
});

// ----------------------------------------------------- 4. GUARDADO REAL

test('guardar aplica los cambios, sube la revisión e invalida lo exportado', async () => {
  const p = proyectoDemo();
  p.outputs = { '16:9': 'output/final/falso.mp4' };
  p.studio = { approvedScriptHash: 'hash-viejo', revision: 1 };
  saveProject(p);
  try {
    const antes = derivar(loadProject(p.id));
    const r = await guardar(p.id, {
      revision: antes.revision,
      title: 'Nombre editado',
      scenes: [{ id: p.scenes[0].id, text: 'Narración cambiada.', showOnScreenText: true, onScreenTitle: 'Idea clave' }],
      captions: { style: { preset: 'curso' } },
      voice: { gain: 1.5 },
    });

    assert.equal(r.proyecto.title, 'Nombre editado');
    assert.equal(r.derivado.revision, antes.revision + 1, 'guardar sube la revisión');
    assert.equal(r.derivado.escenas[0].onScreenTitle, 'Idea clave');
    assert.equal(r.derivado.escenas[0].tieneTextoDestacado, true);

    const enDisco = loadProject(p.id);
    assert.equal(enDisco.scenes[0].text, 'Narración cambiada.');
    assert.equal(enDisco.captions.style.preset, 'curso');
    assert.equal(enDisco.voice.gain, 1.5);
    assert.equal(enDisco.studio.approvedScriptHash, null, 'editar invalida la aprobación previa');
    // El MP4 anterior sigue en su sitio, pero ya no corresponde a lo guardado.
    assert.notEqual(enDisco.editor.exportedRevision, enDisco.editor.revision);
  } finally { deleteProject(p.id); }
});

test('guardar con una revisión vieja se rechaza en vez de pisar cambios', async () => {
  const p = proyectoDemo();
  saveProject(p);
  try {
    await guardar(p.id, { revision: 1, title: 'Primero' });
    await assert.rejects(
      () => guardar(p.id, { revision: 1, title: 'Segundo' }),
      /cambió en otra pestaña/i,
    );
  } finally { deleteProject(p.id); }
});

test('el editor rechaza lo que el render no sabe hacer', async () => {
  const p = proyectoDemo();
  saveProject(p);
  try {
    const rev = derivar(loadProject(p.id)).revision;
    // `giro-3d` no esta en el catalogo; `wipeleft` SI existe ahora y se acepta.
    await assert.rejects(() => guardar(p.id, { revision: rev, scenes: [{ id: p.scenes[1].id, transition: { type: 'giro-3d' } }] }), /Transición no soportada/);
    await assert.rejects(() => guardar(p.id, { revision: rev, scenes: [{ id: p.scenes[1].id, transition: { type: 'fade', duration: 9 } }] }), /Duración de transición no válida/);
    await assert.rejects(() => guardar(p.id, { revision: rev, scenes: [{ id: p.scenes[0].id, transition: { type: 'fade', duration: 0.4 } }] }), /primera escena/);
    await assert.rejects(() => guardar(p.id, { revision: rev, aspectRatio: '21:9' }), /Formato no admitido/);
    await assert.rejects(() => guardar(p.id, { revision: rev, scenes: [{ id: p.scenes[0].id, text: '   ' }] }), /sin narración/);
    await assert.rejects(() => guardar(p.id, { revision: rev, scenes: [{ id: 'no-existe', text: 'x' }] }), /no existe/);
  } finally { deleteProject(p.id); }
});

test('el bloque del editor sobrevive a guardar y reabrir', async () => {
  const p = proyectoDemo();
  saveProject(p);
  try {
    await guardar(p.id, { revision: 1, title: 'Con editor' });
    const leido = loadProject(p.id);
    assert.ok(leido.editor, '`editor` tiene que persistir en el JSON');
    assert.equal(leido.editor.revision, 2);
    assert.ok(leido.editor.savedAt);
  } finally { deleteProject(p.id); }
});

// ------------------------------------------------ 5. EXCLUIR UNA ESCENA

test('excluir una escena la saca del montaje, de los subtítulos y del tiempo', () => {
  const p = proyectoDemo();
  p.scenes[1].excluida = true;

  assert.equal(activeScenes(p).length, 2);
  assert.equal(totalDuration(p), 10, '6 + 4, sin los 3 de la excluida');

  const cues = buildCues(p);
  const texto = cues.map(c => c.text).join(' ');
  assert.ok(!texto.includes('Segunda escena'), 'la escena excluida no puede tener subtítulo');
  assert.equal(cues.at(-1).end, 10, 'el último cue cierra en la nueva duración');
  assert.equal(verifyCaptionCoverage(p).ok, true);

  const d = derivar(p);
  assert.equal(d.duracion, 10);
  assert.equal(d.escenas[1].excluida, true, 'la escena sigue en la lista, marcada');
  assert.equal(d.escenas.length, 3, 'excluir no borra la escena');
});

test('excluir y volver a incluir deja todo como estaba', async () => {
  const p = proyectoDemo();
  saveProject(p);
  try {
    const rev = derivar(loadProject(p.id)).revision;
    await guardar(p.id, { revision: rev, scenes: [{ id: p.scenes[1].id, excluida: true }] });
    assert.equal(loadProject(p.id).scenes[1].excluida, true, 'la exclusión persiste');
    assert.equal(derivar(loadProject(p.id)).duracion, 10);

    const rev2 = derivar(loadProject(p.id)).revision;
    await guardar(p.id, { revision: rev2, scenes: [{ id: p.scenes[1].id, excluida: false }] });
    const vuelta = loadProject(p.id);
    assert.equal(vuelta.scenes[1].excluida, false);
    assert.equal(vuelta.scenes[1].text, p.scenes[1].text, 'el texto nunca se perdió');
    assert.equal(derivar(vuelta).duracion, 13);
  } finally { deleteProject(p.id); }
});

// ------------------------------------------------------- 6. FORMA DE ONDA

test('la forma de onda sale del audio real, y si no hay audio se dice', async (t) => {
  await fs.promises.mkdir(dir, { recursive: true });
  const wav = path.join(dir, 'tono.wav');
  // Dos segundos: uno con tono y otro en silencio. La envolvente tiene que
  // reflejarlo, que es la prueba de que se lee el archivo de verdad.
  await ffmpegRun(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=1',
    '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[a]', '-map', '[a]', wav]);

  const r = await peaks(wav, { muestras: 100 });
  assert.equal(r.disponible, true, r.motivo);
  assert.equal(r.picos.length, 100);
  assert.ok(r.segundos >= 1.8 && r.segundos <= 2.2, `duró ${r.segundos}`);

  const primeraMitad = r.picos.slice(5, 45).reduce((a, b) => a + b, 0) / 40;
  const segundaMitad = r.picos.slice(55, 95).reduce((a, b) => a + b, 0) / 40;
  assert.ok(primeraMitad > 0.5, `la parte con tono debe tener nivel · ${primeraMitad}`);
  assert.ok(segundaMitad < 0.05, `el silencio debe salir plano · ${segundaMitad}`);

  const noHay = await peaks(path.join(dir, 'no-existe.wav'));
  assert.equal(noHay.disponible, false);
  assert.deepEqual(noHay.picos, [], 'sin archivo NO se inventa una onda');
  assert.ok(noHay.motivo);
});

// ------------------------------------------------- 7. ALMACENAMIENTO

test('la capa de almacenamiento se puede sustituir sin tocar el editor', async () => {
  const original = getStorage();
  assert.equal(original.id, 'local-json');
  const d = original.describe();
  assert.match(d.proyectos, /data[/\\]projects/);
  assert.equal(d.atomico, true);

  // Un adaptador en memoria: es lo que haría falta para poner Supabase.
  const memoria = new Map();
  const falso = {
    id: 'memoria', label: 'En memoria',
    describe: () => ({ id: 'memoria', label: 'En memoria', remoto: false }),
    async list() { return [...memoria.values()].map(p => ({ id: p.id, title: p.title })); },
    async load(id) { return memoria.get(id) || null; },
    async save(p) { memoria.set(p.id, p); return p; },
    async remove(id) { return memoria.delete(id); },
  };
  try {
    setStorage(falso);
    const p = proyectoDemo();
    await getStorage().save(p);
    const r = await guardar(p.id, { revision: 1, title: 'Guardado en memoria' });
    assert.equal(r.proyecto.title, 'Guardado en memoria');
    assert.equal(memoria.get(p.id).title, 'Guardado en memoria', 'se escribió en el adaptador nuevo');
    assert.equal(fs.existsSync(path.join('data/projects', `${p.id}.json`)), false, 'no tocó el disco');
  } finally { setStorage(original); }

  assert.throws(() => setStorage({}), /load\(\) y save\(\)/);
});

// --------------------------------------------------------------- 8. HTTP

test('la API del editor responde y protege las escrituras', async (t) => {
  const p = proyectoDemo();
  saveProject(p);
  const server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const cfg = await (await fetch(`${base}/api/project-editor/config`)).json();
    assert.ok(cfg.captionStyle.presets.length >= 4);
    assert.ok(cfg.aspects['9:16']);

    const vista = await (await fetch(`${base}/api/project-editor/projects/${p.id}`)).json();
    assert.equal(vista.proyecto.id, p.id);
    assert.equal(vista.derivado.escenas.length, 3);

    // Sin la cabecera del editor, una escritura se rechaza.
    const sinCabecera = await fetch(`${base}/api/project-editor/projects/${p.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x' }),
    });
    assert.equal(sinCabecera.status, 403);

    const conCabecera = await fetch(`${base}/api/project-editor/projects/${p.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-editor-request': '1' },
      body: JSON.stringify({ revision: vista.derivado.revision, title: 'Desde HTTP' }),
    });
    assert.equal(conCabecera.status, 200);
    assert.equal((await conCabecera.json()).proyecto.title, 'Desde HTTP');

    const noExiste = await fetch(`${base}/api/project-editor/projects/vid_no_existe`);
    assert.equal(noExiste.status, 400);

    // El editor NO puede haber roto los endpoints que ya usaba el Orquestador.
    for (const ruta of ['/api/video-generation/config', '/api/analysis/config', '/api/studio/config']) {
      const r = await fetch(`${base}${ruta}`);
      assert.equal(r.status, 200, `${ruta} dejó de responder`);
    }

    // Y la pantalla de inicio se sigue sirviendo igual.
    const home = await fetch(`${base}/editor.html`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /¿Qué quieres hacer hoy\?/);
  } finally {
    await new Promise(r => server.close(r));
    deleteProject(p.id);
  }
});
