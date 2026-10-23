import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { listarSfx, creditoDeSfx, CATEGORIAS_SFX, dirSfx } from '../src/project-editor/media-library.js';
import { planDeMezcla, normalizarEfecto, VOLUMEN_POR_DEFECTO, EFECTO_MAX_SEGUNDOS } from '../src/project-editor/audio.js';
import { makeProject, saveProject, loadProject, deleteProject } from '../src/core/project.js';
import { guardar, derivar } from '../src/project-editor/service.js';

/**
 * BIBLIOTECA DE EFECTOS DE SONIDO
 *
 * La regla que se prueba aqui por encima de todo: un archivo SIN licencia
 * declarada no se ofrece y no se puede usar. Lo demas (buscar, filtrar, anclar
 * a una escena) es comodidad; esto es lo que evita meter en un video algo que
 * no se puede publicar.
 *
 * Estas pruebas existen porque `listarSfx` se publicó con un fallo que la tumbaba
 * entera (una función auxiliar que no llegó al archivo) y nada lo detectó: la
 * biblioteca se veía vacía en el navegador y no había forma de saber por qué.
 */

const tmp = path.resolve('.tmp/sfx-test');

// ------------------------------------------------------------ 1. BIBLIOTECA

test('la biblioteca local lista los efectos con su ficha completa', async () => {
  const r = await listarSfx({});
  assert.ok(r.efectos.length >= 6, `se esperaban los 6 efectos generados y hay ${r.efectos.length}`);

  for (const e of r.efectos) {
    // Los diez datos de la ficha que la interfaz enseña.
    assert.ok(e.titulo, `${e.path} sin nombre`);
    assert.ok(e.categoria, `${e.titulo} sin categoría`);
    assert.ok(e.duracion > 0, `${e.titulo} sin duración`);
    assert.ok(e.formato, `${e.titulo} sin formato`);
    assert.ok(e.volumenSugerido > 0, `${e.titulo} sin volumen recomendado`);
    assert.ok(e.licencia, `${e.titulo} SIN LICENCIA: no debería ofrecerse`);
    assert.ok(e.fuente, `${e.titulo} sin fuente`);
    assert.ok(e.autor, `${e.titulo} sin autor`);
    assert.ok(e.incorporado, `${e.titulo} sin fecha de incorporación`);
    assert.ok('licenciaUrl' in e, `${e.titulo} sin campo de URL de atribución`);
    assert.match(e.licencia, /CC0/, `${e.titulo} no es de dominio público: ${e.licencia}`);
  }
});

test('se puede filtrar por categoría y buscar por palabra', async () => {
  const todas = await listarSfx({});
  const familias = new Set(CATEGORIAS_SFX.map(c => c.id));
  for (const e of todas.efectos) assert.ok(familias.has(e.categoria), `categoría desconocida: ${e.categoria}`);

  const transiciones = await listarSfx({ categoria: 'transicion' });
  assert.ok(transiciones.efectos.length > 0);
  assert.ok(transiciones.efectos.every(e => e.categoria === 'transicion'));

  // La búsqueda ignora acentos y mayúsculas: se busca como se habla.
  const conAcento = await listarSfx({ consulta: 'TRANSICIÓN' });
  assert.ok(conAcento.efectos.length > 0, 'buscar con acento y en mayúsculas no encuentra nada');
});

test('un archivo sin ficha de licencia no se ofrece, y se dice por qué', async () => {
  fs.mkdirSync(tmp, { recursive: true });
  const conFicha = path.join(tmp, 'legal.wav');
  const sinFicha = path.join(tmp, 'sospechoso.wav');
  fs.writeFileSync(conFicha, Buffer.alloc(64));
  fs.writeFileSync(sinFicha, Buffer.alloc(64));
  fs.writeFileSync(`${conFicha}.json`, JSON.stringify({
    titulo: 'Legal', categoria: 'interfaz', licencia: 'CC0 1.0', fuente: 'generado aquí',
  }), 'utf8');

  try {
    const r = await listarSfx({ dir: tmp });
    assert.deepEqual(r.efectos.map(e => e.titulo), ['Legal']);
    assert.equal(r.rechazadas.length, 1);
    assert.equal(r.rechazadas[0].archivo, 'sospechoso.wav');
    assert.match(r.rechazadas[0].motivo, /licencia/i, 'hay que decir POR QUÉ no se ofrece');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('solo se acepta un efecto de la biblioteca, y con licencia', async () => {
  const r = await listarSfx({});
  const bueno = r.efectos[0];
  const credito = creditoDeSfx(bueno.path);
  assert.equal(credito.proveedor, 'local');
  assert.ok(credito.licencia && credito.fuente);

  // Fuera de la carpeta de efectos no vale, exista o no el archivo.
  assert.throws(() => creditoDeSfx('data/assets/music/calma-luminosa.mp3'), /biblioteca de efectos/);
  assert.throws(() => creditoDeSfx('../fuera.wav'), /biblioteca de efectos/);
  assert.throws(() => creditoDeSfx(`${dirSfx()}/no-existe.wav`), /no existe|biblioteca/);
});

// -------------------------------------------------------------- 2. MODELO

test('un efecto se ancla a una escena y a un segundo dentro de ella', () => {
  const e = normalizarEfecto({ path: 'data/assets/sfx/click.wav', sceneId: 'sc_1', start: 2.5 });
  assert.equal(e.sceneId, 'sc_1');
  assert.equal(e.start, 2.5);
  assert.equal(e.volume, VOLUMEN_POR_DEFECTO.efecto);
  assert.equal(e.enabled, true);
  assert.equal(e.duration, null, 'sin duración declarada, suena entero');
  assert.ok(e.id, 'cada efecto necesita id propio para poder quitarlo');

  // Los límites se aplican, no se confía en lo que llegue.
  assert.equal(normalizarEfecto({ path: 'x', volume: 99 }).volume, 2);
  assert.equal(normalizarEfecto({ path: 'x', volume: -5 }).volume, 0);
  assert.equal(normalizarEfecto({ path: 'x', duration: 999 }).duration, EFECTO_MAX_SEGUNDOS);
});

test('el plan de mezcla coloca cada efecto en su segundo del video', async () => {
  const r = await listarSfx({});
  const fx = r.efectos[0].path;
  const p = makeProject({
    title: 'mezcla',
    scenes: [
      { text: 'Uno.', duration: 4 },
      { text: 'Dos.', duration: 4 },
      { text: 'Tres.', duration: 4 },
    ],
  });
  // Anclado a la TERCERA escena, 1 s después de que empiece: segundo 9 del video.
  p.sfx = [normalizarEfecto({ path: fx, sceneId: p.scenes[2].id, start: 1 })];

  const plan = planDeMezcla(p, { existe: () => true });
  const efecto = plan.fuentes.find(f => f.tipo === 'efecto');
  assert.ok(efecto, `el efecto no entró en la mezcla: ${JSON.stringify(plan.descartadas)}`);
  assert.equal(efecto.start, 9);

  // Excluir una escena ANTERIOR lo adelanta: sigue pegado a la suya.
  p.scenes[0].excluida = true;
  assert.equal(planDeMezcla(p, { existe: () => true }).fuentes.find(f => f.tipo === 'efecto').start, 5);

  // Excluir SU escena lo saca del video, y se dice por qué.
  p.scenes[2].excluida = true;
  const sin = planDeMezcla(p, { existe: () => true });
  assert.equal(sin.fuentes.filter(f => f.tipo === 'efecto').length, 0);
  assert.match(sin.descartadas.find(d => d.tipo === 'efecto').motivo, /excluida/);
});

test('silenciar una pista no silencia las demás', async () => {
  const r = await listarSfx({});
  const p = makeProject({ title: 'silencios', scenes: [{ text: 'Uno.', duration: 5 }] });
  p.music = { ...p.music, path: 'data/assets/music/calma-luminosa.mp3', enabled: true, volume: 0.2 };
  p.sfx = [normalizarEfecto({ path: r.efectos[0].path, sceneId: p.scenes[0].id, start: 0 })];

  const conTodo = planDeMezcla(p, { narracion: { path: 'voz.wav' }, existe: () => true });
  assert.equal(conTodo.fuentes.length, 3, 'narración + música + efecto');
  assert.equal(conTodo.necesitaLimitador, true, 'con tres pistas hay que evitar el recorte digital');

  // Silenciar la música deja voz y efecto intactos.
  p.music.enabled = false;
  const sinMusica = planDeMezcla(p, { narracion: { path: 'voz.wav' }, existe: () => true });
  assert.deepEqual(sinMusica.fuentes.map(f => f.tipo).sort(), ['efecto', 'narracion']);
  assert.match(sinMusica.descartadas.find(d => d.tipo === 'musica').motivo, /silenciada/);
  assert.equal(sinMusica.hayAudio, true);
});

// --------------------------------------------------------- 3. PERSISTENCIA

test('el efecto elegido se guarda con su licencia y sobrevive a recargar', async () => {
  const r = await listarSfx({});
  const elegido = r.efectos.find(e => e.categoria === 'transicion');
  const p = makeProject({ title: 'persistencia', scenes: [{ text: 'Uno.', duration: 5 }] });
  saveProject(p);

  try {
    const rev = derivar(loadProject(p.id)).revision;
    await guardar(p.id, {
      revision: rev,
      sfx: [{ path: elegido.path, sceneId: p.scenes[0].id, start: 1.2, volume: 0.5 }],
    });

    // Lo que importa es lo que quedó EN DISCO, no lo que devolvió la llamada.
    const disco = loadProject(p.id);
    assert.equal(disco.sfx.length, 1);
    assert.equal(disco.sfx[0].start, 1.2);
    assert.equal(disco.sfx[0].volume, 0.5);
    // El crédito lo pone el backend desde la ficha del disco, no el navegador.
    assert.equal(disco.sfx[0].credit.licencia, elegido.licencia);
    assert.equal(disco.sfx[0].titulo, elegido.titulo);

    // Y la línea de tiempo lo sitúa donde va.
    const linea = derivar(disco).linea;
    assert.equal(linea.efectos.length, 1);
    assert.equal(linea.efectos[0].start, 1.2);
    assert.equal(linea.efectos[0].sinLicencia, false);
    // Sin analizar el archivo no se dibuja onda: no se inventan.
    assert.equal(linea.efectos[0].onda, null);
  } finally { deleteProject(p.id); }
});

test('no se puede colar un efecto de fuera de la biblioteca', async () => {
  const p = makeProject({ title: 'intruso', scenes: [{ text: 'Uno.', duration: 5 }] });
  saveProject(p);
  try {
    const rev = derivar(loadProject(p.id)).revision;
    await assert.rejects(
      () => guardar(p.id, { revision: rev, sfx: [{ path: 'data/assets/music/calma-luminosa.mp3' }] }),
      /biblioteca de efectos/,
    );
    await assert.rejects(
      () => guardar(p.id, { revision: rev, sfx: [{ path: '../../windows/system32/algo.wav' }] }),
      /biblioteca de efectos/,
    );
    assert.deepEqual(loadProject(p.id).sfx, [], 'nada de eso llegó al proyecto');
  } finally { deleteProject(p.id); }
});
