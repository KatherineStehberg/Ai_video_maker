import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../src/config.js';
import { PATHS, rel, abs, workDir } from '../src/lib/paths.js';
import { buscarVideos, importarVideo, elegirArchivoVideo, dirVideos, VIDEO_MAX_BYTES } from '../src/project-editor/video-library.js';
import { makeProject } from '../src/core/project.js';
import { ensureSceneAssets } from '../src/core/asset-manager.js';
import { renderProject } from '../src/core/renderer.js';
import { loadBrand } from '../src/core/brands.js';
import { ffmpegRun, run, resolveFfmpeg, probeDuration } from '../src/lib/ffmpeg.js';
import { normalizeSpec } from '../src/generation/jobs.js';
import { normalizeOrchestratorInput, specDesdeContrato } from '../src/generation/orchestrator-contract.js';

const video = (id = 980077001, link = 'https://videos.pexels.com/test.mp4') => ({ id, duration: 2,
  image: 'https://images.pexels.com/test.jpg', url: 'https://www.pexels.com/video/test/', user: { name: 'Autor de prueba' },
  video_files: [{ width: 1920, height: 1080, file_type: 'video/mp4', link }] });
const key = CONFIG.image.pexelsKey;
const stub = (v = video(), options = {}) => async (url, init = {}) => {
  options.calls?.push({ url, init });
  if (url.includes('/search')) return Response.json({ videos: [v], total_results: 1 });
  if (url.startsWith('https://api.pexels.com')) return Response.json(v);
  if (options.redirect) return new Response(null, { status: 302, headers: { location: options.redirect } });
  return new Response('fake mp4 bytes', { headers: { 'content-type': options.type || 'video/mp4', ...(options.length ? { 'content-length': options.length } : {}) } });
};
const probe = async () => ({ ancho: 1920, alto: 1080, duracion: 2 });

test('banco: sin clave informa indisponibilidad y no hace solicitudes', async () => {
  CONFIG.image.pexelsKey = '';
  try { const r = await buscarVideos({ consulta: 'naturaleza', fetchImpl: () => { throw Error('no debe llamar'); } }); assert.equal(r.disponible, false); }
  finally { CONFIG.image.pexelsKey = key; }
});

test('banco: busca por formato, conserva autor y no expone credenciales', async () => {
  CONFIG.image.pexelsKey = 'SECRET-TEST';
  try {
    const calls = [];
    const r = await buscarVideos({ consulta: 'naturaleza', aspecto: '16:9', fetchImpl: stub(video(), { calls }) });
    assert.equal(r.resultados[0].kind, 'video'); assert.equal(r.resultados[0].autor, 'Autor de prueba');
    assert.ok(calls[0].url.includes('orientation=landscape')); assert.ok(calls[0].url.includes('/v1/videos/search'));
    assert.ok(!JSON.stringify(r).includes(CONFIG.image.pexelsKey));
    assert.equal(elegirArchivoVideo(video(1, 'https://evil.example/clip.mp4')), null);
  } finally { CONFIG.image.pexelsKey = key; }
});

test('banco: descarga a cache con licencia y no vuelve a pedir el clip', async () => {
  CONFIG.image.pexelsKey = 'SECRET-TEST'; const id = 980077001;
  const target = path.join(dirVideos(), `${id}_16x9.mp4`);
  fs.rmSync(target, { force: true }); fs.rmSync(`${target}.json`, { force: true });
  try {
    const r = await importarVideo({ id, aspecto: '16:9', fetchImpl: stub(), probeImpl: probe });
    assert.equal(r.credito.kind, 'video'); assert.ok(r.credito.licenciaUrl); assert.equal(r.cache, false);
    const cached = await importarVideo({ id, aspecto: '16:9', fetchImpl: () => { throw Error('cache'); } }); assert.equal(cached.cache, true);
  } finally { CONFIG.image.pexelsKey = key; fs.rmSync(target, { force: true }); fs.rmSync(`${target}.json`, { force: true }); }
});

test('banco: rechaza redirección externa, MIME incorrecto, tamaño excesivo e ID inválido', async () => {
  CONFIG.image.pexelsKey = 'SECRET-TEST';
  try {
    for (const [i, options] of [{ redirect: 'http://127.0.0.1/private' }, { type: 'text/html' }, { length: VIDEO_MAX_BYTES + 1 }].entries()) {
      const id = 980077020 + i;
      await assert.rejects(importarVideo({ id, aspecto: '16:9', fetchImpl: stub(video(id), options), probeImpl: probe }));
      assert.ok(!fs.existsSync(path.join(dirVideos(), `${id}_16x9.mp4`)));
    }
    await assert.rejects(importarVideo({ id: '../secret', fetchImpl: stub() }), /Identificador/);
  } finally { CONFIG.image.pexelsKey = key; }
});

test('contrato: modo de clips y voz Edge llegan desde el orquestador hasta la generación', () => {
  const c = normalizeOrchestratorInput({ script: 'Un guion.', visualMode: 'video-only', voice: { provider: 'edge', name: 'es-CL-CatalinaNeural' } });
  const s = normalizeSpec(specDesdeContrato(c));
  assert.equal(s.visualMode, 'video-only'); assert.equal(s.voice.provider, 'edge');
  assert.throws(() => normalizeSpec({ prompt: 'Un video', visualMode: 'inventado' }), /Modo visual/);
});

test('solo clips: no sustituye silenciosamente el movimiento por una imagen', async () => {
  CONFIG.image.pexelsKey = '';
  try {
    const p = makeProject({ visualMode: 'video-only', scenes: [{ text: 'Una persona caminando.' }] });
    await assert.rejects(ensureSceneAssets(p, loadBrand(p.brand)), /solo video/);
    assert.equal(p.scenes[0].assetPath, null);
  } finally { CONFIG.image.pexelsKey = key; }
});

test('MP4 real: el movimiento del clip permanece y un clip corto cubre toda la escena', async () => {
  const p = makeProject({ brand: 'personal', aspectRatio: '16:9', captions: { enabled: false }, voice: { enabled: false },
    scenes: [{ text: 'Prueba de movimiento.', duration: 3, showOnScreenText: false, kenBurns: 'none' }] });
  const dir = workDir(p.id); const source = path.join(dir, 'moving.mp4');
  await ffmpegRun(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
  const originalFetch = globalThis.fetch;
  const clipId = 980077041;
  CONFIG.image.pexelsKey = 'SECRET-TEST';
  globalThis.fetch = async (url, init) => {
    if (url.startsWith('https://api.pexels.com')) return stub(video(clipId))(url, init);
    return new Response(fs.readFileSync(source), { headers: { 'content-type': 'video/mp4' } });
  };
  try {
    await ensureSceneAssets(p, loadBrand(p.brand));
    assert.equal(p.scenes[0].assetKind, 'video');
    assert.equal(p.scenes[0].assetProvider, 'pexels-video');
    assert.equal(p.scenes[0].assetCredit.duracion, 1);
  } finally { globalThis.fetch = originalFetch; CONFIG.image.pexelsKey = key; }
  const r = await renderProject(p, loadBrand(p.brand), { aspectRatio: '16:9' });
  const result = abs(r.file);
  assert.ok(Math.abs(await probeDuration(result) - 3) < 0.15);
  const { ffmpeg } = await resolveFfmpeg();
  const hashes = await run(ffmpeg, ['-v', 'error', '-i', result, '-vf', 'fps=4,scale=160:90', '-f', 'framemd5', '-']);
  assert.equal(hashes.code, 0);
  const frames = hashes.stdout.split('\n').filter(l => l && !l.startsWith('#'));
  assert.ok(frames.length >= 11, 'hay frames hasta el final de la escena');
  assert.ok(new Set(frames.map(l => l.split(',').at(-1).trim())).size >= 3, 'no es una imagen fija');
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(result, { force: true });
  fs.rmSync(abs(p.scenes[0].assetPath), { force: true }); fs.rmSync(abs(p.scenes[0].assetPath) + '.json', { force: true });
});

test('HTTP: búsqueda e importación funcionan desde el editor y conservan las guardas de escritura', async () => {
  const { createServer } = await import('../src/server.js');
  const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const original = globalThis.fetch;
  CONFIG.image.pexelsKey = 'SECRET-TEST';
  globalThis.fetch = async (url, init) => String(url).startsWith('https://api.pexels.com') ? stub()(url, init) : original(url, init);
  try {
    const response = await original(`${base}/api/project-editor/library/videos?q=walking&aspecto=16:9`);
    assert.equal(response.status, 200); assert.equal((await response.json()).resultados[0].kind, 'video');
    const denied = await original(`${base}/api/project-editor/library/videos/import`, { method: 'POST', body: JSON.stringify({ id: 1 }) });
    assert.equal(denied.status, 403);
    const invalid = await original(`${base}/api/project-editor/library/videos/import`, { method: 'POST', headers: { 'x-editor-request': '1', 'content-type': 'application/json', origin: base }, body: JSON.stringify({ id: '../secret' }) });
    assert.equal(invalid.status, 400);
  } finally { globalThis.fetch = original; CONFIG.image.pexelsKey = key; await new Promise(r => server.close(r)); }
});

test('vista previa: reproduce el clip en silencio junto a la voz y devuelve el audio al MP4 final', async () => {
  const { crearAudio } = await import('../src/ui/project-editor/audio.js');
  const media = () => ({ source: null, duration: 1, readyState: 1, currentTime: 0, paused: true, ended: false,
    get src() { return this.source; }, set src(value) { this.source = value; },
    getAttribute() { return this.source; }, removeAttribute() { this.source = null; }, load() {},
    async play() { this.paused = false; }, pause() { this.paused = true; } });
  const voz = media(), musica = media(), videoElement = media();
  voz.duration = 3; // La narración continúa después del primer bucle del clip.
  const control = crearAudio({ voz, musica, video: videoElement });
  const escenas = [{ start: 0, end: 3, recurso: { kind: 'video', url: '/clip.mp4' }, narracion: { url: '/voice.wav' } }];
  await control.empezar({ modo: 'aproximada', escenas, t: 1.25 });
  assert.equal(videoElement.src, '/clip.mp4'); assert.equal(videoElement.paused, false);
  assert.equal(videoElement.muted, true); assert.equal(videoElement.loop, true);
  assert.equal(voz.paused, false); assert.equal(voz.muted, false);
  control.volumenEscucha(0.8); assert.equal(videoElement.muted, true);
  control.parar(); assert.equal(videoElement.paused, true);
  await control.empezar({ modo: 'mp4', escenas, t: 0 });
  assert.equal(videoElement.muted, false); assert.equal(videoElement.loop, false);
});
