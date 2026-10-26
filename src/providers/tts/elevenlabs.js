import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CONFIG } from '../../config.js';
import { ffmpegRun, probeDuration } from '../../lib/ffmpeg.js';

import { workDir } from '../../lib/paths.js';

const pending = new Map();
export const id = 'elevenlabs';
export const label = 'ElevenLabs · voces naturales en línea';
export const supportsTimings = true;
export const unavailableMessage = 'ElevenLabs no está configurado. Añade ELEVENLABS_API_KEY al archivo .env local y reinicia el servidor.';

const API = 'https://api.elevenlabs.io';
const CACHE_MS = 10 * 60_000;
let voiceCache;
let modelCache;

export async function isAvailable() {
  return Boolean(CONFIG.tts.elevenLabsApiKey);
}

export function cacheKeyOptions(voice = {}) {
  const configured = CONFIG.tts.elevenLabsVoiceSettings;
  return {
    model: voice.model || CONFIG.tts.elevenLabsModel,
    settings: {
      stability: voice.settings?.stability ?? configured.stability,
      similarityBoost: voice.settings?.similarityBoost ?? configured.similarityBoost,
      style: voice.settings?.style ?? configured.style,
      speed: voice.settings?.speed ?? configured.speed,
      useSpeakerBoost: voice.settings?.useSpeakerBoost ?? configured.useSpeakerBoost,
    },
  };
}

function errorForResponse(status, details = '') {
  const normalized = String(details).toLowerCase();
  if (status === 401 || status === 403) return new Error('ElevenLabs rechazó la clave API. Revísala en el .env local y reinicia el servidor.');
  if (status === 402 || /quota_exceeded|payment_required|subscription/.test(normalized)) {
    return new Error('ElevenLabs no tiene cuota o créditos disponibles para esta solicitud. Revisa tu plan antes de volver a intentarlo.');
  }
  if (status === 429) return new Error('ElevenLabs alcanzó un límite de uso o de solicitudes. Revisa la cuota y espera antes de reintentar.');
  if (status === 422) return new Error('ElevenLabs rechazó la voz, el modelo o los ajustes seleccionados. Elige una combinación compatible.');
  if (status >= 500) return new Error('ElevenLabs no está disponible temporalmente. No se generó audio.');
  return new Error(`La API de ElevenLabs respondió con HTTP ${status}. No se generó audio.`);
}

async function requestJson(url, { method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        'xi-api-key': CONFIG.tts.elevenLabsApiKey,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      let details = text;
      try {
        const parsed = JSON.parse(text);
        details = JSON.stringify(parsed.detail || parsed);
      } catch {}
      throw errorForResponse(response.status, details);
    }
    return await response.json();
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('ElevenLabs tardó demasiado en responder. No se generó audio.');
    if (error.message.startsWith('ElevenLabs ') || error.message.startsWith('La API de ElevenLabs')) throw error;
    throw new Error('No se pudo conectar con ElevenLabs. Comprueba la conexión y vuelve a intentarlo.');
  } finally {
    clearTimeout(timer);
  }
}

function languageOf(voice) {
  const value = String(voice.labels?.language || voice.verified_languages?.[0]?.language || '').toLowerCase();
  if (/^en(?:[-_ ]|$)|english/.test(value)) return 'en';
  if (/^es(?:[-_ ]|$)|spanish|español/.test(value)) return 'es';
  return value || 'multilingual';
}

export async function listVoices() {
  if (!(await isAvailable())) return [];
  if (voiceCache && Date.now() - voiceCache.time < CACHE_MS) return voiceCache.value;
  const voices = [];
  let nextPageToken = '';
  let pages = 0;
  do {
    const query = new URLSearchParams({ page_size: '100', include_total_count: 'false', sort: 'name', sort_direction: 'asc' });
    if (nextPageToken) query.set('next_page_token', nextPageToken);
    const result = await requestJson(`${API}/v2/voices?${query}`);
    if (!Array.isArray(result.voices)) throw new Error('ElevenLabs devolvió un catálogo de voces inválido.');
    for (const voice of result.voices) {
      if (!voice.voice_id || !voice.name) continue;
      voices.push({
        id: voice.voice_id,
        name: voice.voice_id,
        label: voice.name,
        language: languageOf(voice),
        category: voice.category || '',
        provider: id,
      });
    }
    pages++;
    if (result.has_more && !result.next_page_token) throw new Error('El catálogo de voces de ElevenLabs no incluyó el token de la página siguiente.');
    nextPageToken = result.has_more ? result.next_page_token : '';
  } while (nextPageToken && pages < 20);
  if (nextPageToken) throw new Error('El catálogo de ElevenLabs supera el límite seguro de páginas.');
  voiceCache = { value: voices, time: Date.now() };
  return voices;
}

export async function listModels() {
  if (!(await isAvailable())) return [];
  if (modelCache && Date.now() - modelCache.time < CACHE_MS) return modelCache.value;
  const result = await requestJson(`${API}/v1/models`);
  if (!Array.isArray(result)) throw new Error('ElevenLabs devolvió un catálogo de modelos inválido.');
  const models = result.filter(model => model.can_do_text_to_speech && model.model_id).map(model => ({
    id: model.model_id,
    name: model.name || model.model_id,
    description: model.description || '',
    canUseStyle: Boolean(model.can_use_style),
    languages: (model.languages || []).map(language => language.language_id).filter(Boolean),
    maxTextLength: model.maximum_text_length_per_request || null,
  }));
  modelCache = { value: models, time: Date.now() };
  return models;
}

function alignmentMarks(text, alignment) {
  const chars = alignment?.characters;
  const starts = alignment?.character_start_times_seconds;
  const ends = alignment?.character_end_times_seconds;
  if (!Array.isArray(chars) || !Array.isArray(starts) || !Array.isArray(ends) || chars.length !== starts.length || chars.length !== ends.length || chars.join('') !== text)
    throw new Error('ElevenLabs no devolvió alineación del guion original. No se estimarán subtítulos.');
  const marks = [];
  let offset = 0;
  for (let i = 0; i < chars.length; i++) {
    if (!Number.isFinite(starts[i]) || !Number.isFinite(ends[i]) || starts[i] < 0 || ends[i] < starts[i] || (i && starts[i] < starts[i - 1])) throw new Error('Tiempos de ElevenLabs inválidos.');
    marks.push({ time: starts[i], end: ends[i], offset, length: chars[i].length });
    offset += chars[i].length;
  }
  // Group characters into words using UTF-16 offsets (same convention as SAPI).
  return [...text.matchAll(/\S+/gu)].map(m => {
    const first = marks.find(x => x.offset === m.index);
    const last = marks.find(x => x.offset + x.length === m.index + m[0].length);
    if (!first || !last) throw new Error('Alineación de palabras inválida.');
    return { time: first.time, end: last.end, offset: m.index, length: m[0].length };
  });
}
async function generateWithAlignment(text, outFile, {
  voice = '',
  model = '',
  language = '',
  settings = {},
} = {}) {
  if (!(await isAvailable())) throw new Error(unavailableMessage);
  const clean = String(text || '').trim();
  if (!clean) throw new Error('Texto vacío para narrar.');
  if (!voice) throw new Error('Elige una voz de ElevenLabs.');
  const modelId = model || CONFIG.tts.elevenLabsModel;
  const models = await listModels();
  const selectedModel = models.find(item => item.id === modelId);
  if (!selectedModel) throw new Error(`El modelo ${modelId} no está disponible para esta cuenta de ElevenLabs.`);
  if (selectedModel.maxTextLength && clean.length > selectedModel.maxTextLength) {
    throw new Error(`El modelo ${selectedModel.name} acepta hasta ${selectedModel.maxTextLength} caracteres por solicitud; divide la escena antes de narrarla.`);
  }

  const configured = CONFIG.tts.elevenLabsVoiceSettings;
  const voiceSettings = {
    stability: Number(settings.stability ?? configured.stability),
    similarity_boost: Number(settings.similarityBoost ?? configured.similarityBoost),
    speed: Number(settings.speed ?? configured.speed),
    use_speaker_boost: settings.useSpeakerBoost ?? configured.useSpeakerBoost,
  };
  if (selectedModel.canUseStyle) voiceSettings.style = Number(settings.style ?? configured.style);
  for (const [key, value] of Object.entries(voiceSettings)) {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`Ajuste de voz inválido: ${key}.`);
  }
  const body = { text: clean, model_id: modelId, voice_settings: voiceSettings };
  if (language && !modelId.includes('multilingual_v2')) body.language_code = language;
  const result = await requestJson(`${API}/v1/text-to-speech/${encodeURIComponent(voice)}/with-timestamps?output_format=mp3_44100_128`, {
    method: 'POST',
    body,
  });
  if (typeof result.audio_base64 !== 'string' || !result.audio_base64) throw new Error('ElevenLabs devolvió una respuesta sin audio.');
  const marks = alignmentMarks(clean, result.alignment);
  const directory = path.dirname(outFile);
  fs.mkdirSync(directory, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivm-elevenlabs-'));
  const source = path.join(tempDir, 'response.mp3');
  const converted = path.join(directory, `${randomUUID()}.partial.wav`);
  try {
    fs.writeFileSync(source, Buffer.from(result.audio_base64, 'base64'));
    if (fs.statSync(source).size < 100) throw new Error('ElevenLabs devolvió un archivo de audio vacío.');
    await ffmpegRun(['-i', source, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', converted]);
    if (fs.statSync(converted).size < 1024) throw new Error('No se pudo decodificar el audio generado por ElevenLabs.');
    const duration = await probeDuration(converted);
    if (!duration || marks.some(m => m.time >= duration || m.end > duration + 0.1)) throw new Error('La alineaci?n excede la duraci?n del audio.');
    fs.renameSync(converted, outFile);
    fs.writeFileSync(`${outFile}.timings.json`, JSON.stringify(marks), 'utf8');
    return marks;
  } finally {
    try { fs.unlinkSync(converted); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function synthesizeWithAlignment(text, outFile, options = {}) {
  if (!(await isAvailable())) throw new Error(unavailableMessage);
  const key = createHash('sha256').update(JSON.stringify({ text, voice: options.voice, language: options.language || '', ...cacheKeyOptions(options), version: 2 })).digest('hex');
  const dir = workDir('_elevenlabs-cache');
  const wav = path.join(dir, key + '.wav'), json = wav + '.timings.json';
  const generate = async () => {
    if (fs.existsSync(wav) && fs.existsSync(json)) {
      try {
        const marks = JSON.parse(fs.readFileSync(json, 'utf8'));
        const duration = await probeDuration(wav);
        if (marks.length && marks.every(m => Number.isFinite(m.time) && m.time >= 0 && m.time < duration && m.end <= duration + 0.1)) return marks;
      } catch {}
    }
    return generateWithAlignment(text, wav, options);
  };
  if (!pending.has(key)) pending.set(key, generate().finally(() => pending.delete(key)));
  const marks = await pending.get(key);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.copyFileSync(wav, outFile);
  fs.writeFileSync(outFile + '.timings.json', JSON.stringify(marks));
  return marks;
}

export async function synthesize(text, outFile, options = {}) {
  await synthesizeWithAlignment(text, outFile, options);
  return outFile;
}

export async function synthesizeWithTimings(text, outFile, options = {}) {
  return synthesizeWithAlignment(text, outFile, options);
}

export { alignmentMarks as characterAlignmentToWordMarks };
