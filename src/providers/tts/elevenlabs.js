import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ffmpegRun, probeDuration } from '../../lib/ffmpeg.js';
import { workDir } from '../../lib/paths.js';

export const id = 'elevenlabs';
export const label = 'ElevenLabs · voz natural en línea (consume créditos)';
export const alwaysTimings = true;
const pending = new Map();
export const isAvailable = async () => Boolean(process.env.ELEVENLABS_API_KEY?.trim());
export function cacheIdentity(options = {}) {
  return { version: 1, model: options.model || process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2',
    stability: options.stability ?? 0.5, similarity: options.similarity ?? 0.75 };
}
async function request(route, body) {
  if (!(await isAvailable())) throw new Error('Configura ELEVENLABS_API_KEY en el .env del backend y reinicia el servidor.');
  let response;
  try {
    response = await fetch(`https://api.elevenlabs.io${route}`, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(120_000),
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch { throw new Error('ElevenLabs no respondió. Comprueba la conexión; no se reintentó ni se cambió de voz.'); }
  if (!response.ok) throw new Error(`ElevenLabs HTTP ${response.status}. Comprueba la clave, permisos, créditos y modelo. No se reintentó la solicitud.`);
  try { return await response.json(); } catch { throw new Error('Respuesta de ElevenLabs inválida.'); }
}
export async function listVoices() {
  if (!(await isAvailable())) return [];
  const result = [];
  let token = '';
  for (let page = 0; page < 50; page++) {
    const data = await request('/v2/voices?page_size=100' + (token ? `&next_page_token=${encodeURIComponent(token)}` : ''));
    if (!Array.isArray(data.voices)) throw new Error('Catálogo de ElevenLabs inválido.');
    for (const v of data.voices) if (v.voice_id) result.push({ id: v.voice_id, name: v.voice_id,
      displayName: v.name || v.voice_id, language: v.labels?.language || '', gender: v.labels?.gender || '', provider: id });
    if (!data.has_more) return result;
    if (!data.next_page_token || data.next_page_token === token) throw new Error('Paginación de ElevenLabs inválida.');
    token = data.next_page_token;
  }
  throw new Error('El catálogo ElevenLabs excede el límite de páginas.');
}

// Exact source alignment only: never invent timing offsets for normalized text.
export function alignmentMarks(text, alignment) {
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
export async function synthesizeWithTimings(text, outFile, options = {}) {
  text = String(text || '').trim();
  if (!text) throw new Error('Texto vacío para ElevenLabs.');
  if (text.length > 10000) throw new Error('Divide la narración en escenas de hasta 10000 caracteres.');
  const voice = options.voice || process.env.ELEVENLABS_VOICE_ID;
  if (!voice || !/^[a-zA-Z0-9_-]+$/.test(voice)) throw new Error('Selecciona una voz ElevenLabs válida.');
  const identity = cacheIdentity(options);
  const speed = Math.max(0.7, Math.min(1.2, 1 + (Number(options.rate) || 0) * 0.02));
  const body = { text, model_id: identity.model, voice_settings: { stability: identity.stability,
    similarity_boost: identity.similarity, speed } };
  const key = createHash('sha256').update(JSON.stringify({ voice, body, version: identity.version })).digest('hex');
  const dir = workDir('_elevenlabs-cache');
  const wav = path.join(dir, `${key}.wav`), json = path.join(dir, `${key}.json`);
  const generate = async () => {
    if (fs.existsSync(wav) && fs.existsSync(json)) {
      try {
        const cached = JSON.parse(fs.readFileSync(json, 'utf8'));
        const duration = await probeDuration(wav);
        if (cached.text === text && cached.marks?.length && cached.marks.every(m => m.time < duration)) return cached.marks;
      } catch { /* invalid cache requires an explicit generation call */ }
    }
    const data = await request(`/v1/text-to-speech/${encodeURIComponent(voice)}/with-timestamps?output_format=mp3_44100_128`, body);
    const marks = alignmentMarks(text, data.alignment);
    if (!marks.length || typeof data.audio_base64 !== 'string' || !data.audio_base64.length) throw new Error('ElevenLabs no devolvió audio y tiempos válidos.');
    const temp = fs.mkdtempSync(path.join(dir, '.generation-'));
    try {
      const source = path.join(temp, 'audio.mp3'), target = path.join(temp, 'audio.wav');
      fs.writeFileSync(source, Buffer.from(data.audio_base64, 'base64'));
      await ffmpegRun(['-i', source, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', target]);
      const duration = await probeDuration(target);
      if (!duration || marks.some(m => m.time >= duration || m.end > duration + 0.1)) throw new Error('Los tiempos ElevenLabs exceden la duración del audio.');
      fs.copyFileSync(target, wav);
      fs.writeFileSync(json, JSON.stringify({ text, marks }));
      return marks;
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  };
  if (!pending.has(key)) pending.set(key, generate().finally(() => pending.delete(key)));
  const marks = await pending.get(key);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const target = `${outFile}.${randomUUID()}.wav`;
  try { fs.copyFileSync(wav, target); fs.renameSync(target, outFile); }
  finally { fs.rmSync(target, { force: true }); }
  fs.writeFileSync(outFile + '.timings.json', JSON.stringify(marks));
  return marks;
}
export async function synthesize(text, outFile, options) {
  await synthesizeWithTimings(text, outFile, options);
  return outFile;
}
