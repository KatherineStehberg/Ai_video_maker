import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from '../src/server.js';
import { ffmpegRun } from '../src/lib/ffmpeg.js';
import { probe, analyzeLocal } from '../src/analysis/local.js';
import { analyzeRhythm } from '../src/analysis/beats.js';
import { planEdit } from '../src/edits/plan.js';
import { exportEdit, buildFilterGraph } from '../src/edits/export.js';
import { validateProposal, estimateDuration, outputDuration } from '../src/edits/schema.js';

const dir = path.resolve('.tmp/edits-test');
const hash = async file => { const h = createHash('sha256'); for await (const b of createReadStream(file)) h.update(b); return h.digest('hex'); };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tolerancia ${tol})`);

/** Análisis sintético determinista: cortes a 1.65 s y 3.0 s, rejilla de 120 BPM. */
function fakeJob(over = {}) {
  const duration = 6;
  const scenes = [{ timestamp: 1.65, frame: 50, kind: 'scene' }, { timestamp: 3.0, frame: 90, kind: 'scene' }];
  const onsets = Array.from({ length: 12 }, (_, i) => ({ timestamp: i * 0.5, kind: 'onset' }));
  const rhythm = analyzeRhythm(onsets, scenes, duration);
  return {
    id: '11111111-1111-4111-8111-111111111111', status: 'complete',
    metadata: { duration, fps: 30, nominalFps: 30, frameRateMode: 'cfr', codec: 'h264', width: 640, height: 360,
      videoStream: 0, videoStartTime: 0, startTime: 0, nbFrames: 180,
      audio: [{ index: 1, codec: 'aac', channels: 1, sampleRate: 16000, startTime: 0 }] },
    local: { scenes, onsets, beats: rhythm.beats, tempo: rhythm.tempo, tempoReason: rhythm.tempoReason,
      sync: rhythm.sync, ramps: rhythm.ramps, rampReason: rhythm.rampReason, notes: [] },
    ...over,
  };
}

test('propuesta válida: segmentos ordenados, sin solapamiento y con duración estimada exacta', () => {
  const p = planEdit(fakeJob(), { format: '9:16', syncMode: 'beats', enableSpeedRamps: true });
  assert.equal(p.syncStatus, 'propuesto');
  assert.equal(p.approvalRequired, true);
  assert.equal(p.approval.status, 'pendiente');
  assert.equal(p.segments.length, 3);   // [0,1.65] [1.65,3] [3,6]
  assert.deepEqual(p.dimensions, { width: 1080, height: 1920 });

  // Ordenación estricta y ausencia de solapamiento en la línea del ORIGINAL.
  for (let i = 1; i < p.segments.length; i++) {
    assert.ok(p.segments[i].sourceStart >= p.segments[i - 1].sourceEnd - 1e-9, `segmento ${i} solapa`);
    assert.ok(p.segments[i].sourceStart > p.segments[i - 1].sourceStart, `segmento ${i} desordenado`);
  }
  // Contigüidad de la línea de SALIDA.
  assert.equal(p.segments[0].start, 0);
  for (let i = 1; i < p.segments.length; i++) assert.equal(p.segments[i].start, p.segments[i - 1].end);

  // Rampas: 1.65 s -> 3 beats de 0.5 s = 1.5 s (acelera); 1.35 s -> 1.5 s (ralentiza).
  near(p.segments[0].speed, 1.1, 0.01, 'velocidad del primer segmento');
  near(p.segments[1].speed, 0.9, 0.01, 'velocidad del segundo segmento');
  assert.equal(p.segments[2].speed, 1);
  assert.equal(p.segments[0].reason, 'beat-aligned');
  assert.equal(p.segments[2].reason, 'corte-detectado');
  for (const s of p.segments) near(s.speed * s.setptsFactor, 1, 1e-9, 'speed = 1/setptsFactor');

  // Duración estimada = suma de duraciones transformadas, verificada aparte.
  near(p.estimatedDuration, 6, 0.02, 'duración estimada');
  near(estimateDuration(p.segments), p.estimatedDuration, 1e-6, 'suma de segmentos');
  near(outputDuration(p.segments[0]), 1.5, 0.02, 'salida del primer segmento');
  assert.equal(validateProposal(p, { duration: 6 }).segments, 3);
});

test('validación rechaza solapamientos, desorden, velocidades imposibles e incoherencias', () => {
  const base = planEdit(fakeJob(), {});
  const broken = (mutate) => { const p = JSON.parse(JSON.stringify(base)); mutate(p); return p; };

  assert.throws(() => validateProposal(broken(p => { p.segments[1].sourceStart = 1.0; }), { duration: 6 }), /se solapa con el anterior/);
  assert.throws(() => validateProposal(broken(p => { p.segments.reverse(); }), { duration: 6 }), /solapa|no continúa/);
  assert.throws(() => validateProposal(broken(p => { p.segments[0].speed = 3; p.segments[0].setptsFactor = 1 / 3; }), { duration: 6 }), /fuera del rango admitido/);
  assert.throws(() => validateProposal(broken(p => { p.segments[0].setptsFactor = 0.5; }), { duration: 6 }), /incoherentes/);
  assert.throws(() => validateProposal(broken(p => { p.segments[0].sourceEnd = p.segments[0].sourceStart; }), { duration: 6 }), /mayor que sourceStart/);
  assert.throws(() => validateProposal(broken(p => { p.segments.at(-1).sourceEnd = 99; }), { duration: 6 }), /excede la duración del original/);
  assert.throws(() => validateProposal(broken(p => { p.segments = []; }), { duration: 6 }), /al menos un segmento/);
  assert.throws(() => validateProposal(broken(p => { p.syncStatus = 'inventado'; }), { duration: 6 }), /syncStatus debe ser/);
  assert.throws(() => planEdit(fakeJob(), { syncMode: 'ritmo' }), /syncMode debe ser/);
  assert.throws(() => planEdit(fakeJob(), { format: '21:9' }), /Formato no soportado/);
  assert.throws(() => planEdit(fakeJob({ status: 'running' }), {}), /debe existir y estar completo/);
});

test('sin rejilla rítmica el estado es datos-insuficientes y no se inventan rampas', () => {
  const job = fakeJob();
  job.local = { ...job.local, tempo: null, ramps: [], beats: [], tempoReason: 'Evidencia insuficiente: 0 onsets' };
  const p = planEdit(job, { syncMode: 'beats' });
  assert.equal(p.syncStatus, 'datos-insuficientes');
  assert.equal(p.ramps.length, 0);
  assert.ok(p.segments.every(s => s.speed === 1));
  near(p.estimatedDuration, 6, 1e-6, 'sin rampas la duración es la del original');
  assert.match(p.warnings.join(' '), /Sin rejilla rítmica/);
  // syncMode 'cuts' respeta los cortes sin tocar velocidades.
  const cuts = planEdit(fakeJob(), { syncMode: 'cuts' });
  assert.ok(cuts.segments.every(s => s.speed === 1));
  assert.equal(cuts.ramps.length, 0);
});

test('targetDuration reescala de forma uniforme y avisa de lo que rompe', () => {
  const p = planEdit(fakeJob(), { targetDuration: 5 });
  near(p.estimatedDuration, 5, 0.01, 'duración objetivo alcanzada');
  assert.match(p.warnings.join(' '), /targetDuration reescala/);
  // Objetivo inalcanzable dentro de los límites de velocidad: se avisa, no se miente.
  const impossible = planEdit(fakeJob(), { targetDuration: 0.5 });
  assert.match(impossible.warnings.join(' '), /No se alcanza targetDuration/);
  assert.ok(impossible.estimatedDuration > 0.5);
  assert.ok(impossible.segments.every(s => s.speed <= 2 + 1e-9));
});

test('video sin audio: modo none, aviso explícito y grafo sin filtros de audio', () => {
  const job = fakeJob();
  job.metadata = { ...job.metadata, audio: [] };
  const p = planEdit(job, {});
  assert.equal(p.audioMode, 'none');
  assert.match(p.warnings.join(' '), /no tiene pista de audio/);
  p.outputFps = 30;
  const { filter, withAudio } = buildFilterGraph(p, job.metadata);
  assert.equal(withAudio, false);
  assert.ok(!filter.includes('atempo') && !filter.includes('atrim'));
  assert.match(filter, /concat=n=3:v=1:a=0/);
});

test('grafo FFmpeg: recorta, aplica setpts y atempo coherentes, y encaja el formato', () => {
  const job = fakeJob();
  const p = planEdit(job, { format: '1:1' });
  p.outputFps = 30;
  const { filter } = buildFilterGraph(p, job.metadata);
  assert.match(filter, /trim=start=0:end=1\.65/);
  assert.match(filter, /setpts=\(PTS-STARTPTS\)\*0\.909091/);   // 1/1.1
  assert.match(filter, /atempo=1\.1/);
  assert.match(filter, /concat=n=3:v=1:a=1/);
  assert.match(filter, /scale=1080:1080:force_original_aspect_ratio=decrease/);
  assert.match(filter, /fps=30,format=yuv420p/);
  assert.match(buildFilterGraph(p, job.metadata, { fit: 'crop' }).filter, /force_original_aspect_ratio=increase,crop=1080:1080/);
  // Una velocidad fuera del rango de atempo no llega nunca a FFmpeg.
  const bad = JSON.parse(JSON.stringify(p)); bad.segments[0].speed = 2.5;
  assert.throws(() => buildFilterGraph(bad, job.metadata), /fuera del rango de atempo/);
});

test('la exportación no usa Gemini ni toca el módulo externo', async () => {
  const source = await fs.readFile('src/edits/export.js', 'utf8');
  assert.ok(!/gemini/i.test(source.replace(/^.*NO importa.*$/mi, '')), 'export.js no debe referenciar Gemini');
  assert.ok(!/fetch\(/.test(source), 'export.js no debe hacer peticiones de red');
});

test('exportación real a MP4: cortes, rampas, audio y original intacto', { timeout: 300000 }, async () => {
  await fs.mkdir(dir, { recursive: true });
  const fixture = path.join(dir, 'ramp-source.mp4');
  // 6 s a 30 FPS: rojo 1.65 s, azul 1.35 s, verde 3 s, con clics cada 0.5 s (120 BPM).
  await ffmpegRun(['-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=1.65', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=1.35',
    '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=30:d=3', '-f', 'lavfi', '-i', 'aevalsrc=if(lt(mod(t\\,0.5)\\,0.03)\\,0.8*sin(2*PI*1000*t)\\,0):s=16000:d=6',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]', '-map', '[v]', '-map', '3:a',
    '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', fixture]);
  const before = await hash(fixture);

  const metadata = await probe(fixture);
  assert.equal(metadata.frameRateMode, 'cfr');
  const local = await analyzeLocal(fixture, metadata);
  assert.ok(local.tempo, 'se esperaba rejilla rítmica en el fixture');
  near(local.tempo.bpm, 120, 3, 'tempo del fixture');

  const job = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', status: 'complete', metadata, local };
  const proposal = planEdit(job, { format: '16:9', syncMode: 'beats', enableSpeedRamps: true });
  proposal.sourceVideo = path.relative(process.cwd(), fixture).split(path.sep).join('/');

  // Sin aprobación no se exporta.
  await assert.rejects(exportEdit(proposal), /requiere aprobación humana/);

  proposal.approval = { status: 'aprobada', at: new Date().toISOString(), by: 'test' };
  const report = await exportEdit(proposal, { fit: 'pad' });

  assert.equal(report.measured.codec, 'h264');
  assert.equal(report.measured.width, 1920);
  assert.equal(report.measured.height, 1080);
  near(report.measured.fps, 30, 0.01, 'FPS de salida');
  assert.equal(report.measured.audioTracks, 1);
  assert.equal(report.duration.withinTolerance, true, JSON.stringify(report.duration));
  near(report.measured.duration, proposal.estimatedDuration, 0.15, 'duración medida vs estimada');
  assert.equal(proposal.syncStatus, 'validado');
  assert.ok(report.bytes > 1000);

  // El original no cambió y la salida es un archivo distinto.
  assert.equal(await hash(fixture), before);
  const target = path.resolve(report.file);
  assert.notEqual(path.resolve(fixture), target);
  // El MP4 exportado se puede volver a decodificar de principio a fin.
  await ffmpegRun(['-v', 'error', '-i', target, '-f', 'null', '-']);
  const meta = JSON.parse(await fs.readFile(path.join(path.resolve(report.directory), 'metadata.json'), 'utf8'));
  assert.equal(meta.editId, proposal.id);
  assert.equal(meta.segments.length, proposal.segments.length);
  assert.ok(meta.timeTransform.includes('setptsFactor'));
  await fs.writeFile(path.join(dir, 'export-result.json'), JSON.stringify({
    sourceSHA256: before, sourceUnchanged: true, tempo: local.tempo.bpm, segments: proposal.segments,
    estimatedDuration: proposal.estimatedDuration, export: report, syncStatus: proposal.syncStatus,
  }, null, 2));
});

test('exportación vertical 9:16 de un original sin audio', { timeout: 300000 }, async () => {
  await fs.mkdir(dir, { recursive: true });
  const fixture = path.join(dir, 'silent-source.mp4');
  await ffmpegRun(['-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=1',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-an', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', fixture]);
  const before = await hash(fixture);
  const metadata = await probe(fixture);
  assert.equal(metadata.audio.length, 0);
  const local = await analyzeLocal(fixture, metadata);
  const job = { id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', status: 'complete', metadata, local };

  const proposal = planEdit(job, { format: '9:16', approvalRequired: false });
  assert.equal(proposal.audioMode, 'none');
  assert.equal(proposal.approval.status, 'no-requerida');
  proposal.sourceVideo = path.relative(process.cwd(), fixture).split(path.sep).join('/');

  const report = await exportEdit(proposal);
  assert.equal(report.measured.width, 1080);
  assert.equal(report.measured.height, 1920);
  assert.equal(report.measured.audioTracks, 0);
  assert.equal(report.measured.codec, 'h264');
  near(report.measured.duration, 2, 0.15, 'duración de salida sin audio');
  assert.equal(await hash(fixture), before);
});

test('HTTP: crear, aprobar, exportar y descargar; rechazo sin aprobación', { timeout: 300000 }, async () => {
  process.env.GEMINI_API_KEY = '';
  await fs.mkdir(dir, { recursive: true });
  const fixture = path.join(dir, 'http-source.mp4');
  await ffmpegRun(['-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=1',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-an', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', fixture]);
  const before = await hash(fixture);

  const server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const up = await fetch(base + '/api/analysis', { method: 'POST', headers: { 'x-analysis-upload': '1' }, body: createReadStream(fixture), duplex: 'half' });
    const { id: videoJobId } = await up.json();
    let job;
    for (let i = 0; i < 300; i++) { job = await (await fetch(base + `/api/analysis/${videoJobId}`)).json(); if (job.status !== 'running') break; await new Promise(r => setTimeout(r, 100)); }
    assert.equal(job.status, 'complete');

    assert.equal((await post('/api/video-edits', { videoJobId: 'no-existe' })).status, 404);
    const created = await post('/api/video-edits', { videoJobId, format: '1:1', targetDuration: null, syncMode: 'beats', enableSpeedRamps: true, approvalRequired: true });
    assert.equal(created.status, 201);
    const proposal = await created.json();
    assert.equal(proposal.approval.status, 'pendiente');
    assert.ok(proposal.segments.length >= 1);
    assert.equal(proposal.videoJobId, videoJobId);

    // Exportar sin aprobar debe fallar con 403.
    const denied = await post(`/api/video-edits/${proposal.id}/export`, {});
    assert.equal(denied.status, 403);
    assert.match((await denied.json()).error, /aprobación humana/);
    // Aprobar exige confirmación explícita.
    assert.equal((await post(`/api/video-edits/${proposal.id}/approve`, {})).status, 400);
    const approved = await post(`/api/video-edits/${proposal.id}/approve`, { confirm: true, by: 'katherine' });
    assert.equal(approved.status, 200);
    assert.equal((await approved.json()).approval.status, 'aprobada');

    const exported = await post(`/api/video-edits/${proposal.id}/export`, {});
    assert.equal(exported.status, 200);
    const result = await exported.json();
    assert.equal(result.export.measured.width, 1080);
    assert.equal(result.export.measured.height, 1080);
    assert.equal(result.export.measured.codec, 'h264');

    const download = await fetch(base + `/api/video-edits/${proposal.id}/file`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'video/mp4');
    assert.ok((await download.arrayBuffer()).byteLength > 1000);

    // Editar segmentos invalida la aprobación y descarta el export anterior.
    const patch = (body) => fetch(base + `/api/video-edits/${proposal.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const edited = await (await patch({ segments: [{ index: 0, speed: 1.25 }] })).json();
    assert.equal(edited.segments.length, 1);
    assert.equal(edited.approval.status, 'pendiente', 'editar debe invalidar la aprobación');
    assert.equal(edited.export, null, 'el informe de exportación anterior ya no describe esta propuesta');
    // Este fixture no tiene audio, así que nunca hubo rejilla: el estado sigue
    // siendo 'datos-insuficientes'. Lo que nunca debe quedar es 'validado'.
    assert.equal(edited.syncStatus, 'datos-insuficientes');
    assert.notEqual(edited.syncStatus, 'validado');
    assert.equal(edited.segments[0].reason, 'ajuste-manual');
    assert.ok(Math.abs(edited.segments[0].speed * edited.segments[0].setptsFactor - 1) < 1e-9);
    assert.equal(edited.segments[0].start, 0);
    assert.ok(Math.abs(edited.estimatedDuration - edited.segments[0].end) < 1e-6);
    // Y por tanto exportar vuelve a estar bloqueado.
    assert.equal((await post(`/api/video-edits/${proposal.id}/export`, {})).status, 403);
    // Reenviar la velocidad exacta NO debe marcar el segmento como editado:
    // de lo contrario, tocar un trozo marcaría todos los demás como manuales.
    const proposal2 = await (await post('/api/video-edits', { videoJobId, format: '1:1' })).json();
    const original = proposal2.segments[0];
    const sinTocar = await (await fetch(base + `/api/video-edits/${proposal2.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ segments: proposal2.segments.map((s, index) => ({ index, speed: s.speed })) }),
    })).json();
    assert.equal(sinTocar.segments[0].reason, original.reason, 'reenviar la misma velocidad no es una edición');
    assert.equal(sinTocar.segments[0].speed, original.speed, 'la velocidad exacta debe conservarse');
    assert.equal(sinTocar.estimatedDuration, proposal2.estimatedDuration, 'la duración no debe desplazarse sola');

    // Entradas inválidas se rechazan con mensaje concreto.
    assert.equal((await patch({ segments: [] })).status, 400);
    assert.match((await (await patch({ segments: [{ index: 99 }] })).json()).error, /fuera de rango/);
    assert.match((await (await patch({ segments: [{ index: 0, speed: 9 }] })).json()).error, /fuera del rango admitido/);
    assert.match((await (await patch({ segments: [{ index: 0 }, { index: 0 }] })).json()).error, /orden y sin repetir/);

    const fetched = await (await fetch(base + `/api/video-edits/${proposal.id}`)).json();
    // La propuesta persistida refleja la edición, no el estado previo al PATCH.
    assert.equal(fetched.segments.length, 1);
    assert.equal(fetched.export, null);
    assert.equal(fetched.approval.status, 'pendiente');
    assert.equal((await fetch(base + '/api/video-edits/11111111-1111-4111-8111-000000000000')).status, 404);
    assert.equal(await hash(fixture), before);
  } finally { await new Promise(r => server.close(r)); }
});
