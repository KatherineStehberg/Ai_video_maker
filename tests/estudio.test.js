import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { normalizeSpec, draftJob, listJobs, DURATION_OPTIONS, DURATION_LIMITS } from '../src/generation/jobs.js';
import { defaultProvider, listProviders } from '../src/providers/video-generation/index.js';
import { draftLocal, duracionGuion } from '../src/generation/script.js';
import { getTemplate } from '../src/templates/index.js';
import { etiquetaEstado, fechaCorta, duracionCorta } from '../src/ui/editor/projects.js';

// ------------------------------------------------- DURACIÓN AUTOMÁTICA

test('duración automática: la marca el guion y no se recorta contenido', async () => {
  const largo = 'Lección sobre los tiempos verbales en inglés para adultos. '
    + 'Explica el presente simple con ejemplos. Practica la conversación en clase. '
    + 'Enfocado en objetivos laborales y entrevistas. Horarios flexibles para trabajar.';

  const auto = await draftJob({ prompt: largo, duration: 'auto', format: '16:9' });
  assert.equal(auto.spec.durationMode, 'auto');
  assert.equal(auto.spec.duration, null, 'en automático no hay duración objetivo');
  assert.ok(auto.duracionEstimada > 0);

  // Con una duración corta impuesta, el mismo guion SÍ se recorta.
  const corto = await draftJob({ prompt: largo, duration: 15, format: '16:9' });
  assert.equal(corto.spec.durationMode, 'fija');
  assert.ok(Math.abs(corto.duracionEstimada - 15) <= 1, `estimada ${corto.duracionEstimada}`);
  assert.ok(auto.escenas.length >= corto.escenas.length,
    'el modo automático no debe conservar menos escenas que el recortado');

  // 'auto' es una opción real de la interfaz.
  assert.ok(DURATION_OPTIONS.some(o => o.value === 'auto'));
});

test('videos de varios minutos: se aceptan y se reparten bien', async () => {
  assert.ok(DURATION_LIMITS.max >= 600, 'debe admitir lecciones de 10 minutos');
  for (const objetivo of [120, 300, 600]) {
    const d = await draftJob({ prompt: 'Lección sobre clases de inglés online con conversación y horarios flexibles', duration: objetivo, format: '16:9' });
    assert.ok(Math.abs(d.duracionEstimada - objetivo) <= 1, `objetivo ${objetivo}s -> ${d.duracionEstimada}s`);
    assert.ok(d.escenas.every(e => e.duration > 0));
  }
  // Fuera de rango sigue rechazándose con un mensaje claro.
  assert.throws(() => normalizeSpec({ prompt: 'x', duration: 5000 }), /entre 3 y 900 segundos/);
  assert.throws(() => normalizeSpec({ prompt: 'x', duration: 1 }), /entre 3 y 900 segundos/);
});

// ------------------------------------------------ PROVEEDORES Y CLAVES

test('el proveedor por defecto se lee en cada llamada, no al cargar el módulo', () => {
  const previo = process.env.VIDEO_GEN_PROVIDER;
  try {
    delete process.env.VIDEO_GEN_PROVIDER;
    assert.equal(defaultProvider(), 'pipeline', 'sin variable, el montaje local real');
    process.env.VIDEO_GEN_PROVIDER = 'mock';
    assert.equal(defaultProvider(), 'mock', 'cambiar el entorno debe tener efecto inmediato');
  } finally {
    if (previo === undefined) delete process.env.VIDEO_GEN_PROVIDER;
    else process.env.VIDEO_GEN_PROVIDER = previo;
  }
});

test('estados de proveedores: se declara cuál está listo y cuál no', () => {
  const lista = listProviders();
  const porId = Object.fromEntries(lista.map(p => [p.id, p]));
  assert.equal(porId.pipeline.configured, true);
  assert.equal(porId.pipeline.mock, false);
  assert.equal(porId.mock.mock, true);
  // Las ranuras sin implementar no pueden decir que están listas.
  for (const id of ['api', 'local']) {
    assert.equal(porId[id].configured, false);
    assert.ok(porId[id].requires.length);
  }
});

test('el frontend no contiene ninguna credencial', async () => {
  const dir = path.resolve('src/ui');
  const archivos = [];
  const recorrer = async d => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await recorrer(p);
      else if (/\.(js|html|css)$/.test(e.name)) archivos.push(p);
    }
  };
  await recorrer(dir);
  assert.ok(archivos.length > 5);

  for (const archivo of archivos) {
    const texto = await fs.readFile(archivo, 'utf8');
    // Ninguna clave real ni lectura de variables de entorno desde el navegador.
    assert.ok(!/PEXELS_API_KEY\s*=\s*['"][^'"]{8,}/.test(texto), `posible clave en ${archivo}`);
    assert.ok(!/GEMINI_API_KEY\s*=\s*['"][^'"]{8,}/.test(texto), `posible clave en ${archivo}`);
    assert.ok(!/\bsk-[A-Za-z0-9]{16,}/.test(texto), `posible token en ${archivo}`);
    assert.ok(!/process\.env/.test(texto), `el frontend no debe leer process.env (${archivo})`);
  }
});

// ------------------------------------------------ RECUPERAR PROYECTOS

test('proyectos: se listan sin borrar nada y con estado legible', async () => {
  const proyectos = listJobs({ limit: 5 });
  assert.ok(Array.isArray(proyectos));
  assert.ok(proyectos.length <= 5);
  for (const p of proyectos) {
    assert.ok(p.id, 'cada proyecto necesita id para poder retomarlo');
    assert.ok(typeof p.titulo === 'string' && p.titulo.length > 0);
    assert.ok(typeof p.estado === 'string');
    // Nada de rutas absolutas del servidor en la lista.
    assert.ok(!JSON.stringify(p).includes('C:\\'), 'no deben viajar rutas del disco');
  }

  // Un trabajo a medias se marca recuperado, no se reanuda solo.
  assert.equal(etiquetaEstado('interrumpido').texto, 'Recuperado');
  assert.equal(etiquetaEstado('completed').texto, 'Listo');
  assert.equal(etiquetaEstado('failed').tono, 'error');
  assert.equal(etiquetaEstado('desconocido-x').texto, 'desconocido-x');
});

test('HTTP: el listado de proyectos responde y no filtra secretos', async () => {
  const server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/video-generation/projects`);
    assert.equal(res.status, 200);
    const cuerpo = await res.text();
    assert.ok(!/API_KEY|sk-[A-Za-z0-9]{16,}/.test(cuerpo), 'la lista no puede traer credenciales');
    const { proyectos } = JSON.parse(cuerpo);
    assert.ok(Array.isArray(proyectos));

    // La configuración anuncia las duraciones largas y la automática.
    const cfg = await (await fetch(`${base}/api/video-generation/config`)).json();
    assert.ok(cfg.durationOptions.some(o => o.value === 'auto'));
    assert.ok(cfg.durationOptions.some(o => Number(o.value) >= 600));
    assert.ok(!JSON.stringify(cfg).includes('API_KEY='));
  } finally { await new Promise(r => server.close(r)); }
});

// -------------------------------------------------- EDICIÓN DE ESCENAS

test('edición de escenas: se respeta lo editado y se valida antes de producir', () => {
  const base = { prompt: 'Reel de clases de inglés online', duration: 15, format: '9:16' };
  const editadas = [
    { role: 'hook', text: 'Texto que escribí yo', onScreenTitle: 'Mi título', visualPrompt: 'english class', duration: 4 },
    { role: 'cta', text: 'Escríbenos hoy', onScreenTitle: 'Escríbenos', visualPrompt: 'contact phone', duration: 3 },
  ];
  const spec = normalizeSpec({ ...base, escenas: editadas });
  assert.equal(spec.escenas.length, 2);
  assert.equal(spec.escenas[0].text, 'Texto que escribí yo', 'la narración editada manda');
  assert.equal(spec.escenas[0].onScreenTitle, 'Mi título');
  assert.equal(spec.scriptSource, 'editado');

  // Añadir una escena vacía se rechaza antes de gastar tiempo en el render.
  assert.throws(() => normalizeSpec({ ...base, escenas: [...editadas, { text: '   ', duration: 3 }] }), /no tiene narración/);
  assert.throws(() => normalizeSpec({ ...base, escenas: [{ text: 'x', duration: 40 }] }), /entre 0.5 y 30 segundos/);
});

// ------------------------------------------------ TEXTOS DE LA INTERFAZ

test('la interfaz habla en lenguaje común, no en jerga', () => {
  assert.equal(duracionCorta(45), '45 s');
  assert.equal(duracionCorta(90), '1:30 min');
  assert.equal(duracionCorta(0), null);
  assert.equal(duracionCorta('x'), null);
  assert.match(fechaCorta('2026-09-19T08:45:00.000Z'), /\d{2}/);
  assert.equal(fechaCorta(null), '—');
  assert.equal(fechaCorta('no-es-fecha'), '—');

  // El reparto de duración nunca deja una escena sin tiempo.
  const d = draftLocal({ prompt: 'Reel de clases de inglés online con conversación', duration: 30 }, getTemplate('reel-promocional'));
  assert.ok(d.escenas.every(e => e.duration >= 1), 'ninguna escena puede durar cero');
  assert.ok(Math.abs(duracionGuion(d.escenas) - 30) <= 1);
});

// ------------------------------------------- ACCIONES SOBRE ESCENAS

test('acciones de escena: duplicar, excluir y reordenar sin perder nada', async () => {
  const { aplicarAccion, escenasIncluidas, validateDraft, duracionTotal } =
    await import('../src/ui/editor/draft.js');

  const base = [
    { role: 'hook', text: 'Uno', onScreenTitle: 'A', visualPrompt: 'a', duration: 3 },
    { role: 'point', text: 'Dos', onScreenTitle: 'B', visualPrompt: 'b', duration: 4 },
    { role: 'cta', text: 'Tres', onScreenTitle: 'C', visualPrompt: 'c', duration: 2 },
  ];

  // Duplicar inserta la copia justo debajo, sin tocar el resto.
  const dup = aplicarAccion(base, { tipo: 'duplicar', indice: 1 });
  assert.equal(dup.length, 4);
  assert.deepEqual(dup.map(e => e.text), ['Uno', 'Dos', 'Dos', 'Tres']);
  assert.equal(base.length, 3, 'la lista original no debe mutarse');

  // Excluir no borra: la escena sigue ahí, marcada.
  const exc = aplicarAccion(base, { tipo: 'excluir', indice: 0 });
  assert.equal(exc.length, 3, 'excluir no elimina la escena');
  assert.equal(exc[0].excluida, true);
  assert.equal(escenasIncluidas(exc).length, 2);
  assert.equal(duracionTotal(exc), 6, 'la duración sólo cuenta lo incluido');
  // Y se puede volver a incluir.
  assert.equal(aplicarAccion(exc, { tipo: 'excluir', indice: 0 })[0].excluida, false);

  // Reordenar intercambia con la vecina y respeta los bordes.
  assert.deepEqual(aplicarAccion(base, { tipo: 'subir', indice: 2 }).map(e => e.text), ['Uno', 'Tres', 'Dos']);
  assert.deepEqual(aplicarAccion(base, { tipo: 'bajar', indice: 0 }).map(e => e.text), ['Dos', 'Uno', 'Tres']);
  assert.deepEqual(aplicarAccion(base, { tipo: 'subir', indice: 0 }).map(e => e.text), ['Uno', 'Dos', 'Tres']);
  assert.deepEqual(aplicarAccion(base, { tipo: 'bajar', indice: 2 }).map(e => e.text), ['Uno', 'Dos', 'Tres']);
  // Un índice imposible no rompe nada.
  assert.equal(aplicarAccion(base, { tipo: 'duplicar', indice: 99 }).length, 3);

  // Excluirlo todo se avisa antes de producir.
  const todasFuera = base.map(e => ({ ...e, excluida: true }));
  assert.match(validateDraft(todasFuera), /al menos una escena/);
  // Una escena excluida con texto vacío no bloquea: no va a salir en el video.
  assert.equal(validateDraft([{ ...base[0] }, { ...base[1], text: '', excluida: true }]), null);
});
