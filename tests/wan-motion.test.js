import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { wanConfig, checkWan, generateWanClip, executeWan, validateWanVideo } from '../src/providers/video-generation/wan.js';
import { PATHS, abs, rel, workDir } from '../src/lib/paths.js';
import { ffmpegRun, probeDuration } from '../src/lib/ffmpeg.js';
import { makeProject, saveProject, loadProject, deleteProject } from '../src/core/project.js';
import { ensureSceneAssets } from '../src/core/asset-manager.js';
import { loadBrand } from '../src/core/brands.js';
import { renderProject } from '../src/core/renderer.js';
import { guardar, regenerarEscena, estadoTrabajo } from '../src/project-editor/service.js';
import { normalizeSpec, estimarCosto } from '../src/generation/jobs.js';
import { normalizeOrchestratorInput, specDesdeContrato } from '../src/generation/orchestrator-contract.js';

const dir = path.join(PATHS.root, '.tmp', `wan-test-${randomUUID()}`);
const prompt = `Prueba Wan ${randomUUID()}: una persona camina.`;
const keys = ['WAN_ENABLED', 'WAN_BACKEND', 'WAN_REPO_DIR', 'WAN_MODEL_DIR', 'WAN_PYTHON', 'WAN_MAX_SCENES',
  'WAN_CLIP_SECONDS', 'WAN_SPACE_ID', 'WAN_SPACE_API_NAME', 'WAN_SPACE_ARGS', 'HF_TOKEN', 'PYTHONPATH', 'WAN_TEST_FAIL'];
const env = Object.fromEntries(keys.map(k => [k, process.env[k]]));
const targets = new Set(), projects = [];
const cacheDir = path.join(PATHS.assetsImages, '_library', 'wan');
let originalCache;
const calls = () => fs.existsSync(path.join(dir, 'calls.jsonl'))
  ? fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const remember = result => { targets.add(abs(result.path)); return result; };

before(async () => {
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(path.join(dir, 'model'));
  originalCache = new Set(fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : []);
  fs.writeFileSync(path.join(dir, 'model', 'config.json'), '{}');
  await ffmpegRun(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dir, 'fixture.mp4')]);
  // Test-only model CLI. Exercise the real Python adapter and real FFmpeg media.
  fs.writeFileSync(path.join(dir, 'generate.py'), `import sys, os, json, shutil\nfrom pathlib import Path\nargs=sys.argv[1:]\nroot=Path(__file__).parent\nwith open(root/'calls.jsonl','a') as f: f.write(json.dumps(args)+'\\n')\nif os.getenv('WAN_TEST_FAIL'): sys.exit(1)\nshutil.copyfile(root/'fixture.mp4', args[args.index('--save_file')+1])\n`);
  Object.assign(process.env, { WAN_ENABLED: '1', WAN_BACKEND: 'local', WAN_REPO_DIR: dir,
    WAN_MODEL_DIR: path.join(dir, 'model'), WAN_PYTHON: 'python3', WAN_CLIP_SECONDS: '5', WAN_MAX_SCENES: '8' });
});

after(() => {
  for (const file of targets) { fs.rmSync(file, { force: true }); fs.rmSync(`${file}.json`, { force: true }); }
  if (fs.existsSync(cacheDir)) for (const name of fs.readdirSync(cacheDir)) {
    if (!originalCache.has(name)) fs.rmSync(path.join(cacheDir, name), { recursive: true, force: true });
  }
  for (const p of projects) { deleteProject(p.id); fs.rmSync(workDir(p.id), { recursive: true, force: true }); }
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(env)) value === undefined ? delete process.env[key] : process.env[key] = value;
});

test('Wan desactivado nunca llama ni sustituye clips por imágenes', async () => {
  process.env.WAN_ENABLED = '0';
  try {
    assert.equal(wanConfig().configured, false);
    assert.equal((await checkWan({ execute: () => { throw Error('no llamar'); } })).available, false);
    const p = makeProject({ visualMode: 'wan', scenes: [{ text: prompt }] });
    await assert.rejects(ensureSceneAssets(p, loadBrand(p.brand)), /no está configurado/);
    assert.equal(p.scenes[0].assetPath, null);
  } finally { process.env.WAN_ENABLED = '1'; }
});

test('el modo Wan llega desde el orquestador, persiste y mantiene la procedencia', () => {
  const spec = normalizeSpec(specDesdeContrato(normalizeOrchestratorInput({ script: 'Un guion.', visualMode: 'wan' })));
  assert.equal(spec.visualMode, 'wan');
  assert.match(estimarCosto({}, spec).resumen, /hardware/);
  const p = makeProject({ visualMode: 'wan', scenes: [{ text: prompt, wanReferencePath: 'data/ref.png', wanRevision: 3 }] });
  projects.push(p); saveProject(p);
  assert.equal(loadProject(p.id).scenes[0].wanRevision, 3);
  assert.equal(loadProject(p.id).visualMode, 'wan');
  assert.equal(loadProject(p.id).scenes[0].wanReferencePath, 'data/ref.png');
});

test('motor Python local produce MP4 válido, conserva prompts literales y reutiliza cache', async () => {
  const literal = `${prompt} $(touch NO_DEBE_EXISTIR) \"texto\"`;
  const start = calls().length;
  const r = remember(await generateWanClip({ prompt: literal, aspect: '16:9' }));
  assert.equal(r.provider, 'wan'); assert.equal(r.credit.generated, true); assert.equal(r.credit.duration, 1);
  assert.equal(calls().length, start + 1);
  const args = calls().at(-1); assert.equal(args[args.indexOf('--prompt') + 1], literal);
  assert.equal(args[args.indexOf('--size') + 1], '1280*704');
  assert.equal(args[args.indexOf('--frame_num') + 1], '121');
  assert.ok(!fs.existsSync(path.join(dir, 'NO_DEBE_EXISTIR')));
  const cached = await generateWanClip({ prompt: literal, aspect: '16:9' });
  assert.equal(cached.cache, true); assert.equal(calls().length, start + 1);
  remember(await generateWanClip({ prompt: literal, aspect: '16:9', variant: 1 }));
  assert.equal(calls().length, start + 2); assert.notEqual(calls().at(-1).at(-1), args.at(-1));
});

test('rechaza referencias fuera del repositorio, falso MP4 y fallos sin guardar resultado', async () => {
  await assert.rejects(generateWanClip({ prompt, referencePath: path.join(dir, 'fixture.mp4') }), /referencia/);
  const fake = path.join(dir, 'fake.mp4'); fs.writeFileSync(fake, 'no es video');
  await assert.rejects(validateWanVideo(fake), /inválido/);
  let output;
  await assert.rejects(generateWanClip({ prompt: `${prompt} bad` }, { execute: async r => { output = r.output; fs.writeFileSync(output, 'invalid'); } }), /inválido/);
  assert.ok(!fs.existsSync(path.dirname(output)));
});

test('preserva recursos existentes, ignora excluidos y detiene lotes que exceden el límite antes de generar', async () => {
  const existing = remember(await generateWanClip({ prompt: `${prompt} existing` }));
  const start = calls().length;
  const p = makeProject({ visualMode: 'wan', scenes: [{ text: prompt, assetPath: existing.path }, { text: prompt, excluida: true }] });
  await ensureSceneAssets(p, loadBrand(p.brand)); assert.equal(calls().length, start);
  process.env.WAN_MAX_SCENES = '1';
  try {
    const tooMany = makeProject({ visualMode: 'wan', scenes: [{ text: prompt }, { text: prompt }] });
    await assert.rejects(ensureSceneAssets(tooMany, loadBrand(tooMany.brand)), /hasta 1/);
    assert.equal(calls().length, start);
  } finally { process.env.WAN_MAX_SCENES = '8'; }
});

test('impide generaciones concurrentes y no reintenta cuando falla el motor', async () => {
  let release, entered;
  const started = new Promise(r => { entered = r; });
  const first = generateWanClip({ prompt: `${prompt} waiting` }, { execute: async () => {
    entered(); await new Promise(r => { release = r; }); throw Error('Fallo esperado');
  } });
  await started;
  await assert.rejects(generateWanClip({ prompt: `${prompt} concurrent` }), /otro clip/);
  release(); await assert.rejects(first, /Fallo esperado/);
  process.env.WAN_TEST_FAIL = '1'; const start = calls().length;
  try { await assert.rejects(generateWanClip({ prompt: `${prompt} fail` }), /no está disponible/); assert.equal(calls().length, start + 1); }
  finally { delete process.env.WAN_TEST_FAIL; }
});

test('imagen a video: regenera sólo la escena elegida, guarda referencia y restaura el visual si falla', async () => {
  const image = path.join(PATHS.assetsImages, `wan-reference-${randomUUID()}.png`);
  await ffmpegRun(['-f', 'lavfi', '-i', 'color=c=blue:s=160x90', '-frames:v', '1', image]); targets.add(image);
  const p = makeProject({ visualMode: 'wan', scenes: [{ text: prompt, assetPath: rel(image), assetKind: 'image' }, { text: 'Otra escena pendiente.' }] });
  projects.push(p); saveProject(p); await guardar(p.id, { visualMode: 'wan' });
  const start = calls().length;
  await regenerarEscena(p.id, 0, { visual: true, voz: false });
  let status;
  for (let i = 0; i < 100; i++) {
    status = await estadoTrabajo(p.id);
    if (status.job.status !== 'running') break;
    await new Promise(r => setTimeout(r, 30));
  }
  assert.equal(status.job.status, 'complete');
  const generated = loadProject(p.id); targets.add(abs(generated.scenes[0].assetPath));
  assert.equal(generated.scenes[0].assetProvider, 'wan'); assert.equal(generated.scenes[0].wanReferencePath, rel(image));
  assert.equal(generated.scenes[1].assetPath, null); assert.equal(calls().length, start + 1);
  assert.equal(calls().at(-1).at(-1), image);
  process.env.WAN_TEST_FAIL = '1';
  try {
    await regenerarEscena(p.id, 0, { visual: true, voz: false });
    for (let i = 0; i < 100; i++) {
      status = await estadoTrabajo(p.id);
      if (status.job.status !== 'running') break;
      await new Promise(r => setTimeout(r, 30));
    }
    assert.equal(status.job.status, 'failed');
    assert.equal(loadProject(p.id).scenes[0].assetPath, generated.scenes[0].assetPath);
  } finally { delete process.env.WAN_TEST_FAIL; }
});

test('el clip Wan pasa al montaje final real y conserva duración de la escena', async () => {
  const p = makeProject({ brand: 'personal', aspectRatio: '16:9', visualMode: 'wan', voice: { enabled: false },
    captions: { enabled: false }, scenes: [{ text: `${prompt} render`, duration: 3, showOnScreenText: false }] });
  projects.push(p);
  await ensureSceneAssets(p, loadBrand(p.brand)); targets.add(abs(p.scenes[0].assetPath));
  const result = await renderProject(p, loadBrand(p.brand), { aspectRatio: '16:9' }); targets.add(abs(result.file));
  assert.ok(Math.abs(await probeDuration(abs(result.file)) - 3) < 0.2);
});

test('Space: configura parámetros sólo en backend y transfiere imagen por Gradio sin filtrar token', async () => {
  const stubDir = path.join(dir, 'stub'); fs.mkdirSync(stubDir);
  fs.writeFileSync(path.join(stubDir, 'gradio_client.py'), `import shutil,json\nfrom pathlib import Path\nclass Client:\n def __init__(self,src,**kwargs):\n  self.output_dir=kwargs['download_files'];Path(self.output_dir).mkdir(exist_ok=True,parents=True)\n def view_api(self,**kwargs):return {'named_endpoints':{'/generate':{}}}\n def predict(self,**kwargs):\n  with open(${JSON.stringify(path.join(dir, 'space-call.json'))},'w') as f:json.dump(kwargs,f)\n  target=Path(self.output_dir)/'remote.mp4';shutil.copyfile(${JSON.stringify(path.join(dir, 'fixture.mp4'))},target);return {'video':str(target)}\ndef handle_file(p):return {'path':p}\n`);
  const previous = Object.fromEntries(['WAN_BACKEND', 'WAN_SPACE_ID', 'WAN_SPACE_API_NAME', 'WAN_SPACE_ARGS', 'PYTHONPATH', 'HF_TOKEN'].map(k => [k, process.env[k]]));
  Object.assign(process.env, { WAN_BACKEND: 'space', WAN_SPACE_ID: 'Test/Wan', WAN_SPACE_API_NAME: '/generate',
    WAN_SPACE_ARGS: '{"prompt":"$prompt","image":"$image","duration":"$seconds"}', PYTHONPATH: stubDir, HF_TOKEN: 'SECRET-WAN-TEST' });
  try {
    assert.equal((await checkWan()).available, true);
    assert.equal(estimarCosto({}, { visualMode: 'wan' }).tieneCostoPotencial, true);
    assert.ok(!JSON.stringify(wanConfig()).includes('SECRET-WAN-TEST'));
    const r = remember(await generateWanClip({ prompt: `${prompt} space` })); assert.equal(r.credit.backend, 'space');
    const sent = JSON.parse(fs.readFileSync(path.join(dir, 'space-call.json'))); assert.equal(sent.prompt, `${prompt} space`); assert.equal(sent.image, null);
  } finally { for (const [k, v] of Object.entries(previous)) v === undefined ? delete process.env[k] : process.env[k] = v; }
});

test('comprobación HTTP protegida no genera y la configuración pública no expone rutas', async () => {
  const { createServer } = await import('../src/server.js'); const server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const url = `http://127.0.0.1:${server.address().port}`;
  process.env.WAN_ENABLED = '0'; const start = calls().length;
  try {
    assert.equal((await fetch(`${url}/api/project-editor/wan/check`, { method: 'POST' })).status, 403);
    const response = await fetch(`${url}/api/project-editor/wan/check`, { method: 'POST', headers: { 'x-editor-request': '1' } });
    assert.equal(response.status, 200); assert.equal((await response.json()).available, false);
    const config = await (await fetch(`${url}/api/video-generation/config`)).json();
    assert.equal(config.wan.configured, false); assert.ok(!JSON.stringify(config.wan).includes(dir));
    assert.equal(calls().length, start);
  } finally { process.env.WAN_ENABLED = '1'; server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
