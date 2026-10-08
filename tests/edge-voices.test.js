import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { listVoices, synthesize } from '../src/providers/tts/edge.js';
import { narrateProject } from '../src/core/tts.js';
import { makeProject, saveProject, deleteProject } from '../src/core/project.js';
import { guardar } from '../src/project-editor/service.js';
import { abs, workDir } from '../src/lib/paths.js';
import { probeDuration, resolveFfmpeg, run } from '../src/lib/ffmpeg.js';
import { runPipeline } from '../src/core/pipeline.js';

// Provider service is simulated; real Python subprocesses and FFmpeg are used.
// No claim about the quality or availability of Microsoft's live speech service.
const dir = path.resolve('.tmp/edge-test');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'edge_tts.py'), `
import json, wave, struct, math, os
async def list_voices():
    return [{'ShortName':'en-US-TestNeural','Locale':'en-US','Gender':'Male'}, {'ShortName':'es-CL-TestNeural','Locale':'es-CL','Gender':'Female'}]
class Communicate:
    def __init__(self, text, voice, **kwargs):
        self.text=text
        self.voice=voice
    async def save(self, output):
        with open(os.path.join(os.path.dirname(__file__), 'requests.jsonl'), 'a') as f:
            f.write(json.dumps({'text':self.text,'voice':self.voice})+'\\n')
        if os.environ.get('EDGE_TEST_FAIL') == '1':
            raise RuntimeError('simulated offline service')
        with wave.open(output, 'wb') as w:
            w.setparams((1,2,24000,0,'NONE','not compressed'))
            frequency = 440 if self.voice.startswith('es') else 880
            w.writeframes(b''.join(struct.pack('<h', int(7000*math.sin(2*math.pi*frequency*i/24000))) for i in range(7200)))
`);
const oldPython = process.env.EDGE_TTS_PYTHON;
const oldModulePath = process.env.PYTHONPATH;
process.env.EDGE_TTS_PYTHON = 'python3'; process.env.PYTHONPATH = dir;
const requests = path.join(dir, 'requests.jsonl');
fs.rmSync(requests, { force: true });

test.after(() => {
  if (oldPython === undefined) delete process.env.EDGE_TTS_PYTHON; else process.env.EDGE_TTS_PYTHON = oldPython;
  if (oldModulePath === undefined) delete process.env.PYTHONPATH; else process.env.PYTHONPATH = oldModulePath;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('voces: catálogo consultado, Chile primero y muestra WAV decodificable', async () => {
  const v = await listVoices(); assert.equal(v[0].language, 'es-CL'); assert.equal(v[1].language, 'en-US');
  const file = path.join(dir, 'preview.wav');
  await synthesize('Una muestra', file, { voice: v[0].name });
  assert.ok(await probeDuration(file) > 0.25);
});

test('voces: los tramos bilingües usan voces diferentes y llegan a la narración', async () => {
  const p = makeProject({ language: 'bilingual', voice: { provider: 'edge', name: 'es-CL-TestNeural' },
    scenes: [{ text: 'Hola. [en]Hello.[/en]', duration: 1 }] });
  try {
    const r = await narrateProject(p);
    assert.equal(r.provider, 'edge'); assert.equal(r.errors.length, 0);
    const sent = fs.readFileSync(requests, 'utf8').trim().split('\n').map(x => JSON.parse(x)).slice(-2);
    assert.deepEqual(sent.map(x => x.voice), ['es-CL-TestNeural', 'en-US-TestNeural']);
    assert.deepEqual(sent.map(x => x.text), ['Hola.', 'Hello.']);
    assert.ok(r.durations[0] > 0.45);
    p.scenes[0].narrationPath = r.narrations[0];
    const { ffmpeg } = await resolveFfmpeg();
    const level = await run(ffmpeg, ['-hide_banner', '-i', abs(r.narrations[0]), '-af', 'volumedetect', '-f', 'null', '-']);
    assert.match(level.stderr, /mean_volume: -\d/);
  } finally { fs.rmSync(workDir(p.id), { recursive: true, force: true }); }
});

test('voces: selección y velocidad se guardan y sobreviven al reabrir', async () => {
  const p = makeProject({ scenes: [{ text: 'Hola.' }] }); saveProject(p);
  try {
    const saved = await guardar(p.id, { revision: 1, voice: { provider: 'edge', name: 'es-CL-TestNeural', rate: 2 }, visualMode: 'video-only' });
    assert.equal(saved.proyecto.voice.provider, 'edge'); assert.equal(saved.proyecto.voice.name, 'es-CL-TestNeural');
    assert.equal(saved.proyecto.voice.rate, 2); assert.equal(saved.proyecto.visualMode, 'video-only');
  } finally { deleteProject(p.id); }
});

test('voces: un fallo de la voz elegida detiene la exportación, no genera éxito silencioso', async () => {
  const p = makeProject({ voice: { provider: 'edge', name: 'es-CL-TestNeural' }, scenes: [{ text: 'Hola.' }] });
  process.env.EDGE_TEST_FAIL = '1';
  try { await assert.rejects(runPipeline(p, { steps: ['narration'] }), /No se pudo generar la voz Edge/); }
  finally { delete process.env.EDGE_TEST_FAIL; deleteProject(p.id); fs.rmSync(workDir(p.id), { recursive: true, force: true }); }
});

test('HTTP: la muestra de voz del editor devuelve un WAV y exige cabecera de escritura', async () => {
  const { createServer } = await import('../src/server.js');
  const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const body = JSON.stringify({ provider: 'edge', voice: 'es-CL-TestNeural', text: 'Hola.' });
    const denied = await fetch(`${base}/api/project-editor/preview-voice`, { method: 'POST', body }); assert.equal(denied.status, 403);
    const res = await fetch(`${base}/api/project-editor/preview-voice`, { method: 'POST', headers: { 'x-editor-request': '1', 'content-type': 'application/json', origin: base }, body });
    assert.equal(res.status, 200); const result = await res.json();
    const audio = await fetch(base + result.url); assert.equal(audio.status, 200);
    const bytes = Buffer.from(await audio.arrayBuffer()); assert.equal(bytes.subarray(0, 4).toString(), 'RIFF');
    const file = abs(new URL(result.url, base).searchParams.get('path')); fs.rmSync(file, { force: true });
  } finally { await new Promise(r => server.close(r)); }
});
