import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { probe } from '../src/analysis/local.js';
import { normalizeSpec, STATES, FORMATS, STYLES } from '../src/generation/jobs.js';
import { getProvider, listProviders, PROVIDERS } from '../src/providers/video-generation/index.js';

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

test('registro de proveedores: sólo el mock funciona y ninguno filtra claves', async () => {
  const lista = listProviders();
  const mock = lista.find(p => p.id === 'mock');
  assert.equal(mock.configured, true);
  assert.equal(mock.mock, true);
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

test('HTTP end-to-end: prompt → generación mock → análisis → propuesta lista', { timeout: 300000 }, async () => {
  process.env.GEMINI_API_KEY = '';
  const server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  try {
    const config = await (await fetch(base + '/api/video-generation/config')).json();
    assert.ok(config.formats.includes('9:16'));
    assert.equal(config.defaultProvider, 'mock');
    assert.ok(!JSON.stringify(config).includes('API_KEY='), 'la config no puede traer claves');

    // Peticiones inválidas se rechazan antes de generar nada.
    assert.equal((await post('/api/video-generation/jobs', {})).status, 400);
    assert.equal((await post('/api/video-generation/jobs', { prompt: 'x', duration: 999 })).status, 400);
    assert.equal((await fetch(base + '/api/video-generation/jobs/no-existe')).status, 404);

    const created = await post('/api/video-generation/jobs', {
      prompt: 'Video vertical promocional sobre clases de inglés online',
      duration: 8, format: '9:16', style: 'corporativo', platform: 'TikTok',
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
