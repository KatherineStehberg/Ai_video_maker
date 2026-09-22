import test from 'node:test';
import assert from 'node:assert/strict';

import { palabrasClave, busquedaDeEscena } from '../src/core/keywords.js';
import { keywordsFrom } from '../src/core/script-generator.js';
import { makeProject, saveProject, loadProject, deleteProject } from '../src/core/project.js';
import { derivar } from '../src/project-editor/service.js';

/**
 * QUE IMAGEN BUSCAR PARA CADA ESCENA
 *
 * El fallo que se corrige aqui: la sugerencia eran las primeras palabras largas
 * de la frase, asi que salia el principio del texto y no su asunto. Las pruebas
 * comprueban lo que de verdad importa —que gane el sustantivo del que trata la
 * escena— y no una cadena exacta, que seria fragil sin aportar nada.
 */

const GUION = [
  'Antes de empezar conviene tener claro a donde queremos llegar con la sesion.',
  'La narracion y los subtitulos hacen que funcione sin sonido.',
  'Respira hondo y deja que la luz del amanecer entre despacio en tu cuerpo.',
  'La mayoria graba con el telefono y se queda ahi.',
  'Dios camina contigo incluso cuando el camino se vuelve oscuro.',
];
const otras = frase => GUION.filter(f => f !== frase);

test('gana el asunto de la escena, no el principio de la frase', () => {
  const r = palabrasClave(GUION[2], { contexto: otras(GUION[2]) });
  assert.ok(r.includes('amanecer'), `se esperaba «amanecer» y salió: ${r.join(' ')}`);
  assert.ok(r.includes('luz'), `«luz» es lo más visual de la frase y se perdió: ${r.join(' ')}`);
  // Lo que antes salía primero: adverbios y verbos.
  for (const mala of ['respira', 'hondo', 'deja', 'despacio']) {
    assert.ok(!r.includes(mala), `«${mala}» no describe ninguna imagen`);
  }
});

test('los verbos y las muletillas no llegan a la sugerencia', () => {
  const casos = [
    [GUION[0], ['empezar', 'conviene', 'tener', 'claro', 'queremos', 'antes']],
    [GUION[3], ['graba', 'mayoria', 'queda', 'ahi']],
  ];
  for (const [frase, prohibidas] of casos) {
    const r = palabrasClave(frase, { contexto: otras(frase) });
    for (const mala of prohibidas) {
      assert.ok(!r.includes(mala), `«${mala}» salió en «${frase.slice(0, 40)}…»: ${r.join(' ')}`);
    }
  }
  // Y lo que sí describe la escena, sigue ahí.
  assert.ok(palabrasClave(GUION[3], { contexto: otras(GUION[3]) }).includes('telefono'));
});

test('las palabras cortas y visuales sobreviven', () => {
  // El filtro antiguo exigía más de tres letras y se llevaba por delante justo
  // las más visuales.
  for (const corta of ['luz', 'sol', 'mar', 'paz']) {
    const r = palabrasClave(`Mira el ${corta} de la mañana.`);
    assert.ok(r.includes(corta), `«${corta}» debería valer para buscar una imagen`);
  }
});

test('los nombres propios cuentan aunque abran la frase', () => {
  const r = palabrasClave(GUION[4], { contexto: otras(GUION[4]) });
  assert.ok(r.includes('dios'), `un nombre propio es de lo más concreto que hay: ${r.join(' ')}`);
  const chile = palabrasClave('En Chile la primavera empieza en septiembre.');
  assert.ok(chile.includes('chile'));
});

test('lo que se repite en todo el guion no distingue a una escena', () => {
  // «meditacion» está en las cuatro: no dice nada de ninguna en concreto.
  const guion = [
    'La meditacion empieza mirando la vela encendida.',
    'La meditacion sigue con el sonido del cuenco.',
    'La meditacion continua atento a la respiracion.',
    'La meditacion termina con el silencio del jardin.',
  ];
  const primera = palabrasClave(guion[0], { contexto: guion.slice(1), max: 1 });
  assert.deepEqual(primera, ['vela'], `debería destacar lo propio de la escena: ${primera.join(' ')}`);
});

test('sin nada que decir no se inventa una búsqueda', () => {
  assert.equal(busquedaDeEscena(''), '');
  assert.equal(busquedaDeEscena('   '), '');
  assert.equal(busquedaDeEscena('Y entonces, claro, pues eso.'), '');
});

test('una escena pobre se apoya en el tema del video, y solo entonces', () => {
  const pobre = busquedaDeEscena('Aquí está el resultado.', { tema: 'taller de cocina' });
  assert.match(pobre, /cocina|taller/, `sin sustantivos propios debería apoyarse en el tema: «${pobre}»`);
  // Con material propio suficiente, el tema no se cuela: si no, todas las
  // escenas acabarían buscando lo mismo.
  const rica = busquedaDeEscena('La luz del amanecer entra por la ventana.', { tema: 'taller de cocina' });
  assert.ok(!/cocina/.test(rica), `el tema no debería pisar a la escena: «${rica}»`);
});

test('keywordsFrom sigue existiendo y ya no devuelve el principio de la frase', () => {
  const r = keywordsFrom(GUION[0]);
  assert.equal(typeof r, 'string');
  assert.ok(!r.startsWith('antes empezar'), `volvió el comportamiento antiguo: «${r}»`);
});

test('el editor ofrece la sugerencia sin escribirla en el proyecto', () => {
  const p = makeProject({
    title: 'Meditación diaria',
    scenes: GUION.map(text => ({ text, duration: 4 })),
  });
  saveProject(p);
  try {
    const d = derivar(loadProject(p.id));
    const escena = d.escenas[2];
    assert.ok(escena.visualPromptSugerido.includes('amanecer'), escena.visualPromptSugerido);
    // Ofrecida, no aplicada: el campo sigue vacío hasta que la usuaria acepte.
    assert.equal(loadProject(p.id).scenes[2].visualPrompt, '');
    assert.equal(escena.visualPrompt, '');
  } finally { deleteProject(p.id); }
});
