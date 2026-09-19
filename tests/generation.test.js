import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { probe } from '../src/analysis/local.js';
import { normalizeSpec, STATES, FORMATS, STYLES } from '../src/generation/jobs.js';
import { getProvider, listProviders, PROVIDERS } from '../src/providers/video-generation/index.js';
import { PALETAS, colorDePlano } from '../src/providers/video-generation/mock.js';
import { pipelineProvider, elegirTemplate } from '../src/providers/video-generation/pipeline.js';
import { draftJob, estimarCosto } from '../src/generation/jobs.js';
import { draftScript, extraerTema } from '../src/generation/script.js';
import { ffmpegRun } from '../src/lib/ffmpeg.js';

const dir = path.resolve('.tmp/generation-test');

test('validación del prompt: rechaza lo inválido con mensajes accionables', () => {
  const ok = normalizeSpec({ prompt: '  Video sobre aves  ', duration: 15, format: '9:16', style: 'documental' });
  assert.equal(ok.prompt, 'Video sobre aves');
  assert.equal(ok.duration, 15);
  assert.equal(ok.platform, null, 'los campos opcionales vacíos quedan en null, no en cadena vacía');

  // Por defecto: 15 s, vertical y el primer estilo.
  const porDefecto = normalizeSpec({ prompt: 'x' });
  assert.equal(porDefecto.duration, 15);
  assert.equal(porDefecto.format, '9:16');
  assert.equal(porDefecto.style, STYLES[0]);

  assert.throws(() => normalizeSpec({ prompt: '   ' }), /Escribe un prompt/);
  assert.throws(() => normalizeSpec({}), /Escribe un prompt/);
  assert.throws(() => normalizeSpec({ prompt: 'x'.repeat(2001) }), /no puede superar 2000/);
  assert.throws(() => normalizeSpec({ prompt: 'x', duration: 1 }), /entre 3 y 120 segundos/);
  assert.throws(() => normalizeSpec({ prompt: 'x', duration: 500 }), /entre 3 y 120 segundos/);
  assert.throws(() => normalizeSpec({ prompt: 'x', duration: 'muchos' }), /entre 3 y 120 segundos/);
  assert.throws(() => normalizeSpec({ prompt: 'x', format: '4:3' }), /Formato no admitido/);
  assert.throws(() => normalizeSpec({ prompt: 'x', style: 'psicodélico' }), /Estilo no admitido/);

  // Los opcionales se recortan, no se interpretan.
  const largo = normalizeSpec({ prompt: 'x', platform: 'T'.repeat(500) });
  assert.equal(largo.platform.length, 300);
});

test('registro de proveedores: el real y el mock funcionan; las ranuras no, y ninguno filtra claves', async () => {
  const lista = listProviders();
  const mock = lista.find(p => p.id === 'mock');
  assert.equal(mock.configured, true);
  assert.equal(mock.mock, true);
  // El montaje local real está disponible y NO se declara mock.
  const real = lista.find(p => p.id === 'pipeline');
  assert.equal(real.configured, true);
  assert.equal(real.mock, false);
  // Las ranuras declaradas existen pero NO están implementadas ni configuradas.
  for (const id of ['api', 'local']) {
    const ranura = lista.find(p => p.id === id);
    assert.equal(ranura.configured, false, `${id} no debe declararse configurado`);
    assert.equal(ranura.mock, false);
    assert.ok(ranura.requires.length, `${id} debe declarar qué variables necesita`);
    await assert.rejects(PROVIDERS[id].generate({}, {}), /no está implementado todavía/);
  }
  // La vista pública no puede contener valores de variables de entorno.
  const serializado = JSON.stringify(lista);
  assert.ok(!/API_KEY=|sk-|Bearer/i.test(serializado));
  assert.throws(() => getProvider('inventado'), /Proveedor de generación desconocido/);
});

test('todos los estilos del mock producen planos visibles, nunca casi negros', () => {
  // Un plano con luma muy baja se ve como pantalla en blanco: el usuario cree
  // que el video está roto. Se comprueba el brillo medido de cada frame.
  const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
  for (const style of STYLES) {
    const brillos = [];
    for (let i = 0; i < 8; i++) {
      const color = colorDePlano(PALETAS[style][i % PALETAS[style].length], i);
      const n = parseInt(color.replace(/^0x/, ''), 16);
      brillos.push(luma((n >> 16) & 255, (n >> 8) & 255, n & 255));
    }
    for (const [i, brillo] of brillos.entries()) {
      assert.ok(brillo >= 80, `estilo "${style}", plano ${i}: luma ${brillo.toFixed(0)} es demasiado oscuro para verse`);
      assert.ok(brillo <= 235, `estilo "${style}", plano ${i}: luma ${brillo.toFixed(0)} está quemado`);
    }
    // Planos consecutivos deben contrastar, o no habrá cortes detectables.
    for (let i = 1; i < brillos.length; i++) {
      assert.ok(Math.abs(brillos[i] - brillos[i - 1]) >= 60,
        `estilo "${style}": planos ${i - 1} y ${i} apenas contrastan (${brillos[i - 1].toFixed(0)} vs ${brillos[i].toFixed(0)})`);
    }
  }
});

test('proveedor mock: produce un MP4 real, determinista y marcado como prueba', { timeout: 180000 }, async () => {
  await fs.mkdir(dir, { recursive: true });
  const spec = normalizeSpec({ prompt: 'Promo vertical sobre cursos de inglés', duration: 8, format: '9:16', style: 'corporativo' });
  const etapas = [];
  const salida = await getProvider('mock').generate(spec, { workDir: dir, onProgress: (p, s) => etapas.push(s) });

  // El proveedor se declara mock y explica qué hizo. El aviso de «esto no es
  // IA» lo emite jobs.js una sola vez (ver el test HTTP), para no duplicarlo.
  assert.equal(salida.mock, true, 'el mock debe declararse como tal');
  assert.ok(salida.notes.some(n => /semilla/i.test(n)), 'debe explicar que el prompt sólo es semilla');
  assert.ok(salida.notes.some(n => /no se gastaron créditos/i.test(n)));
  assert.ok(etapas.length >= 2);

  const meta = await probe(salida.file);
  assert.ok(Math.abs(meta.duration - 8) < 0.4, `duración ${meta.duration}`);
  assert.equal(meta.width, 540);
  assert.equal(meta.height, 960);
  assert.equal(meta.codec, 'h264');
  assert.equal(meta.audio.length, 1, 'el mock incluye pista de clics para que haya beats');

  // El material de prueba debe ser ANALIZABLE: si los planos no contrastan,
  // el detector de escenas no ve ningún corte y el mock no sirve para nada.
  const { analyzeLocal } = await import('../src/analysis/local.js');
  const local = await analyzeLocal(salida.file, meta);
  assert.ok(local.scenes.length >= 1, `se esperaban cortes detectables, hubo ${local.scenes.length}`);
  assert.ok(local.tempo, 'se esperaba ritmo detectable a partir de la pista de clics');
  assert.ok(Math.abs(local.tempo.bpm - salida.spec.bpm) < 3, `BPM medido ${local.tempo.bpm} vs generado ${salida.spec.bpm}`);

  // Determinismo: el mismo prompt produce el mismo plan de video.
  const otra = await getProvider('mock').generate(spec, { workDir: dir });
  assert.deepEqual(otra.spec, salida.spec);
  // Un prompt distinto cambia el resultado.
  const distinto = await getProvider('mock').generate({ ...spec, prompt: 'otra cosa completamente' }, { workDir: dir });
  assert.notDeepEqual(distinto.spec, salida.spec);
});

test('guion local: extrae el tema y redacta escenas que hablan de él', async () => {
  const prompt = 'Video vertical promocional sobre clases de inglés online para adultos, tono cercano y profesional.';
  assert.equal(extraerTema(prompt), 'clases de inglés online para adultos');
  // El envoltorio descriptivo y la coletilla de tono no forman parte del tema.
  assert.equal(extraerTema('Un reel sobre panadería artesanal'), 'panadería artesanal');
  assert.equal(extraerTema('Reparación de bicicletas'), 'Reparación de bicicletas');
  assert.ok(extraerTema('').length === 0 || typeof extraerTema('') === 'string');

  const d = await draftScript({ prompt }, { templateId: 'reel-promocional' });
  assert.equal(d.source, 'plantilla-local', 'sin LLM configurado debe declararse plantilla, no IA');
  assert.ok(d.escenas.length >= 4);
  // Toda escena necesita lo que el pipeline consume aguas abajo.
  for (const e of d.escenas) {
    assert.ok(e.text.trim().length > 5, 'cada escena necesita narración');
    assert.ok(e.onScreenTitle.length > 0 && e.onScreenTitle.length <= 60, 'título en pantalla acotado');
    assert.ok(e.visualPrompt.length > 0, 'cada escena necesita instrucción visual');
    assert.ok(e.duration >= 2 && e.duration <= 10, `duración fuera de rango: ${e.duration}`);
  }
  // Lo esencial: el guion habla del tema pedido, no es relleno genérico.
  assert.ok(d.escenas.filter(e => /ingl[eé]s/i.test(e.text)).length >= 2,
    `el guion no menciona el tema: ${JSON.stringify(d.escenas.map(e => e.text))}`);
});

test('elección de plantilla y validación de escenas editadas', () => {
  assert.equal(elegirTemplate({ duration: 10, prompt: 'x' }), 'reel-promocional');
  assert.equal(elegirTemplate({ duration: 60, prompt: 'x' }), 'short-educativo');
  assert.equal(elegirTemplate({ duration: 30, prompt: 'promo de un curso' }), 'reel-promocional');
  assert.equal(elegirTemplate({ duration: 30, prompt: 'cómo funciona la fotosíntesis' }), 'short-educativo');

  // Las escenas editadas por la usuaria se validan antes de producir nada.
  const base = { prompt: 'x', duration: 15, format: '9:16' };
  const ok = normalizeSpec({ ...base, escenas: [{ text: 'Hola', duration: 3, onScreenTitle: 'Hola', visualPrompt: 'hola' }] });
  assert.equal(ok.escenas.length, 1);
  assert.equal(ok.scriptSource, 'editado');
  assert.equal(normalizeSpec(base).escenas, null, 'sin escenas el campo queda en null');
  assert.throws(() => normalizeSpec({ ...base, escenas: [] }), /al menos una escena/);
  assert.throws(() => normalizeSpec({ ...base, escenas: [{ text: '  ' }] }), /no tiene narración/);
  assert.throws(() => normalizeSpec({ ...base, escenas: [{ text: 'a', duration: 99 }] }), /entre 0.5 y 30 segundos/);
  assert.throws(() => normalizeSpec({ ...base, escenas: new Array(21).fill({ text: 'a', duration: 2 }) }), /Máximo 20 escenas/);
});

test('borrador: no produce nada y declara el coste real de cada pieza', async () => {
  const d = await draftJob({ prompt: 'Video sobre panadería artesanal', duration: 15, format: '9:16' });
  assert.ok(d.escenas.length >= 4);
  assert.ok(d.duracionEstimada > 0);
  assert.equal(d.llmProvider, 'ninguno');
  // Sin LLM de pago ni clave de imágenes, el coste tiene que ser cero.
  assert.equal(d.costo.tieneCostoPotencial, false);
  assert.match(d.costo.resumen, /Sin coste/);
  const piezas = Object.fromEntries(d.costo.piezas.map(p => [p.pieza, p]));
  assert.equal(piezas['Voz'].pago, false);
  assert.equal(piezas['Montaje'].proveedor, 'FFmpeg local');
  assert.ok(d.costo.piezas.every(p => typeof p.pago === 'boolean'));

  // Un guion de LLM de pago sí se declara como coste potencial.
  const caro = estimarCosto({ source: 'llm', provider: 'openai-compatible' });
  assert.equal(caro.tieneCostoPotencial, true);
  assert.match(caro.resumen, /Podría consumir créditos/);
  // Ollama es local: no cuesta.
  assert.equal(estimarCosto({ source: 'llm', provider: 'ollama' }).tieneCostoPotencial, false);
});

test('pipeline real: MP4 con imagen visible, audio y subtítulos del prompt', { timeout: 900000 }, async () => {
  const spec = {
    prompt: 'Video vertical promocional sobre clases de inglés online para adultos',
    duration: 15, format: '9:16', audience: 'adultos', platform: 'TikTok',
  };
  const out = await pipelineProvider.generate(spec, { onProgress: () => {} });

  assert.equal(out.mock, false, 'el pipeline no es un mock');
  assert.ok(out.script.escenas.length >= 4);
  assert.ok(out.spec.subtitulos, 'debe generar subtítulos');
  assert.ok(out.notes.some(n => /Guion:/.test(n)) && out.notes.some(n => /Visuales:/.test(n)),
    'debe declarar la procedencia de cada pieza');

  const meta = await probe(out.file);
  assert.equal(meta.codec, 'h264');
  assert.equal(meta.width, 1080);
  assert.equal(meta.height, 1920);
  assert.ok(meta.duration > 5, `duración ${meta.duration}`);
  assert.equal(meta.audio.length, 1, 'debe llevar la pista de voz');

  // IMAGEN VISIBLE: se mide el brillo medio de un frame. Un video en negro
  // pasaría todas las comprobaciones anteriores y seguiría siendo inservible.
  const frame = path.join(dir, 'frame-pipeline.png');
  await fs.mkdir(dir, { recursive: true });
  await ffmpegRun(['-ss', '2', '-i', out.file, '-frames:v', '1', '-vf', 'scale=64:-1', '-f', 'image2', frame]);
  const png = await fs.readFile(frame);
  assert.ok(png.length > 500, 'el frame extraído está vacío');
  const stats = await ffprobeBrillo(out.file);
  assert.ok(stats > 25, `el video está prácticamente en negro (brillo medio ${stats})`);
});

/** Brillo medio (0-255) del primer segundo, medido con el filtro signalstats. */
async function ffprobeBrillo(file) {
  const { stderr } = await ffmpegRun(['-ss', '1', '-t', '1', '-i', file, '-vf', 'signalstats,metadata=print', '-f', 'null', '-']);
  const valores = [...stderr.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map(m => Number(m[1]));
  if (!valores.length) throw new Error('signalstats no devolvió YAVG');
  return valores.reduce((a, b) => a + b, 0) / valores.length;
}

test('HTTP end-to-end: prompt → generación mock → análisis → propuesta lista', { timeout: 300000 }, async () => {
  process.env.GEMINI_API_KEY = '';
  const server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  try {
    const config = await (await fetch(base + '/api/video-generation/config')).json();
    assert.ok(config.formats.includes('9:16'));
    // El predeterminado es el montaje local real; el mock queda como fallback.
    assert.equal(config.defaultProvider, 'pipeline');
    assert.ok(config.providers.some(p => p.id === 'mock' && p.mock === true));
    assert.ok(!JSON.stringify(config).includes('API_KEY='), 'la config no puede traer claves');

    // Peticiones inválidas se rechazan antes de generar nada.
    assert.equal((await post('/api/video-generation/jobs', {})).status, 400);
    assert.equal((await post('/api/video-generation/jobs', { prompt: 'x', duration: 999 })).status, 400);
    assert.equal((await fetch(base + '/api/video-generation/jobs/no-existe')).status, 404);

    const created = await post('/api/video-generation/jobs', {
      prompt: 'Video vertical promocional sobre clases de inglés online',
      duration: 8, format: '9:16', style: 'corporativo', platform: 'TikTok',
      provider: 'mock',   // el pipeline real tiene su propio test; aquí importa el encadenado
    });
    assert.equal(created.status, 202);
    const job0 = await created.json();
    assert.ok(STATES.includes(job0.status));
    assert.equal(job0.provider.mock, true);
    assert.equal(job0.spec.platform, 'TikTok');

    let job;
    for (let i = 0; i < 600; i++) {
      job = await (await fetch(base + `/api/video-generation/jobs/${job0.id}`)).json();
      if (['completed', 'failed'].includes(job.status)) break;
      await new Promise(r => setTimeout(r, 200));
    }
    assert.equal(job.status, 'completed', JSON.stringify(job));
    assert.equal(job.progress, 100);
    assert.ok(job.analysisId, 'debe encadenar con el análisis');
    assert.ok(job.editId, 'debe dejar una propuesta de edición creada');
    assert.ok(job.warnings.some(w => /MOCK/i.test(w)), 'debe advertir que el video es de prueba');

    // El análisis encadenado es un análisis normal: mismos endpoints.
    const analysis = await (await fetch(base + `/api/analysis/${job.analysisId}`)).json();
    assert.equal(analysis.status, 'complete');
    assert.equal(analysis.gemini.status, 'disabled', 'la generación nunca envía material a Gemini');
    assert.ok(analysis.local.scenes.length >= 1, 'el video de prueba debe tener cortes detectables');
    assert.ok(analysis.local.tempo, 'el video de prueba debe tener ritmo detectable');
    assert.equal((await fetch(base + `/api/analysis/${job.analysisId}/preview`)).status, 200);

    // La propuesta es una propuesta normal: pendiente de aprobación humana.
    const proposal = await (await fetch(base + `/api/video-edits/${job.editId}`)).json();
    assert.equal(proposal.format, '9:16');
    assert.equal(proposal.approvalRequired, true);
    assert.equal(proposal.approval.status, 'pendiente');
    assert.ok(proposal.segments.length >= 1);

    // Y por tanto exportar sin aprobar sigue bloqueado.
    assert.equal((await post(`/api/video-edits/${job.editId}/export`, {})).status, 403);

    // Aprobar y exportar cierra el ciclo con el MISMO backend del otro flujo.
    assert.equal((await post(`/api/video-edits/${job.editId}/approve`, { confirm: true, by: 'test' })).status, 200);
    const exported = await (await post(`/api/video-edits/${job.editId}/export`, {})).json();
    assert.equal(exported.export.measured.width, 1080);
    assert.equal(exported.export.measured.height, 1920);
    assert.equal(exported.export.measured.codec, 'h264');

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'generation-result.json'), JSON.stringify({
      prompt: job.spec.prompt, provider: job.provider, estados: job.status,
      analysisId: job.analysisId, editId: job.editId,
      cortes: analysis.local.scenes.length, bpm: analysis.local.tempo?.bpm ?? null,
      exportado: exported.export.measured,
    }, null, 2));
  } finally { await new Promise(r => server.close(r)); }
});
