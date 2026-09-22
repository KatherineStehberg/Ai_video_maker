import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ffmpegRun, probeDuration, xfadeDisponibles } from '../src/lib/ffmpeg.js';
import {
  CATALOGO, CATEGORIAS, INESTABLES, DURACION, MAXIMO_POR_ESCENA,
  porId, filtrarDisponibles, normalizarTransicion, validarTransicion,
  transicionesDe, planDeMontaje,
} from '../src/project-editor/transitions.js';
import { makeProject, makeScene } from '../src/core/project.js';
import { catalogoTransiciones, guardar, derivar } from '../src/project-editor/service.js';
import { saveProject, loadProject, deleteProject } from '../src/core/project.js';

/**
 * TRANSICIONES ENTRE ESCENAS
 *
 * Lo que se prueba aqui no es que el desplegable tenga muchas opciones, sino
 * que cada opcion la sabe ejecutar ESTE FFmpeg, que la duracion del video no
 * cambia por ponerlas, y que lo que no se puede hacer sale marcado en vez de
 * fingido.
 */

const dir = path.resolve('.tmp/transitions-test');

const proyecto = (transiciones) => makeProject({
  title: 'Transiciones',
  aspectRatio: '16:9',
  scenes: transiciones.map((t, i) => ({ text: `Escena ${i + 1}.`, duration: 4, transition: t })),
});

// ------------------------------------------------------------- 1. CATALOGO

test('el catálogo declara familia y descripción en todas las transiciones', () => {
  const familias = new Set(CATEGORIAS.map(c => c.id));
  for (const t of CATALOGO) {
    assert.ok(t.id, 'una transición sin id');
    assert.ok(t.label, `${t.id} no tiene nombre`);
    assert.ok(t.descripcion, `${t.id} no explica qué hace`);
    assert.ok(familias.has(t.categoria), `${t.id} está en una familia que no existe: ${t.categoria}`);
  }
  assert.ok(CATALOGO.length > 40, `se esperaban muchas opciones y hay ${CATALOGO.length}`);
  assert.equal(CATALOGO.filter(t => t.xfade === null).length, 1, 'solo «sin transición» puede no tener filtro');
  // Los identificadores viajan al disco: cambiarlos rompería proyectos guardados.
  for (const id of ['none', 'fade', 'dissolve', 'slideleft', 'wipeleft', 'zoomin', 'fadeblack']) {
    assert.ok(porId(id), `${id} desapareció del catálogo y hay proyectos guardados con él`);
  }
});

test('lo que este FFmpeg no puede hacer se ofrece deshabilitado, no sustituido', async () => {
  const soportadas = await xfadeDisponibles();
  const catalogo = await catalogoTransiciones();

  for (const t of catalogo) {
    assert.equal(typeof t.disponible, 'boolean', `${t.id} no dice si está disponible`);
    if (!t.disponible) {
      assert.equal(t.etiqueta, 'Próximamente', `${t.id} no avisa de que no está`);
      assert.ok(t.motivo, `${t.id} no explica por qué no está`);
    }
  }
  // `squeezev` sale en la ayuda del filtro pero tumba el proceso al renderizar:
  // estar anunciada no basta.
  assert.ok(INESTABLES.squeezev, 'la reja de transiciones inestables se ha perdido');
  assert.equal(catalogo.find(t => t.id === 'squeezev').disponible, false);
  assert.ok(soportadas.includes('squeezev'), 'este caso deja de tener sentido si FFmpeg ya no la anuncia');
});

test('una transición inventada no se puede guardar', async () => {
  const p = proyecto(['none', 'none']);
  saveProject(p);
  try {
    const rev = derivar(loadProject(p.id)).revision;
    await assert.rejects(
      () => guardar(p.id, { revision: rev, scenes: [{ id: p.scenes[1].id, transition: { type: 'giro-3d' } }] }),
      /Transición no soportada/,
    );
    await assert.rejects(
      () => guardar(p.id, { revision: rev, scenes: [{ id: p.scenes[1].id, transition: { type: 'squeezev' } }] }),
      /Transición no soportada/,
      'una transición que tumba el render no puede llegar al proyecto',
    );
  } finally { deleteProject(p.id); }
});

// ------------------------------------------------------------ 2. CONTRATO

test('el contrato guardado es { type, duration, enabled } y admite lo antiguo', () => {
  // Antes se guardaba una cadena. Los proyectos viejos tienen que seguir abriendo.
  assert.deepEqual(normalizarTransicion('fade'), { type: 'fade', duration: DURACION.porDefecto, enabled: true });
  assert.deepEqual(normalizarTransicion('none'), { type: 'none', duration: 0, enabled: false });
  assert.deepEqual(normalizarTransicion(undefined), { type: 'none', duration: 0, enabled: false });
  // Una duración fuera de rango se acota; un tipo desconocido no se inventa.
  assert.equal(normalizarTransicion({ type: 'fade', duration: 99 }).duration, DURACION.max);
  assert.equal(normalizarTransicion({ type: 'fade', duration: 0 }).duration, DURACION.min);
  assert.equal(normalizarTransicion({ type: 'loquesea' }).type, 'none');
  // Y el modelo lo aplica al crear la escena.
  assert.deepEqual(makeScene({ text: 'x', transition: 'fade' }).transition,
    { type: 'fade', duration: DURACION.porDefecto, enabled: true });
});

test('la duración se valida contra las escenas vecinas, no en abstracto', () => {
  const t = { type: 'fade', duration: 2, enabled: true };
  // La primera escena no entra desde ninguna otra.
  assert.equal(validarTransicion(t, { esPrimera: true }).ok, false);
  // No puede ocupar más de la mitad de la escena más corta.
  const corta = validarTransicion(t, { duracionAnterior: 10, duracionActual: 2 });
  assert.equal(corta.transicion.duration, 2 * MAXIMO_POR_ESCENA);
  assert.match(corta.motivo, /mitad/);
  // Con escenas demasiado cortas, no hay transición posible y se dice.
  const imposible = validarTransicion(t, { duracionAnterior: 0.1, duracionActual: 0.1 });
  assert.equal(imposible.ok, false);
  assert.match(imposible.motivo, /demasiado cortas/);
  // Y lo que cabe, cabe entero.
  assert.equal(validarTransicion(t, { duracionAnterior: 8, duracionActual: 8 }).transicion.duration, 2);
});

test('excluir una escena reindexa las transiciones sin dejar ninguna huérfana', () => {
  const p = proyecto(['none', 'fade', 'wipeleft']);
  p.scenes[1].excluida = true;

  const trans = transicionesDe(p);
  assert.equal(trans.length, 1, 'la transición de la escena excluida desaparece');
  assert.equal(trans[0].type, 'wipeleft');
  // Ahora va de la 1 a la 2 del montaje, no de la 2 a la 3 del guion.
  assert.equal(trans[0].fromScene, 1);
  assert.equal(trans[0].toScene, 2);
  assert.equal(trans[0].fromSceneId, p.scenes[0].id);
  assert.equal(trans[0].toSceneId, p.scenes[2].id);
});

test('el plan de montaje conserva la duración total: el solape se renderiza de más', () => {
  const p = proyecto(['none', 'fade', 'wipeleft']);
  const plan = planDeMontaje(p);

  assert.equal(plan.total, 12, 'tres escenas de 4 s siguen siendo 12 s');
  assert.equal(plan.clips.length, 3);
  // Cada clip que ENTREGA una transición se alarga justo ese solape.
  assert.equal(plan.clips[0].render, 4 + DURACION.porDefecto);
  assert.equal(plan.clips[1].render, 4 + DURACION.porDefecto);
  assert.equal(plan.clips[2].render, 4, 'el último no entrega nada');
  // Y la suma de las duraciones PLANIFICADAS no cambia.
  assert.equal(plan.clips.reduce((a, c) => a + c.planificada, 0), plan.total);
});

// -------------------------------------------------------------- 3. RENDER

/** Cruza dos clips planos con `xfade`. Devuelve la duración real del montaje. */
async function cruzar(nombre, destino, { d = 0.4, offset = 0.6 } = {}) {
  const rojo = path.join(dir, 'rojo.mp4');
  const azul = path.join(dir, 'azul.mp4');
  await ffmpegRun([
    '-i', rojo, '-i', azul,
    '-filter_complex', `[0:v][1:v]xfade=transition=${nombre}:duration=${d}:offset=${offset}[v]`,
    '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', destino,
  ]);
  return probeDuration(destino);
}

test('TODAS las transiciones del catálogo se renderizan de verdad', { timeout: 600000 }, async (t) => {
  fs.mkdirSync(dir, { recursive: true });
  const rojo = path.join(dir, 'rojo.mp4');
  const azul = path.join(dir, 'azul.mp4');
  await ffmpegRun(['-f', 'lavfi', '-i', 'color=c=red:s=128x128:r=25:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', rojo]);
  await ffmpegRun(['-f', 'lavfi', '-i', 'color=c=blue:s=128x128:r=25:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', azul]);

  const catalogo = await catalogoTransiciones();
  const fallos = [];
  for (const ficha of catalogo) {
    if (!ficha.disponible || ficha.id === 'none') continue;
    const xfade = porId(ficha.id).xfade;
    try {
      const salida = path.join(dir, `${ficha.id}.mp4`);
      const dur = await cruzar(xfade, salida);
      // `xfade` entrega `offset` + lo que dure el segundo clip: el solape se
      // come el final del primero. Con offset 0,6 y un segundo clip de 1 s: 1,6 s.
      assert.ok(Math.abs(dur - 1.6) < 0.15, `${ficha.id} da ${dur} s en vez de 1,6`);
    } catch (e) {
      fallos.push(`${ficha.id}: ${e.message.split('\n')[0]}`);
    }
  }
  assert.deepEqual(fallos, [], `transiciones ofrecidas que NO se pueden renderizar:\n${fallos.join('\n')}`);
  t.diagnostic(`${catalogo.filter(x => x.disponible && x.id !== 'none').length} transiciones renderizadas`);
});

test('la transición aparece de verdad en el archivo, no solo en el ajuste', { timeout: 300000 }, async () => {
  fs.mkdirSync(dir, { recursive: true });
  const salida = path.join(dir, 'comprobacion.mp4');
  await cruzar('fade', salida);

  // A mitad de la transición el cuadro no puede ser NI el rojo NI el azul: si
  // lo fuera, habría un corte seco con el ajuste puesto, que es justo el fallo
  // que se quiere descartar.
  const medio = path.join(dir, 'medio.png');
  await ffmpegRun(['-i', salida, '-ss', '0.8', '-frames:v', '1', '-vf', 'scale=1:1', medio]);
  const crudo = path.join(dir, 'medio.raw');
  await ffmpegRun(['-i', medio, '-vf', 'format=rgb24', '-f', 'rawvideo', crudo]);
  const [r, , b] = fs.readFileSync(crudo);

  assert.ok(r > 20 && b > 20, `a mitad de fundido se ve un color puro (r=${r} b=${b}): no hay transición real`);
});

test('un montaje con transiciones dura lo mismo que sin ellas', { timeout: 300000 }, async () => {
  fs.mkdirSync(dir, { recursive: true });
  const clip = async (color, segundos, destino) => {
    await ffmpegRun(['-f', 'lavfi', '-i', `color=c=${color}:s=128x128:r=25:d=${segundos}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', destino]);
    return destino;
  };
  // Las escenas duran 2 s; la primera se renderiza 0,5 s más larga porque
  // entrega el solape. Al cruzarlas, el total tiene que volver a ser 4 s.
  const a = await clip('red', 2.5, path.join(dir, 'largo_a.mp4'));
  const b = await clip('blue', 2, path.join(dir, 'largo_b.mp4'));
  const salida = path.join(dir, 'total.mp4');
  await ffmpegRun([
    '-i', a, '-i', b,
    '-filter_complex', '[0:v][1:v]xfade=transition=slideleft:duration=0.5:offset=2[v]',
    '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', salida,
  ]);
  const dur = await probeDuration(salida);
  assert.ok(Math.abs(dur - 4) < 0.1, `el video mide ${dur} s y debería medir 4: la transición está robando tiempo`);
});
