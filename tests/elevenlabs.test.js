import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, publicConfig } from '../src/config.js';
import { characterAlignmentToWordMarks, listModels, listVoices } from '../src/providers/tts/elevenlabs.js';
import { narrateProject } from '../src/core/tts.js';
import { makeProject, saveProject, loadProject, deleteProject } from '../src/core/project.js';
import { guardar } from '../src/project-editor/service.js';
import { ffmpegRun, probeDuration } from '../src/lib/ffmpeg.js';
import { abs, workDir } from '../src/lib/paths.js';

const testDir = path.resolve('.tmp/elevenlabs-test');
const fixtureAudio = path.join(testDir, 'fixture.mp3');
const originalApiKey = CONFIG.tts.elevenLabsApiKey;
const originalFetch = globalThis.fetch;
let fixtureBase64;
let synthesisStatus = 200;
let synthesisRequests = 0;
const synthesisBodies = [];

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

async function mockFetch(input, init = {}) {
  const url = new URL(input);
  if (url.pathname === '/v2/voices') {
    if (url.searchParams.get('next_page_token') === 'page-2') {
      return response(200, {
        voices: [{ voice_id: 'voice-es', name: 'Spanish voice', labels: { language: 'es' } }],
        has_more: false,
      });
    }
    return response(200, {
      voices: [{ voice_id: 'voice-en', name: 'English voice', labels: { language: 'en' } }],
      has_more: true,
      next_page_token: 'page-2',
    });
  }
  if (url.pathname === '/v1/models') {
    return response(200, [{
      model_id: 'eleven_multilingual_v2',
      name: 'Multilingual v2',
      can_do_text_to_speech: true,
      can_use_style: true,
      languages: [{ language_id: 'en' }, { language_id: 'es' }],
      maximum_text_length_per_request: 5000,
    }, {
      model_id: 'not-tts',
      name: 'Not TTS',
      can_do_text_to_speech: false,
      languages: [],
    }]);
  }
  if (url.pathname.endsWith('/with-timestamps')) {
    synthesisRequests++;
    if (synthesisStatus !== 200) return response(synthesisStatus, { detail: { status: 'quota_exceeded' } });
    const body = JSON.parse(init.body);
    synthesisBodies.push(body);
    const text = body.text;
    return response(200, {
      audio_base64: fixtureBase64,
      alignment: {
        characters: Array.from(text),
        character_start_times_seconds: Array.from(text, (_, index) => index * 0.025),
        character_end_times_seconds: Array.from(text, (_, index) => (index + 1) * 0.025),
      },
    });
  }
  throw new Error(`Unexpected ElevenLabs mock URL: ${url}`);
}

test.before(async () => {
  fs.mkdirSync(testDir, { recursive: true });
  await ffmpegRun(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-q:a', '9', '-c:a', 'libmp3lame', fixtureAudio]);
  fixtureBase64 = fs.readFileSync(fixtureAudio).toString('base64');
  CONFIG.tts.elevenLabsApiKey = 'test-key';
  globalThis.fetch = mockFetch;
});

test.after(() => {
  CONFIG.tts.elevenLabsApiKey = originalApiKey;
  globalThis.fetch = originalFetch;
  fs.rmSync(fixtureAudio, { force: true });
  if (fs.existsSync(testDir)) fs.rmdirSync(testDir);
});

test('ElevenLabs paginates voices and exposes only TTS-capable models', async () => {
  const voices = await listVoices();
  assert.deepEqual(voices.map(voice => voice.id), ['voice-en', 'voice-es']);
  assert.deepEqual(voices.map(voice => voice.language), ['en', 'es']);
  const models = await listModels();
  assert.deepEqual(models.map(model => model.id), ['eleven_multilingual_v2']);
  assert.equal(JSON.stringify(publicConfig()).includes('test-key'), false);
});

test('character alignment becomes word marks and rejects incompatible text', () => {
  const text = 'Hello world.';
  const marks = characterAlignmentToWordMarks(text, {
    characters: Array.from(text),
    character_start_times_seconds: Array.from(text, (_, index) => index * 0.1),
    character_end_times_seconds: Array.from(text, (_, index) => (index + 1) * 0.1),
  });
  assert.deepEqual(marks.map(({ offset, length }) => [offset, length]), [[0, 5], [6, 6]]);
  assert.throws(() => characterAlignmentToWordMarks(text, {
    characters: ['G', 'o'],
    character_start_times_seconds: [0, 0.1],
  }), /alineaci/);
});

test('ElevenLabs audio and word timings are cached and reused for an unchanged scene', async () => {
  const project = makeProject({
    language: 'en',
    voice: { provider: 'elevenlabs', name: 'voice-en' },
    scenes: [{ text: 'Hello world.', duration: 3 }],
  });
  try {
    const before = synthesisRequests;
    const first = await narrateProject(project);
    assert.equal(first.provider, 'elevenlabs');
    assert.equal(first.errors.length, 0);
    assert.ok(await probeDuration(abs(first.narrations[0])) > 0);
    assert.equal(project.scenes[0].captionTimingText, 'Hello world.');
    assert.ok(project.scenes[0].captionTimings.length > 0);
    assert.equal(project.scenes[0].narrationPath, first.narrations[0]);
    assert.equal(synthesisBodies.at(-1).model_id, CONFIG.tts.elevenLabsModel, 'an unset project model uses the configured model');
    assert.equal(synthesisRequests, before + 1);

    const second = await narrateProject(project);
    assert.equal(second.errors.length, 0);
    assert.equal(synthesisRequests, before + 1, 'identical settings should reuse the WAV and its alignment');
  } finally {
    deleteProject(project.id);
    fs.rmSync(workDir(project.id), { recursive: true, force: true });
  }
});

test('editor voice preview returns playable ElevenLabs audio without exposing credentials', async () => {
  const { createServer } = await import('../src/server.js');
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let previewFile;
  try {
    const body = JSON.stringify({
      provider: 'elevenlabs',
      voice: 'voice-en',
      model: 'eleven_multilingual_v2',
      text: 'A short voice preview.',
      settings: { stability: 0.3, speed: 0.95 },
    });
    const result = await originalFetch(`${base}/api/project-editor/preview-voice`, {
      method: 'POST',
      headers: {
        'x-editor-request': '1',
        'content-type': 'application/json',
        origin: base,
      },
      body,
    });
    assert.equal(result.status, 200);
    const { url } = await result.json();
    const audio = await originalFetch(`${base}${url}`);
    assert.equal(audio.status, 200);
    const bytes = Buffer.from(await audio.arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString(), 'RIFF');
    assert.ok(await probeDuration(abs(new URL(url, base).searchParams.get('path'))) > 0);
    previewFile = abs(new URL(url, base).searchParams.get('path'));
    assert.equal(synthesisBodies.at(-1).model_id, 'eleven_multilingual_v2');
  } finally {
    if (previewFile) fs.rmSync(previewFile, { force: true });
    await new Promise(resolve => server.close(resolve));
  }
});

test('quota failure stays explicit and does not fall back to another voice', async () => {
  synthesisStatus = 402;
  const project = makeProject({
    language: 'en',
    voice: { provider: 'elevenlabs', name: 'voice-en', model: 'eleven_multilingual_v2' },
    scenes: [{ text: 'A quota test.' }],
  });
  try {
    const result = await narrateProject(project);
    assert.equal(result.provider, 'elevenlabs');
    assert.match(result.errors[0].error, /cuota o créditos/);
    assert.equal(project.scenes[0].narrationPath, null);
  } finally {
    synthesisStatus = 200;
    deleteProject(project.id);
    fs.rmSync(workDir(project.id), { recursive: true, force: true });
  }
});

test('voice, model and settings persist when reopening and invalidate stale scene audio', async () => {
  const project = makeProject({
    scenes: [{
      text: 'Previously narrated.',
      narrationPath: 'draft/previous.wav',
      narrationKey: 'previous-key',
      captionTimingText: 'Previously narrated.',
      captionTimings: [{ start: 0, end: 1, text: 'Previously narrated.' }],
    }],
  });
  saveProject(project);
  try {
    const saved = await guardar(project.id, {
      revision: 1,
      voice: {
        provider: 'elevenlabs',
        name: 'voice-en',
        model: 'eleven_multilingual_v2',
        settings: { stability: 0.3, similarityBoost: 0.8, style: 0.2, speed: 0.95 },
      },
    });
    assert.equal(saved.proyecto.voice.provider, 'elevenlabs');
    const reopened = loadProject(project.id);
    assert.equal(reopened.voice.model, 'eleven_multilingual_v2');
    assert.equal(reopened.voice.settings.stability, 0.3);
    assert.equal(reopened.scenes[0].narrationPath, null);
    assert.equal(reopened.scenes[0].captionTimings, null);
  } finally {
    deleteProject(project.id);
    fs.rmSync(workDir(project.id), { recursive: true, force: true });
  }
});
