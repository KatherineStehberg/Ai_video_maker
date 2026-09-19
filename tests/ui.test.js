import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, uploadVideo, poll, ApiError } from '../src/ui/editor/api.js';
import { initialState, reduce, validateFile, canAnalyze, canPropose, canApprove, canExport, exportBlockedReason, formatBytes } from '../src/ui/editor/state.js';
import { fileSummary, rhythmSummary, collectWarnings, timelineModel, SYNC_STATUS_TEXT, rampRow } from '../src/ui/editor/format.js';

const file = (over = {}) => ({ name: 'clip.mp4', size: 1024 * 1024, type: 'video/mp4', ...over });
const analysis = (over = {}) => ({
  id: 'abc', status: 'complete', progress: 100,
  metadata: { duration: 6, fps: 30, nominalFps: 30, frameRateMode: 'cfr', codec: 'h264', width: 640, height: 360,
    audio: [{ index: 1, codec: 'aac', channels: 1, sampleRate: 16000 }] },
  local: { scenes: [{ timestamp: 1.5, frame: 45, frameExact: true }], onsets: [{ timestamp: 0.5 }],
    beats: [{ timestamp: 0.5, evidence: { onsetSupported: true } }, { timestamp: 1.0, evidence: { onsetSupported: false } }],
    tempo: { bpm: 120, period: 0.5, score: 0.9 }, sync: { status: 'parcial', onBeat: 1, cuts: 3, ratio: 1 / 3, toleranceSeconds: 0.06 }, ramps: [] },
  cuts: [{ timestamp: 1.5, frame: 45, frameExact: true, source: 'local', reason: 'Cambio visual' }],
  ...over,
});
const proposal = (over = {}) => ({
  id: 'p1', format: '9:16', dimensions: { width: 1080, height: 1920 },
  syncStatus: 'propuesto', approvalRequired: true, approval: { status: 'pendiente' },
  segments: [{ sourceStart: 0, sourceEnd: 1.5, start: 0, end: 1.36, speed: 1.1, setptsFactor: 0.909091, reason: 'beat-aligned' }],
  ramps: [], estimatedDuration: 6, audioMode: 'stretch', warnings: [], ...over,
});

// 1 y 2 — carga de archivo válido y rechazo de archivo inválido
test('validación de archivo: acepta video real y rechaza lo que no lo es', () => {
  assert.equal(validateFile(file()).ok, true);
  assert.equal(validateFile(file({ type: '', name: 'clip.MOV' })).ok, true);      // por extensión
  assert.equal(validateFile(file({ type: 'application/pdf', name: 'doc.pdf' })).ok, false);
  assert.match(validateFile(file({ type: 'application/pdf', name: 'doc.pdf' })).error, /Formato no admitido/);
  assert.match(validateFile(file({ size: 0 })).error, /vacío/);
  assert.match(validateFile(file({ size: 3 * 1024 ** 3 })).error, /límite es 2 GiB/);
  assert.match(validateFile(null).error, /Selecciona un archivo/);
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(-1), '—');

  // Un archivo inválido deja la interfaz en error y no permite analizar.
  const s = reduce(initialState(), { type: 'file-selected', file: file({ type: 'text/plain', name: 'a.txt' }) });
  assert.equal(s.state, 'error');
  assert.equal(canAnalyze(s), false);
});

// 3 — inicio del análisis (subida con XHR simulado)
test('subida: envía la cabecera exigida, informa progreso y traduce errores HTTP', async () => {
  const sent = [];
  class MockXHR {
    constructor() { this.upload = {}; this.headers = {}; }
    open(method, url) { sent.push({ method, url }); }
    setRequestHeader(k, v) { this.headers[k] = v; }
    send() {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
      this.status = 202; this.responseText = JSON.stringify({ id: 'job-1', status: 'running' });
      this.onload();
    }
  }
  const percents = [];
  const job = await uploadVideo(file(), { XHR: MockXHR, onProgress: p => percents.push(p) });
  assert.equal(job.id, 'job-1');
  assert.deepEqual(percents, [50]);
  assert.equal(sent[0].url, '/api/analysis');

  class FailXHR extends MockXHR {
    send() { this.status = 413; this.responseText = JSON.stringify({ error: 'Límite de subida: 2 GiB' }); this.onload(); }
  }
  await assert.rejects(uploadVideo(file(), { XHR: FailXHR }), e => e instanceof ApiError && e.status === 413 && /2 GiB/.test(e.message));

  class NetXHR extends MockXHR { send() { this.onerror(); } }
  await assert.rejects(uploadVideo(file(), { XHR: NetXHR }), /Error de conexión/);
});

// 4 — visualización de resultados, y 11 — video sin audio
test('derivaciones de la vista: ficha, ritmo, timeline y caso sin audio', () => {
  const rows = Object.fromEntries(fileSummary(file({ name: 'a.mp4', size: 2048 }), analysis().metadata));
  assert.equal(rows['Nombre'], 'a.mp4');
  assert.equal(rows['Tamaño'], '2.0 KB');
  assert.equal(rows['Duración'], '6.000 s');
  assert.equal(rows['Resolución'], '640 × 360');
  assert.equal(rows['Códec'], 'h264');
  assert.match(rows['FPS'], /30\.000 \(nominal 30\.000, CFR\)/);
  assert.match(rows['Audio'], /1 pista · aac, 1 canal/);

  // 11 — sin pista de audio se dice explícitamente, no se deja en blanco.
  const silent = analysis(); silent.metadata = { ...silent.metadata, audio: [] };
  assert.equal(Object.fromEntries(fileSummary(file(), silent.metadata))['Audio'], 'Sin pista de audio');

  const rhythm = rhythmSummary(analysis().local);
  assert.equal(rhythm.hasTempo, true);
  assert.match(rhythm.tempo, /120\.00 BPM/);
  assert.match(rhythm.sync, /parcial · 1\/3 cortes/);
  // Sin tempo no se inventa una cifra: se explica el motivo.
  const none = rhythmSummary({ tempo: null, tempoReason: 'Evidencia insuficiente', beats: [], sync: { reason: 'sin datos' } });
  assert.equal(none.hasTempo, false);
  assert.match(none.tempo, /Sin rejilla rítmica\. Evidencia insuficiente/);

  const model = timelineModel(analysis(), proposal());
  assert.equal(model.duration, 6);
  assert.equal(model.cuts[0].at, 1.5 / 6);
  assert.equal(model.beats[0].supported, true);
  assert.equal(model.beats[1].supported, false);
  assert.equal(model.segments[0].kind, 'acelera');
  assert.equal(timelineModel(null, null), null);
  assert.equal(timelineModel({ metadata: { duration: 0 } }, null), null);

  const ramp = rampRow({ start: 0, end: 1.65, startFrame: 0, endFrame: 50, currentDuration: 1.65, targetDuration: 1.5, setptsFactor: 0.909091, reason: 'Ajustar' });
  assert.equal(ramp.frames, '0 → 50');
  assert.match(ramp.factor, /1\.1000× · setpts 0\.9091/);
});

// 5, 7, 8, 9, 10, 12 — cliente de API contra un backend simulado
test('cliente API: propuesta, aprobación, exportación, descarga y errores HTTP', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (url === '/api/analysis/config') return { ok: true, json: async () => ({ hasKey: false, model: 'm' }) };
    if (url === '/api/video-edits' && init.method === 'POST') return { ok: true, json: async () => proposal({ format: init && JSON.parse(init.body).format }) };
    if (url.endsWith('/approve')) return { ok: true, json: async () => proposal({ approval: { status: 'aprobada', by: 'editor-web' } }) };
    if (url.endsWith('/export')) return { ok: true, json: async () => ({ id: 'p1', syncStatus: 'validado', export: { measured: { width: 1080, height: 1920 } } }) };
    if (url === '/api/video-edits/missing') return { ok: false, status: 404, json: async () => ({ error: 'Propuesta de edición no encontrada' }) };
    if (url === '/api/video-edits/boom') return { ok: false, status: 500, json: async () => { throw new Error('respuesta sin cuerpo JSON'); } };
    return { ok: true, json: async () => ({}) };
  };
  const api = createApi({ fetchImpl });

  const config = await api.analysisConfig();
  assert.equal(config.hasKey, false);
  assert.ok(!('key' in config), 'la configuración nunca debe traer la clave');

  // 5 y 12 — creación de propuesta en formato vertical 9:16
  const created = await api.createProposal({ videoJobId: 'abc', format: '9:16', targetDuration: null, syncMode: 'beats', enableSpeedRamps: true, approvalRequired: true });
  assert.equal(created.format, '9:16');
  assert.equal(created.dimensions.height, 1920);
  const body = calls.find(c => c.url === '/api/video-edits').body;
  assert.deepEqual(body, { videoJobId: 'abc', format: '9:16', targetDuration: null, syncMode: 'beats', enableSpeedRamps: true, approvalRequired: true });

  // 7 — aprobación con confirmación explícita
  const approved = await api.approveProposal('p1', 'editor-web');
  assert.equal(approved.approval.status, 'aprobada');
  assert.deepEqual(calls.find(c => c.url.endsWith('/approve')).body, { confirm: true, by: 'editor-web' });

  // 8 y 9 — exportación y URL de descarga
  const exported = await api.exportProposal('p1', 'pad');
  assert.equal(exported.syncStatus, 'validado');
  assert.deepEqual(calls.find(c => c.url.endsWith('/export')).body, { fit: 'pad' });
  assert.equal(api.exportedFileUrl('p1'), '/api/video-edits/p1/file');
  assert.equal(api.analysisCsvUrl('abc'), '/api/analysis/abc/export?format=csv');

  // 10 — errores HTTP: se usa el mensaje del backend cuando existe…
  await assert.rejects(api.getProposal('missing'), e => e instanceof ApiError && e.status === 404 && /no encontrada/.test(e.message));
  // …y uno genérico cuando la respuesta ni siquiera trae JSON, sin romperse.
  await assert.rejects(api.getProposal('boom'), e => e instanceof ApiError && e.status === 500 && /Error HTTP 500/.test(e.message));
});

// 6 y 14 — bloqueo de exportación y prevención de doble exportación
test('la exportación está bloqueada salvo que todo esté en su sitio', () => {
  let s = initialState();
  assert.equal(canExport(s), false);
  assert.match(exportBlockedReason(s), /Primero analiza un video/);

  s = reduce(s, { type: 'file-selected', file: file() });
  s = reduce(s, { type: 'analysis-start', id: 'abc' });
  s = reduce(s, { type: 'analysis-complete', analysis: analysis() });
  assert.equal(canPropose(s), true);
  assert.equal(canExport(s), false);
  assert.match(exportBlockedReason(s), /Primero crea una propuesta/);

  // 6 — con propuesta pero sin aprobar, sigue bloqueada
  s = reduce(s, { type: 'proposal-ready', proposal: proposal() });
  assert.equal(s.state, 'aprobacion-pendiente');
  assert.equal(canApprove(s), true);
  assert.equal(canExport(s), false);
  assert.match(exportBlockedReason(s), /debe aprobarse antes de exportar/);

  s = reduce(s, { type: 'approved', proposal: proposal({ approval: { status: 'aprobada' } }) });
  assert.equal(s.state, 'aprobado');
  assert.equal(canExport(s), true);
  assert.equal(exportBlockedReason(s), null);
  assert.equal(canApprove(s), false, 'no se aprueba dos veces');

  // 14 — durante la exportación el botón queda bloqueado
  const exporting = reduce(s, { type: 'export-start' });
  assert.equal(exporting.state, 'exportando');
  assert.equal(canExport(exporting), false);
  assert.match(exportBlockedReason(exporting), /Exportación en curso/);

  const done = reduce(exporting, { type: 'export-complete', result: { syncStatus: 'validado', export: { measured: {} } } });
  assert.equal(done.state, 'exportado');
  assert.equal(done.proposal.syncStatus, 'validado');

  // Un análisis fallido nunca habilita la exportación.
  const failed = reduce(s, { type: 'analysis-complete', analysis: analysis({ status: 'error' }) });
  assert.equal(canExport(failed), false);
  // Una propuesta que no requiere aprobación pasa directa a 'aprobado'.
  const auto = reduce(reduce(initialState(), { type: 'file-selected', file: file() }), { type: 'analysis-complete', analysis: analysis() });
  const open = reduce(auto, { type: 'proposal-ready', proposal: proposal({ approvalRequired: false, approval: { status: 'no-requerida' } }) });
  assert.equal(open.state, 'aprobado');
  assert.equal(canExport(open), true);
});

// 13 — estado de polling
test('polling: no solapa peticiones, informa cada vuelta, termina y se puede cancelar', async () => {
  let calls = 0, concurrent = 0, maxConcurrent = 0;
  const fetchOnce = async () => {
    concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise(r => setTimeout(r, 5));
    concurrent--;
    return { status: ++calls < 3 ? 'running' : 'complete', progress: calls * 33 };
  };
  const ticks = [];
  const job = poll(fetchOnce, { intervalMs: 1, isDone: j => j.status !== 'running', onTick: j => ticks.push(j.progress) });
  const result = await job.done;
  assert.equal(result.status, 'complete');
  assert.equal(calls, 3);
  assert.equal(maxConcurrent, 1, 'nunca debe haber dos peticiones simultáneas');
  assert.deepEqual(ticks, [33, 66, 99]);
  assert.equal(job.running, false);

  // Cancelación: deja de pedir.
  let after = 0;
  const forever = poll(async () => { after++; return { status: 'running' }; }, { intervalMs: 1, isDone: () => false });
  await new Promise(r => setTimeout(r, 20));
  forever.stop();
  const frozen = after;
  await new Promise(r => setTimeout(r, 20));
  assert.equal(after, frozen, 'tras stop() no se hacen más peticiones');

  // Un error corta el sondeo y se propaga.
  const failing = poll(async () => { throw new ApiError('Error HTTP 500', 500); }, { intervalMs: 1, isDone: () => false });
  await assert.rejects(failing.done, /Error HTTP 500/);
  assert.equal(failing.running, false);
});

// Advertencias de sincronía: se muestran, no se suavizan
test('advertencias: el aviso de atempo aparece y nunca se afirma que los beats se conservan', () => {
  const warnings = collectWarnings(proposal({ warnings: ['El audio se estira con atempo…'] }), null);
  assert.match(warnings[0], /atempo/);
  assert.match(warnings[0], /El tempo musical puede variar/);
  assert.ok(!warnings.some(w => /beats.*(intacto|se conservan|sin cambios)/i.test(w)));

  // Sin rampas no se inventa el aviso de estiramiento.
  const flat = proposal({ segments: [{ sourceStart: 0, sourceEnd: 1, start: 0, end: 1, speed: 1, setptsFactor: 1, reason: 'corte-detectado' }], warnings: [] });
  assert.deepEqual(collectWarnings(flat, null), []);

  // Las advertencias del informe de exportación se agregan sin duplicar.
  const merged = collectWarnings(proposal({ warnings: ['aviso A'] }), { export: { audio: { timeStretched: true }, warnings: ['aviso A', 'aviso B'] } });
  assert.equal(merged.filter(w => w === 'aviso A').length, 1);
  assert.ok(merged.includes('aviso B'));

  assert.match(SYNC_STATUS_TEXT['datos-insuficientes'], /no se infirió rejilla/);
  assert.match(SYNC_STATUS_TEXT.validado, /ffprobe/);
});
