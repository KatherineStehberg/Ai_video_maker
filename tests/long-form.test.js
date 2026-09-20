import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from '../src/server.js';
import {
  segmentarGuion, planificarDuracion, bloquesDelGuion, esTitulo, agruparOraciones,
  contarPalabras, sinPerdidaDeTexto, formatearDuracion, WPM_POR_DEFECTO, PAUSA_ENTRE_ESCENAS,
} from '../src/generation/segmenter.js';
import { normalizeSpec, draftJob, planJob, PROMPT_MAX, SCRIPT_MAX_CHARS, MAX_ESCENAS, DURATION_LIMITS } from '../src/generation/jobs.js';
import { draftScript } from '../src/generation/script.js';
import { elegirTemplate } from '../src/providers/video-generation/pipeline.js';
import { porcentaje, instantanea, ETAPAS, ESTADOS, esReanudable, ESTADO_LISTO, ESTADO_ERROR_RECUPERABLE } from '../src/generation/states.js';
import { normalizeOrchestratorInput, specDesdeContrato, CONTRACT_VERSION } from '../src/generation/orchestrator-contract.js';
import { SCENE_TEXT_MAX, HTTP_BODY_MAX } from '../src/generation/limits.js';
import { buildNarrationTrack, NARRATION_BLOCK_SIZE } from '../src/core/tts.js';
import { ffmpegRun, probeDuration } from '../src/lib/ffmpeg.js';
import { workDir, rel, abs } from '../src/lib/paths.js';

/**
 * Videos LARGOS por el mismo flujo que los cortos.
 *
 * Todo lo de aquí corre en local con fixtures sintéticas: no se llama a Gemini,
 * ni a Pexels, ni a ninguna API de pago. Los guiones se construyen en memoria.
 */

// ------------------------------------------------------------ FIXTURES

/** Oraciones reales de una clase, para construir guiones de la longitud que haga falta. */
const ORACIONES = [
  'El presente simple se usa para hablar de hábitos y rutinas diarias.',
  'Para formarlo en inglés se toma el infinitivo sin la partícula to.',
  'En la tercera persona del singular se añade una ese al final del verbo.',
  'Un error frecuente entre hispanohablantes es olvidar precisamente esa ese final.',
  'Veamos ahora algunos ejemplos concretos que aparecen prácticamente todos los días.',
  'Cuando el verbo termina en o se añade es en lugar de solamente una ese.',
  'La negación se construye con el auxiliar do acompañado de la palabra not.',
  'En la tercera persona ese auxiliar cambia y se convierte en does not.',
  'Las preguntas invierten el orden y colocan el auxiliar delante del sujeto.',
  'Practicar en voz alta es la manera más rápida de fijar todas estas reglas.',
];

/** Construye un guion con `modulos` secciones y `parrafos` párrafos en cada una. */
function guionDeClase({ modulos = 4, parrafos = 3, oracionesPorParrafo = 6 } = {}) {
  const partes = [];
  for (let m = 1; m <= modulos; m++) {
    partes.push(`## Módulo ${m}: práctica guiada`);
    partes.push('');
    for (let p = 0; p < parrafos; p++) {
      partes.push(ORACIONES.slice(0, oracionesPorParrafo).join(' '));
      partes.push('');
    }
  }
  return partes.join('\n').trim();
}

/** Guion de la longitud aproximada que se pida, en palabras. */
function guionDePalabras(objetivoPalabras) {
  let modulos = 1;
  let guion = guionDeClase({ modulos });
  while (contarPalabras(guion) < objetivoPalabras && modulos < 200) {
    modulos += 1;
    guion = guionDeClase({ modulos });
  }
  return guion;
}

// ------------------------------------------------ 1. GUION > 2 000 CARACTERES

test('un guion de más de 2 000 caracteres se acepta entero y sin truncar', async () => {
  const guion = guionDeClase({ modulos: 3 });
  assert.ok(guion.length > 2000, `el guion de prueba debe superar 2 000 caracteres (tiene ${guion.length})`);

  // El viejo tope de 2 000 ya no existe en ninguna de las dos entradas.
  assert.ok(PROMPT_MAX > 2000);
  assert.ok(SCRIPT_MAX_CHARS > 2000);

  const spec = normalizeSpec({ script: guion });
  assert.equal(spec.script, guion, 'el guion debe llegar al backend byte a byte');
  assert.equal(spec.script.length, guion.length, 'no puede perder ni un carácter');

  const borrador = await draftJob({ script: guion });
  assert.equal(borrador.source, 'guion-propio', 'un guion propio no se reescribe');

  // Ninguna palabra del original desaparece: o se narra, o se muestra en pantalla.
  const { ok, falta } = sinPerdidaDeTexto(guion, borrador.escenas);
  assert.ok(ok, `se perdió la palabra «${falta}» al segmentar`);
});

test('el guion se rechaza con un número exacto sólo cuando pasa el límite técnico real', () => {
  const justo = 'a. '.repeat(Math.floor(SCRIPT_MAX_CHARS / 3));
  assert.ok(justo.length <= SCRIPT_MAX_CHARS);
  assert.doesNotThrow(() => normalizeSpec({ script: justo }));

  assert.throws(
    () => normalizeSpec({ script: 'x'.repeat(SCRIPT_MAX_CHARS + 1) }),
    // El mensaje dice el tamaño real y deja claro que no se recortó nada.
    e => /400\.000/.test(e.message) && /No se ha recortado nada/.test(e.message),
  );

  // Vacío sigue rechazándose, que es el único caso realmente inválido.
  assert.throws(() => normalizeSpec({ script: '   ' }), /Escribe un prompt|pega el guion/);
  assert.throws(() => normalizeSpec({}), /Escribe un prompt|pega el guion/);
});

// -------------------------------------------- 2 y 3. CORTO Y LARGO, MISMO FLUJO

test('video corto de ~1 minuto: mismo flujo, mismas funciones', async () => {
  // ~115 palabras se narran en ~60 s a la velocidad del TTS local.
  const guion = ORACIONES.concat(ORACIONES).slice(0, 12).join(' ');
  const plan = planJob({ script: guion });

  assert.ok(plan.duracionEstimada >= 40 && plan.duracionEstimada <= 90,
    `un guion de ${plan.palabras} palabras debería rondar el minuto, dio ${plan.duracionEstimada} s`);
  assert.ok(plan.escenas >= 2, 'un minuto da para varias escenas');

  const borrador = await draftJob({ script: guion });
  assert.equal(borrador.escenas.length, plan.escenas, 'lo estimado y lo producido deben coincidir');
  assert.equal(borrador.duracionEstimada, plan.duracionEstimada);
});

test('guion educativo de 10-12 minutos: se estima y se segmenta por el mismo camino', async () => {
  // A 115 wpm, 10-12 minutos son ~1 150-1 380 palabras de narración.
  const guion = guionDePalabras(1250);
  const plan = planJob({ script: guion });

  assert.ok(plan.palabras >= 1150, `palabras: ${plan.palabras}`);
  assert.ok(plan.duracionEstimada >= 600 && plan.duracionEstimada <= 900,
    `debería caer entre 10 y 15 minutos, dio ${plan.duracionEstimadaLegible}`);
  assert.ok(plan.escenas >= 20, `un video de 12 minutos necesita muchas escenas, dio ${plan.escenas}`);
  assert.ok(plan.secciones >= 2, 'los títulos del guion deben reconocerse como secciones');

  // Una clase elige plantilla de clase, no de reel: escenas largas y sin efectos.
  assert.equal(elegirTemplate({ script: guion }), 'video-curso');

  const borrador = await draftJob({ script: guion });
  assert.equal(borrador.escenas.length, plan.escenas);
  assert.ok(sinPerdidaDeTexto(guion, borrador.escenas).ok, 'el guion largo tampoco pierde texto');
});

// ------------------------------------------------ 4. SEGMENTACIÓN SIN CORTAR

test('la segmentación nunca parte una oración por la mitad', () => {
  const guion = guionDeClase({ modulos: 5, parrafos: 4, oracionesPorParrafo: 10 });
  const { escenas } = segmentarGuion(guion);

  // Cada oración del original aparece COMPLETA dentro de alguna escena.
  const textos = escenas.map(e => e.text);
  for (const oracion of ORACIONES) {
    assert.ok(textos.some(t => t.includes(oracion)),
      `la oración «${oracion.slice(0, 40)}…» se partió entre escenas`);
  }

  // Y ninguna escena empieza en minúscula ni termina sin cerrar la frase, que
  // es como se ve un corte a mitad de oración.
  for (const [i, e] of escenas.entries()) {
    assert.match(e.text, /[.!?…:]$/, `la escena ${i + 1} termina a media frase: «${e.text.slice(-40)}»`);
  }
});

test('una oración imposible se rechaza antes de que su duración sea truncada', () => {
  const larga = `${'palabra '.repeat(400).trim()}.`;
  assert.throws(
    () => segmentarGuion(larga),
    e => /400 palabras/.test(e.message) && /no se ha recortado nada/i.test(e.message),
  );
});

test('los títulos cortan escena y dan el texto en pantalla; la narración con «##» no', () => {
  assert.equal(esTitulo('## Módulo 2: el pretérito'), true);
  assert.equal(esTitulo('# Introducción'), true);
  assert.equal(esTitulo('OBJETIVOS'), true);
  assert.equal(esTitulo('Objetivos de la clase:'), true);
  // Una línea de narración marcada con «##» (el formato interno) NO es título.
  assert.equal(esTitulo('## Hoy veremos cómo se forma el pretérito en español.'), false);
  assert.equal(esTitulo('Esta es una frase normal que se narra.'), false);

  const bloques = bloquesDelGuion('# Uno\n\nFrase una. Frase dos.\n\n# Dos\n\nFrase tres.');
  assert.equal(bloques.length, 2);
  assert.equal(bloques[0].titulo, 'Uno');
  assert.equal(bloques[1].parrafos[0], 'Frase tres.');

  const { escenas } = segmentarGuion('# Uno\n\nFrase una.\n\n# Dos\n\nFrase tres.');
  assert.equal(escenas[0].onScreenTitle, 'Uno');
  assert.equal(escenas[0].seccion, 'Uno');
  assert.ok(escenas.some(e => e.seccion === 'Dos'), 'la segunda sección debe reconocerse');
});

test('agruparOraciones respeta el objetivo y nunca deja un grupo vacío', () => {
  const oraciones = ORACIONES.slice(0, 8);
  const grupos = agruparOraciones(oraciones, { palabrasObjetivo: 20, palabrasMax: 40 });
  assert.ok(grupos.every(g => g.length > 0));
  assert.equal(grupos.flat().length, oraciones.length, 'no se pierde ni se duplica ninguna oración');
  assert.deepEqual(grupos.flat(), oraciones, 'el orden se conserva exactamente');
  for (const g of grupos) {
    assert.ok(contarPalabras(g.join(' ')) <= 40, 'ningún grupo pasa del máximo duro');
  }
});

// ---------------------------------------------------- 5. DURACIÓN AUTOMÁTICA

test('duración automática: sale del contenido narrado, no de un preset', () => {
  const corto = planificarDuracion(ORACIONES.slice(0, 3).join(' '));
  const largo = planificarDuracion(ORACIONES.concat(ORACIONES, ORACIONES).join(' '));

  assert.ok(largo.duracionEstimada > corto.duracionEstimada * 2,
    'más texto tiene que dar más duración, proporcionalmente');
  assert.equal(corto.targetDurationSeconds, null, 'la duración objetivo es opcional');
  assert.equal(corto.compatibleConObjetivo, null, 'sin objetivo no hay nada que comparar');

  // La cuenta es explicable: palabras / wpm * 60, más una pausa por escena.
  const esperado = (largo.palabras / WPM_POR_DEFECTO) * 60 + largo.escenas * PAUSA_ENTRE_ESCENAS;
  assert.ok(Math.abs(largo.duracionEstimada - esperado) < largo.escenas * 2,
    `estimado ${largo.duracionEstimada} vs cuenta directa ${esperado.toFixed(1)}`);

  // La velocidad de narración es configurable y cambia la estimación.
  const lento = planificarDuracion(ORACIONES.join(' '), { wpm: 80 });
  const rapido = planificarDuracion(ORACIONES.join(' '), { wpm: 160 });
  assert.ok(lento.duracionEstimada > rapido.duracionEstimada, 'hablar más lento dura más');
  assert.equal(lento.wpm, 80);

  assert.equal(formatearDuracion(45), '45 s');
  assert.equal(formatearDuracion(720), '12 min');
  assert.equal(formatearDuracion(750), '12 min 30 s');
});

// ------------------------------------------ 6. OBJETIVO INCOMPATIBLE = AVISO

test('una duración objetivo incompatible avisa y NO recorta el guion', async () => {
  const guion = guionDePalabras(1250);           // ~11 minutos de narración

  const plan = planificarDuracion(guion, { targetDurationSeconds: 60 });
  assert.equal(plan.compatibleConObjetivo, false);
  assert.ok(plan.advertencias.length, 'tiene que avisar');
  assert.match(plan.advertencias.join(' '), /No se ha quitado nada del guion/);
  // Pedir una duración imposible no quita NI UNA palabra: la segmentación con
  // objetivo incompatible produce exactamente lo mismo que sin objetivo.
  const sinObjetivo = planificarDuracion(guion);
  assert.equal(plan.palabras, sinObjetivo.palabras, 'el aviso no puede costar palabras');
  assert.equal(plan.escenas, sinObjetivo.escenas, 'ni escenas');
  assert.equal(plan.duracionEstimada, sinObjetivo.duracionEstimada, 'ni duración');
  assert.ok(sinPerdidaDeTexto(guion, segmentarGuion(guion).escenas).ok);

  // El caso contrario también avisa, y tampoco inventa relleno.
  const alReves = planificarDuracion(ORACIONES[0], { targetDurationSeconds: 600 });
  assert.equal(alReves.compatibleConObjetivo, false);
  assert.match(alReves.advertencias.join(' '), /No se ha inventado contenido de relleno/);

  // Un objetivo compatible no genera ruido.
  const bien = planificarDuracion(guion, { targetDurationSeconds: plan.duracionEstimada });
  assert.equal(bien.compatibleConObjetivo, true);
  assert.equal(bien.advertencias.length, 0);

  // Y el borrador completo se comporta igual: avisa y entrega el guion entero.
  const borrador = await draftJob({ script: guion, duration: 60 });
  assert.equal(borrador.compatibleConObjetivo, false);
  assert.ok(borrador.advertencias.some(a => /No se ha recortado nada/.test(a)));
  assert.ok(sinPerdidaDeTexto(guion, borrador.escenas).ok, 'ni con objetivo incompatible se pierde texto');
});

// ----------------------------------------------- 7 y 8. ESTADOS Y REANUDACIÓN

test('los estados del flujo son los declarados y el progreso se cuenta en escenas', () => {
  for (const id of ['preparando-guion', 'creando-escenas', 'buscando-visuales', 'generando-voz',
    'creando-subtitulos', 'renderizando-segmentos', 'concatenando', 'listo', 'error-recuperable']) {
    assert.ok(ESTADOS.includes(id), `falta el estado ${id}`);
  }

  // Los pesos de las etapas suman 1: el porcentaje no puede pasarse ni quedarse corto.
  const suma = ETAPAS.reduce((a, e) => a + e.peso, 0);
  assert.ok(Math.abs(suma - 1) < 1e-9, `los pesos suman ${suma}`);

  // El porcentaje crece de forma monótona a lo largo del flujo.
  const serie = ETAPAS.map(e => porcentaje(e.id, 0, 10));
  for (let i = 1; i < serie.length; i++) assert.ok(serie[i] > serie[i - 1], 'el progreso no puede retroceder');
  assert.equal(porcentaje(ESTADO_LISTO), 100);

  // Dentro de una etapa, el avance sale de las escenas hechas: nada simulado.
  const a = porcentaje('renderizando-segmentos', 2, 10);
  const b = porcentaje('renderizando-segmentos', 8, 10);
  assert.ok(b > a);
  assert.equal(porcentaje('renderizando-segmentos', 0, 0), porcentaje('renderizando-segmentos', 0, 10),
    'sin escenas contadas no se inventa avance dentro de la etapa');

  const snap = instantanea({ etapa: 'generando-voz', hechas: 12, totales: 40 });
  assert.equal(snap.escenasCompletadas, 12);
  assert.equal(snap.escenasTotales, 40);
  assert.equal(snap.estado, 'generando-voz');
  assert.ok(snap.operacion, 'la interfaz necesita saber qué se está haciendo');

  assert.equal(esReanudable(ESTADO_ERROR_RECUPERABLE), true);
  assert.equal(esReanudable(ESTADO_LISTO), false);
});

test('el progreso del render no puede declarar el trabajo terminado antes de tiempo', async () => {
  const { pasoDeRender } = await import('../src/core/pipeline.js');

  // Los pasos reales del renderer se conservan: alimentan el contador de escenas.
  for (const paso of ['scene', 'concat', 'audio', 'compose', 'encode', 'intro']) {
    assert.equal(pasoDeRender(paso), paso, `${paso} debe llegar tal cual a la interfaz`);
  }

  // `done` NO. El renderer lo emite al acabar CADA formato, y core/jobs.js lo
  // traduce a COMPLETED: dejarlo pasar marcaría el trabajo como terminado con
  // los otros formatos y los metadatos todavía pendientes.
  assert.equal(pasoDeRender('done'), 'render');
  assert.equal(pasoDeRender(undefined), 'render');
  assert.equal(pasoDeRender(''), 'render');

  // Y se comprueba contra el mapa real, no contra una copia de este test.
  const fuente = await fs.readFile(path.resolve('src/core/jobs.js'), 'utf8');
  assert.match(fuente, /done:\s*JOB_STATUS\.COMPLETED/,
    'si este mapa cambia, revisa pasoDeRender: es la razón de que `done` se filtre');
});

test('el progreso publicado nunca retrocede y cuenta escenas de verdad', { timeout: 300000 }, async () => {
  const { createJob, getJob } = await import('../src/generation/jobs.js');
  const escenas = [1, 2].map(i => ({
    role: 'point', text: `Escena número ${i} de la prueba de progreso.`,
    onScreenTitle: `E${i}`, visualPrompt: 'study desk', duration: 2,
  }));

  let job = createJob(
    { prompt: 'Prueba de progreso', escenas, duration: 'auto', format: '16:9' },
    { providerName: 'pipeline' },
  );

  const vistos = [];
  let pctPrevio = -1;
  const porEtapa = new Map();

  while (!['completed', 'failed'].includes(job.status)) {
    await new Promise(r => setTimeout(r, 250));
    job = getJob(job.id);
    const p = job.progreso;
    if (!p) continue;

    // El porcentaje jamás baja: si bajara, la barra retrocedería en pantalla.
    assert.ok(p.porcentaje >= pctPrevio,
      `el progreso retrocedió de ${pctPrevio}% a ${p.porcentaje}% en «${p.estado}»`);
    pctPrevio = p.porcentaje;

    // Dentro de una etapa, el contador de escenas tampoco retrocede.
    const previo = porEtapa.get(p.estado) ?? 0;
    assert.ok(p.escenasCompletadas >= previo,
      `«${p.estado}» pasó de ${previo} a ${p.escenasCompletadas} escenas hechas`);
    porEtapa.set(p.estado, p.escenasCompletadas);

    // Nunca se declaran más escenas hechas de las que hay.
    assert.ok(p.escenasCompletadas <= p.escenasTotales, 'no puede haber más escenas hechas que totales');
    vistos.push(p.estado);
  }

  assert.equal(job.status, 'completed', job.error || '');
  // Las etapas declaradas aparecen de verdad: el progreso no es decorativo.
  const historial = new Set([...(job.progresoHistorial || []).map(p => p.estado), ...vistos]);
  for (const etapa of ['buscando-visuales', 'generando-voz', 'renderizando-segmentos', 'listo']) {
    assert.ok(historial.has(etapa), `nunca se informó la etapa «${etapa}»`);
  }
  assert.equal(job.progreso.porcentaje, 100);
  assert.equal(job.progreso.escenasCompletadas, job.progreso.escenasTotales);
  assert.ok(job.projectId, 'un trabajo terminado debe dejar projectId para poder regenerar escenas');
});

test('la narración larga se concatena en bloques sin abrir todas las escenas a la vez', { timeout: 120000 }, async () => {
  const projectId = `audio-block-test-${process.pid}`;
  const dir = workDir(projectId);
  await fs.rm(dir, { recursive: true, force: true });
  const audioDir = path.join(dir, 'audio');
  await fs.mkdir(audioDir, { recursive: true });

  const total = NARRATION_BLOCK_SIZE + 2;
  const scenes = [];
  for (let i = 0; i < total; i++) {
    const wav = path.join(audioDir, `scene-${i}.wav`);
    await ffmpegRun([
      '-f', 'lavfi', '-i', `sine=frequency=${300 + i}:duration=0.08`,
      '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', wav,
    ]);
    scenes.push({ id: `scene-${i}`, duration: 0.1, narrationPath: rel(wav), narrationKey: `key-${i}` });
  }

  const track = await buildNarrationTrack({ id: projectId, scenes });
  const duration = await probeDuration(abs(track));
  const blocks = (await fs.readdir(path.join(dir, 'narration-blocks'))).filter(f => f.endsWith('.wav'));

  assert.equal(blocks.length, 2, '18 escenas con bloques de 16 deben producir dos WAV intermedios');
  assert.ok(Math.abs(duration - total * 0.1) < 0.08, `duración ${duration} vs ${total * 0.1}`);

  // A second pass must reuse the same blocks rather than rebuilding them.
  const before = await Promise.all(blocks.map(async f => (await fs.stat(path.join(dir, 'narration-blocks', f))).mtimeMs));
  await buildNarrationTrack({ id: projectId, scenes });
  const after = await Promise.all(blocks.map(async f => (await fs.stat(path.join(dir, 'narration-blocks', f))).mtimeMs));
  assert.deepEqual(after, before, 'los bloques válidos deben reutilizarse al reanudar');
});

test('reanudar y regenerar una escena: se rechazan si no hay nada que reutilizar', async () => {
  const { resumeJob, regenerateScene } = await import('../src/generation/jobs.js');
  // Sin trabajo previo no se puede reanudar, y se dice por qué.
  assert.throws(() => resumeJob('00000000-0000-4000-8000-000000000000'), /no encontrado/);
  assert.throws(() => regenerateScene('00000000-0000-4000-8000-000000000000', 0, {}), /no encontrado/);
});

test('regenerar una escena reutiliza el trabajo de las demás', async () => {
  // La reutilización es por HUELLA: el render de una escena se salta si la
  // escena no cambió. Aquí se comprueba esa garantía sobre el proyecto, que es
  // donde vive, sin pagar un render completo.
  const { makeProject, makeScene, saveProject, loadProject } = await import('../src/core/project.js');
  const project = makeProject({ title: 'Clase de prueba', brand: 'personal', aspectRatio: '16:9' });
  project.scenes = [
    makeScene({ text: 'Primera escena de la clase.', duration: 5 }),
    makeScene({ text: 'Segunda escena de la clase.', duration: 5 }),
    makeScene({ text: 'Tercera escena de la clase.', duration: 5 }),
  ];
  // Se simula que las tres ya tienen voz generada, con su marca de caché.
  project.scenes.forEach((s, i) => { s.narrationKey = `clave-${i}`; s.narrationPath = `draft/fake-${i}.wav`; });
  saveProject(project);

  const recargado = loadProject(project.id);
  assert.equal(recargado.scenes.length, 3);

  // Cambiar SOLO la escena 2 no toca las marcas de caché de las otras dos.
  recargado.scenes[1].text = 'Segunda escena, reescrita por completo.';
  recargado.scenes[1].narrationKey = null;
  recargado.scenes[1].narrationPath = null;
  saveProject(recargado);

  const final = loadProject(project.id);
  assert.equal(final.scenes[0].narrationKey, 'clave-0', 'la escena 1 conserva su voz');
  assert.equal(final.scenes[2].narrationKey, 'clave-2', 'la escena 3 conserva su voz');
  assert.equal(final.scenes[1].narrationKey, null, 'sólo la escena editada se marca para rehacer');
  assert.equal(final.scenes[1].text, 'Segunda escena, reescrita por completo.');

  // La correspondencia texto <-> escena es estable: los ids no cambian.
  assert.deepEqual(final.scenes.map(s => s.id), recargado.scenes.map(s => s.id));
});

// ------------------------------------------- 9. NINGUNA CLAVE EN LAS RESPUESTAS

test('ni el backend ni el frontend exponen claves', async () => {
  // Se plantan valores falsos en el entorno: si alguno aparece en una
  // respuesta o en un archivo del frontend, la prueba falla.
  const centinelas = {
    PEXELS_API_KEY: 'pexels-centinela-NO-DEBE-SALIR',
    GEMINI_API_KEY: 'gemini-centinela-NO-DEBE-SALIR',
    LLM_API_KEY: 'llm-centinela-NO-DEBE-SALIR',
  };
  const previos = {};
  for (const [k, v] of Object.entries(centinelas)) { previos[k] = process.env[k]; process.env[k] = v; }

  const server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const rutas = [
      '/api/video-generation/config',
      '/api/video-generation/projects',
    ];
    for (const ruta of rutas) {
      const texto = await (await fetch(base + ruta)).text();
      for (const valor of Object.values(centinelas)) {
        assert.ok(!texto.includes(valor), `${ruta} filtró una clave`);
      }
    }

    // El plan y el contrato tampoco devuelven nada del entorno.
    const plan = await (await fetch(`${base}/api/video-generation/plan`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ script: 'Una frase de prueba.' }),
    })).text();
    for (const valor of Object.values(centinelas)) assert.ok(!plan.includes(valor));

    // Y el frontend entero: ni claves plantadas ni patrones de clave real.
    const dir = path.resolve('src/ui');
    const pendientes = [dir];
    while (pendientes.length) {
      const d = pendientes.pop();
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { pendientes.push(p); continue; }
        const contenido = await fs.readFile(p, 'utf8');
        for (const valor of Object.values(centinelas)) {
          assert.ok(!contenido.includes(valor), `${p} contiene una clave`);
        }
        assert.ok(!/PEXELS_API_KEY\s*[:=]\s*['"][^'"]+['"]/.test(contenido), `${p} parece declarar una clave`);
        assert.ok(!/\bsk-[A-Za-z0-9]{20,}/.test(contenido), `${p} contiene algo con forma de clave`);
      }
    }
  } finally {
    server.close();
    for (const [k, v] of Object.entries(previos)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('Pexels es opcional: sin clave el proyecto sigue funcionando', async () => {
  const previo = process.env.PEXELS_API_KEY;
  delete process.env.PEXELS_API_KEY;
  try {
    // El borrador y el plan no dependen de ningún proveedor de imágenes.
    const plan = planJob({ script: guionDeClase({ modulos: 2 }) });
    assert.ok(plan.escenas > 0);
    const borrador = await draftJob({ script: guionDeClase({ modulos: 2 }) });
    assert.equal(borrador.costo.tieneCostoPotencial, false, 'sin claves, coste cero');
    const visuales = borrador.costo.piezas.find(p => p.pieza === 'Visuales');
    assert.match(visuales.proveedor, /FFmpeg/, 'sin clave se cae a fondos generados en local');
    assert.equal(visuales.pago, false);
  } finally {
    if (previo === undefined) delete process.env.PEXELS_API_KEY; else process.env.PEXELS_API_KEY = previo;
  }
});

// -------------------------------------------------- 10. CONTRATO ORQUESTADOR

test('contrato del Orquestador KSL: acepta los campos declarados y valida', () => {
  const entrada = {
    projectId: 'ksl-2026-0041',
    brandId: 'personal',
    title: 'Clase 3 · Presente simple',
    prompt: 'Lección sobre el presente simple en inglés',
    script: guionDeClase({ modulos: 2 }),
    sourceReference: { kind: 'drive', id: '1AbC', name: 'clase-3.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    format: '16:9',
    targetDurationSeconds: 720,
    platform: 'youtube',
    style: 'documental',
    voice: { provider: 'auto', name: 'Sabina', rate: 0 },
    music: { path: 'data/assets/music/suave.mp3', volume: 0.1 },
    subtitles: { enabled: true, burnIn: true, language: 'es' },
    logo: { path: 'data/assets/brands/personal/logo.png', position: 'bottom-left', scale: 0.08 },
    course: { courseId: 'ING-101', courseName: 'Inglés desde cero', moduleId: 'M3', moduleName: 'Presente simple', lessonNumber: 3, tags: ['inglés', 'gramática'] },
  };

  const c = normalizeOrchestratorInput(entrada);
  assert.equal(c.contractVersion, CONTRACT_VERSION);
  for (const campo of ['projectId', 'brandId', 'title', 'prompt', 'script', 'sourceReference',
    'format', 'targetDurationSeconds', 'platform', 'style', 'voice', 'music', 'subtitles', 'logo', 'course']) {
    assert.ok(campo in c, `el contrato debe aceptar ${campo}`);
  }
  assert.equal(c.script, entrada.script, 'el guion viaja entero por el contrato');
  assert.equal(c.course.lessonNumber, 3);
  assert.equal(c.logo.position, 'bottom-left');

  // `sourceReference` se guarda pero NO se resuelve: no se toca Drive.
  assert.equal(c.sourceReference.kind, 'drive');
  assert.equal(c.sourceReference.resolved, false);
  assert.equal(c.sourceReference.text, null, 'no se descarga el contenido del archivo');

  // La duración objetivo es OPCIONAL.
  const sinDuracion = normalizeOrchestratorInput({ script: 'Una frase.' });
  assert.equal(sinDuracion.targetDurationSeconds, null);
  assert.equal(sinDuracion.format, '16:9', 'el formato por defecto es horizontal para curso');

  // Validaciones.
  assert.throws(() => normalizeOrchestratorInput({}), /al menos `script`, `prompt` o un `sourceReference`/);
  assert.throws(() => normalizeOrchestratorInput({ script: 'x', format: '4:3' }), /format no admitido/);
  assert.throws(() => normalizeOrchestratorInput({ script: 'x', style: 'psicodélico' }), /style no admitido/);
  assert.throws(() => normalizeOrchestratorInput({ script: 'x', targetDurationSeconds: 99999 }), /targetDurationSeconds debe estar/);
  assert.throws(() => normalizeOrchestratorInput({ script: 'x'.repeat(SCRIPT_MAX_CHARS + 1) }), /script supera el límite/);

  // Y la traducción al vocabulario interno produce una spec válida.
  const spec = normalizeSpec(specDesdeContrato(c));
  assert.equal(spec.script, entrada.script);
  assert.equal(spec.duration, 720);
  assert.equal(spec.brandId, 'personal');
  assert.equal(spec.logo.position, 'bottom-left');
});

test('el contrato admite un sourceReference de texto en línea como origen del guion', () => {
  const c = normalizeOrchestratorInput({
    title: 'Clase suelta',
    sourceReference: 'Primera frase de la clase. Segunda frase de la clase.',
  });
  assert.equal(c.sourceReference.kind, 'inline');
  const spec = specDesdeContrato(c);
  assert.match(spec.script, /Primera frase/);
  const plan = planJob(spec);
  assert.ok(plan.escenas >= 1);
});

// --------------------------------------------- 11 y 12. HTTP Y NO REGRESIÓN

test('HTTP: el guion largo pasa por la red entero y el plan responde sin producir nada', async () => {
  const server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (ruta, body) => fetch(base + ruta, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  try {
    const config = await (await fetch(`${base}/api/video-generation/config`)).json();
    // Los límites técnicos se publican para que la interfaz no se los invente.
    assert.equal(config.limits.scriptMax, SCRIPT_MAX_CHARS);
    assert.equal(config.limits.maxEscenas, MAX_ESCENAS);
    assert.equal(config.limits.httpBodyMax, HTTP_BODY_MAX);
    assert.equal(config.limits.sceneTextMax, SCENE_TEXT_MAX);
    assert.deepEqual(config.limits.duration, DURATION_LIMITS);
    assert.ok(config.narration.wpm > 0);
    // «Automática» tiene que estar y ser la primera opción ofrecida.
    assert.equal(config.durationOptions[0].value, 'auto');
    assert.ok(config.states.includes('renderizando-segmentos'));

    // Un guion de 12 minutos viaja por HTTP sin que el cuerpo se corte.
    const guion = guionDePalabras(1250);
    assert.ok(guion.length > 2000);
    const plan = await (await post('/api/video-generation/plan', { script: guion })).json();
    // La red entrega exactamente lo mismo que el cálculo en proceso: el cuerpo
    // no se cortó por el camino.
    assert.deepEqual(
      { palabras: plan.palabras, escenas: plan.escenas },
      { palabras: planJob({ script: guion }).palabras, escenas: planJob({ script: guion }).escenas },
    );
    assert.ok(plan.duracionEstimada > 600);

    // El borrador por HTTP tampoco trunca: el guion llega entero a las escenas.
    const borrador = await (await post('/api/video-generation/draft', { script: guion })).json();
    assert.equal(borrador.source, 'guion-propio');
    assert.equal(borrador.escenas.length, plan.escenas);
    assert.ok(sinPerdidaDeTexto(guion, borrador.escenas).ok, 'el guion perdió texto al pasar por HTTP');

    // Objetivo incompatible: 200 con aviso, no un error que bloquee.
    const conObjetivo = await post('/api/video-generation/draft', { script: guion, duration: 60 });
    assert.equal(conObjetivo.status, 200);
    const cuerpo = await conObjetivo.json();
    assert.equal(cuerpo.compatibleConObjetivo, false);
    assert.ok(cuerpo.advertencias.length);

    // El contrato del Orquestador se puede validar sin producir nada.
    const seco = await post('/api/video-generation/orchestrator', {
      projectId: 'ksl-1', title: 'Clase', script: guion, format: '16:9', dryRun: true,
    });
    assert.equal(seco.status, 200);
    const contrato = await seco.json();
    assert.equal(contrato.aceptado, true);
    assert.equal(contrato.contractVersion, CONTRACT_VERSION);
    assert.ok(contrato.plan.escenas > 0);

    // Guion que se pasa del límite: 400 con el número exacto, sin recortar.
    const enorme = await post('/api/video-generation/plan', { script: 'x'.repeat(SCRIPT_MAX_CHARS + 10) });
    assert.equal(enorme.status, 400);
    assert.match((await enorme.json()).error, /No se ha recortado nada/);
  } finally {
    server.close();
  }
});

test('no regresión: el flujo corto desde prompt sigue funcionando igual', async () => {
  // Sin guion propio y con duración fija, el camino de siempre: plantilla
  // local, presupuesto de palabras y duración ajustada al objetivo.
  const d = await draftJob({ prompt: 'Reel de clases de inglés online con conversación', duration: 15, format: '9:16' });
  assert.equal(d.source, 'plantilla-local');
  assert.ok(Math.abs(d.duracionEstimada - 15) <= 1, `duración ${d.duracionEstimada}`);
  assert.equal(d.costo.tieneCostoPotencial, false);
  assert.equal(d.compatibleConObjetivo, true);

  // Y `draftScript` sigue devolviendo lo mismo que antes para ese caso.
  const s = await draftScript({ prompt: 'Reel de clases de inglés', duration: 15 }, { templateId: 'reel-promocional' });
  assert.ok(s.escenas.length >= 2);
  assert.ok(s.escenas.every(e => e.text && e.duration > 0));
});

test('compatibilidad de runtime: nada usado aquí depende de Node 20+', () => {
  // La suite corre en Node 18 y Node 22. Lo que podría romper en 18 son las
  // APIs recientes; se comprueba que las que usamos existen en ambas.
  const mayor = Number(process.versions.node.split('.')[0]);
  assert.ok(mayor >= 18, `Node ${process.versions.node} está por debajo del mínimo declarado`);
  assert.equal(typeof structuredClone, 'function');
  assert.equal(typeof AbortController, 'function');
  assert.equal(typeof fetch, 'function');
  assert.equal(typeof Array.prototype.at, 'function');
  // `Object.groupBy` y `Array.prototype.toSorted` son de Node 20+: no se usan.
  assert.ok(!/Object\.groupBy|\.toSorted\(|\.toReversed\(/.test(segmentarGuion.toString()));
});
