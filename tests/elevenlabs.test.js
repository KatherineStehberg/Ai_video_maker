import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as eleven from '../src/providers/tts/elevenlabs.js';
import { resolveProvider } from '../src/providers/tts/index.js';
import { speechCues } from '../src/core/speech-cues.js';
import { narrateProject } from '../src/core/tts.js';
import { makeProject, saveProject, loadProject, deleteProject } from '../src/core/project.js';
import { normalizeVoice } from '../src/generation/orchestrator-contract.js';
import { guardar, publico } from '../src/project-editor/service.js';
import { ffmpegRun } from '../src/lib/ffmpeg.js';

const alignment = text => ({ characters: [...text], character_start_times_seconds: [...text].map((_, i) => i * .02), character_end_times_seconds: [...text].map((_, i) => (i + 1) * .02) });

test('source alignment handles Unicode offsets and rejects fabricated/malformed timings', () => {
  const text = 'Hello 🌎, welcome!';
  const marks = eleven.alignmentMarks(text, alignment(text));
  assert.equal(marks.at(-1).offset, text.indexOf('welcome'));
  assert.equal(speechCues(text, marks, 2).map(c => c.text).join(' '), text);
  assert.throws(() => eleven.alignmentMarks('12', alignment('twelve')), /alineación/);
  const bad = alignment(text); bad.character_start_times_seconds[1] = -1;
  assert.throws(() => eleven.alignmentMarks(text, bad), /Tiempos/);
});

test('missing key fails explicitly and the generation contract preserves model', async () => {
  const key = process.env.ELEVENLABS_API_KEY;
  try {
    delete process.env.ELEVENLABS_API_KEY;
    assert.equal(await eleven.isAvailable(), false);
    await assert.rejects(resolveProvider('elevenlabs'), /ELEVENLABS_API_KEY/);
    assert.deepEqual(await eleven.listVoices(), []);
    const v = normalizeVoice({ provider: 'elevenlabs', name: 'voice1', model: 'eleven_multilingual_v2' });
    assert.equal(makeProject({ voice: v }).voice.model, v.model);
  } finally { if (key === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = key; }
});

test('mock API + real FFmpeg: cache, model invalidation, timings, catalog and no silent fallback', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eleven-test-'));
  const oldFetch = globalThis.fetch, key = process.env.ELEVENLABS_API_KEY;
  const voice = randomUUID().replaceAll('-', '');
  const text = 'Welcome to the lesson.';
  let calls = 0, fail = false;
  try {
    process.env.ELEVENLABS_API_KEY = 'test-secret-never-exposed';
    const audio = path.join(dir, 'fixture.mp3');
    await ffmpegRun(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', audio]);
    globalThis.fetch = async (url, opts) => {
      assert.equal(opts.headers['xi-api-key'], process.env.ELEVENLABS_API_KEY);
      if (url.includes('/v2/voices')) return Response.json({ voices: [{ voice_id: voice, name: 'English teacher', labels: { language: 'en' } }] });
      calls++;
      assert.equal(JSON.parse(opts.body).text, text);
      if (fail) return new Response('secret error body', { status: 429 });
      return Response.json({ audio_base64: fs.readFileSync(audio).toString('base64'), alignment: alignment(text) });
    };
    const voices = await eleven.listVoices();
    assert.equal(voices[0].name, voice); assert.equal(voices[0].displayName, 'English teacher');
    const opts = { voice };
    const [a,b] = await Promise.all([eleven.synthesizeWithTimings(text, path.join(dir,'a.wav'), opts), eleven.synthesizeWithTimings(text, path.join(dir,'b.wav'), opts)]);
    assert.deepEqual(a,b); assert.equal(calls, 1);
    await eleven.synthesize(text, path.join(dir,'c.wav'), opts); assert.equal(calls, 1);
    const p = makeProject({ id: 'eleven-test-'+voice, language:'en', voice: { provider:'elevenlabs', name:voice, enabled:true }, scenes:[{ text, duration:1 }] });
    const res = await narrateProject(p);
    assert.equal(res.provider,'elevenlabs'); assert.ok(p.scenes[0].captionTimings.length);
    assert.equal(calls,1); // preview and full narration reuse the same paid output
    assert.equal(p.scenes[0].captionTimingText,text);
    await eleven.synthesize(text,path.join(dir,'d.wav'),{voice, model:'another-model'}); assert.equal(calls,2);
    fail = true;
    await assert.rejects(eleven.synthesize(text,path.join(dir,'e.wav'),{voice,model:'fail-model'}), e => /HTTP 429/.test(e.message) && !/secret/.test(e.message));
    assert.equal(calls,3); // no automatic paid retries
    p.voice.model='fail-project';
    await assert.rejects(narrateProject(p), /HTTP 429/);
  } finally {
    globalThis.fetch = oldFetch;
    if(key === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY=key;
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

 test('editor saves and reopens the selected voice and model', async () => {
  const p = makeProject({ title: 'Eleven persistence', scenes: [{text:'Welcome.', duration:2}] });
  saveProject(p);
  try {
    await guardar(p.id, { voice: { provider:'elevenlabs', name:'voice123', model:'eleven_multilingual_v2', enabled:true } });
    const saved = publico(loadProject(p.id));
    assert.equal(saved.voice.provider,'elevenlabs');
    assert.equal(saved.voice.name,'voice123');
    assert.equal(saved.voice.model,'eleven_multilingual_v2');
  } finally { deleteProject(p.id); }
 });
