import { speechCues } from './speech-cues.js';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { resolveProvider } from '../providers/tts/index.js';
import { probeDuration, ffmpegRun } from '../lib/ffmpeg.js';
import { workDir, rel, abs } from '../lib/paths.js';
import { logger } from '../lib/logger.js';
import { narrationPlan, resolveVoices } from './lang.js';
import { activeScenes } from './project.js';

const log = logger('tts-core');

/**
 * Number of sequential scene tracks grouped into one cached WAV.  Keeping the
 * group small avoids the old `amix` graph opening every narration in a long
 * course at the same time.
 */
export const NARRATION_BLOCK_SIZE = 16;

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function concatLine(file) {
  return `file '${String(file).split(path.sep).join('/').split("'").join("'\\''")}'`;
}

async function atomicFfmpeg(args, target) {
  const temporary = `${target}.partial.wav`;
  try { fs.unlinkSync(temporary); } catch { /* no partial file */ }
  await ffmpegRun([...args, temporary]);
  try { fs.unlinkSync(target); } catch { /* first version */ }
  fs.renameSync(temporary, target);
}

async function makeTimelineSegment(scene, index, dir) {
  const duration = Math.max(0.05, Number(scene.duration) || 0.05);
  const source = scene.narrationPath && fs.existsSync(abs(scene.narrationPath))
    ? abs(scene.narrationPath)
    : null;
  const key = hash({
    version: 2,
    sceneId: scene.id,
    index,
    duration,
    narrationKey: scene.narrationKey || null,
    source: source ? [fs.statSync(source).size, fs.statSync(source).mtimeMs] : null,
  });
  const target = path.join(dir, `${String(index).padStart(4, '0')}_${scene.id}.wav`);
  const stamp = `${target}.sha256`;
  if (fs.existsSync(target) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === key) return target;

  if (source) {
    await atomicFfmpeg([
      '-i', source,
      '-af', `aresample=48000,apad=pad_dur=${duration.toFixed(3)}`,
      '-t', duration.toFixed(3), '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le',
    ], target);
  } else {
    await atomicFfmpeg([
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-t', duration.toFixed(3), '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le',
    ], target);
  }
  fs.writeFileSync(stamp, key, 'utf8');
  return target;
}

async function concatWavFiles(files, target, key) {
  const stamp = `${target}.sha256`;
  if (fs.existsSync(target) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === key) return target;
  const list = `${target}.concat.txt`;
  fs.writeFileSync(list, files.map(concatLine).join('\n'), 'utf8');
  try {
    await atomicFfmpeg([
      '-f', 'concat', '-safe', '0', '-i', list,
      '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le',
    ], target);
    fs.writeFileSync(stamp, key, 'utf8');
  } finally {
    try { fs.unlinkSync(list); } catch { /* diagnostic file is not required */ }
  }
  return target;
}

/**
 * Genera la narracion de cada escena.
 * Si no hay motor TTS disponible, devuelve narraciones vacias y el video
 * se renderiza en silencio: el pipeline no se rompe nunca.
 */
export async function narrateProject(project, { provider = 'auto', onProgress, force = false, timedCaptions = false } = {}) {
  const dir = path.join(workDir(project.id), 'audio');
  fs.mkdirSync(dir, { recursive: true });

  if (project.voice?.enabled === false) {
    return { provider: 'none', narrations: project.scenes.map(() => null), durations: [], skipped: true };
  }

  const engine = await resolveProvider(provider === 'auto' ? project.voice?.provider || 'auto' : provider);
  if (engine.id === 'none') {
    log.warn('Sin motor TTS: el video se renderizara sin voz');
    return { provider: 'none', narrations: project.scenes.map(() => null), durations: [], unavailable: true };
  }

  const narrations = [];
  const durations = [];
  const errors = [];

  // Voces instaladas del motor elegido: hacen falta para saber que idioma habla
  // cada voz y para sustituirla cuando no coincide con el idioma del proyecto.
  let installed = [];
  try { installed = await engine.listVoices(); } catch { /* sin catalogo: se usa la voz tal cual */ }

  const { warnings: voiceWarnings, base: baseVoice, voices: langVoices } = resolveVoices(project, installed);
  for (const w of voiceWarnings) log.warn(w);

  for (let i = 0; i < project.scenes.length; i++) {
    const scene = project.scenes[i];
    const text = String(scene.text || '').trim();
    onProgress?.({ step: 'tts', index: i, total: project.scenes.length, sceneId: scene.id });

    if (!text) {
      narrations.push(null);
      durations.push(null);
      continue;
    }

    // Tramos por idioma. Sin tags y con voz unica, `ssml` es null y el camino
    // es exactamente el de siempre.
    const plan = narrationPlan(text, project, installed);
    const useSsml = engine.supportsSsml ? plan.ssml : null;

    const providerOptions = engine.cacheKeyOptions?.(project.voice) || null;
    const voiceForCache = engine.id === 'elevenlabs'
      ? { provider: engine.id, name: project.voice?.name, ...providerOptions }
      : project.voice;
    const narrationKey = createHash('sha256').update(JSON.stringify({
      text, engine: engine.id, voice: voiceForCache,
      ...(engine.id !== 'elevenlabs' && providerOptions ? { providerOptions } : {}),
      ...(engine.id === 'elevenlabs' ? { timingVersion: 'elevenlabs-alignment-v1' } :
        (timedCaptions || scene.captionTimings?.length) && engine.synthesizeWithTimings ? { timingVersion: 'sapi-pcm16-v2' } : {}),
      language: project.language, ssml: useSsml, base: plan.base,
    })).digest('hex');
    const rawFile = path.join(dir, `${scene.id}-${narrationKey}.raw.wav`);
    const outFile = path.join(dir, `${scene.id}-${narrationKey}.wav`);

    // Reutiliza audio ya generado si el texto no cambio (ahorra minutos de CPU).
    const requiresTimings = engine.supportsTimings || Boolean((timedCaptions || scene.captionTimings?.length) && engine.synthesizeWithTimings);
    if (!force && scene.narrationPath && fs.existsSync(abs(scene.narrationPath)) && scene.narrationKey === narrationKey && (!requiresTimings || scene.captionTimings?.length)) {
      narrations.push(scene.narrationPath);
      durations.push(await probeDuration(abs(scene.narrationPath)));
      continue;
    }

    const cachedTimingsFile = `${rawFile}.timings.json`;
    if (!force && fs.existsSync(outFile) && (!requiresTimings || fs.existsSync(cachedTimingsFile))) {
      const duration = await probeDuration(outFile);
      if (duration) {
        try {
          if (requiresTimings) {
            const marks = JSON.parse(fs.readFileSync(cachedTimingsFile, 'utf8'));
            scene.captionTimingText = plan.plain;
            scene.captionTimings = speechCues(plan.plain, marks, duration);
          } else {
            scene.captionTimings = null;
            scene.captionTimingText = null;
          }
          scene.narrationPath = rel(outFile);
          scene.narrationKey = narrationKey;
          scene.narrationText = plan.plain;
          narrations.push(scene.narrationPath);
          durations.push(duration);
          continue;
        } catch (error) {
          log.warn(`Alineación cacheada inválida para ${scene.id}; se regenerará: ${error.message}`);
        }
      }
    }

    try {
      const synthesize = requiresTimings && engine.synthesizeWithTimings ? engine.synthesizeWithTimings : engine.synthesize;
      const marks = await synthesize(plan.plain, rawFile, {
        voice: (engine.id === 'elevenlabs' ? project.voice?.name : plan.base) || project.voice?.name || '',
        rate: project.voice?.rate ?? 0,
        volume: project.voice?.volume ?? 100,
        model: project.voice?.model || '',
        settings: project.voice?.settings || {},
        language: plan.baseLang,
        ssml: useSsml,
        ...(engine.supportsSegments ? { segments: plan.segments, voices: plan.voices } : {}),
      });
      // Normaliza a 48kHz estereo y recorta silencios largos de los extremos.
      await ffmpegRun([
        '-i', rawFile,
        '-af', Array.isArray(marks) && marks.length ? 'loudnorm=I=-16:TP=-1.5:LRA=11' : 'silenceremove=start_periods=1:start_silence=0.1:start_threshold=-50dB,' +
               'areverse,silenceremove=start_periods=1:start_silence=0.2:start_threshold=-50dB,areverse,' +
               'loudnorm=I=-16:TP=-1.5:LRA=11',
        '-ar', '48000', '-ac', '2',
        outFile,
      ]);
      try { fs.unlinkSync(rawFile); } catch { /* temporal */ }

      const d = await probeDuration(outFile);
      if (Array.isArray(marks) && marks.length) { scene.captionTimingText = plan.plain; scene.captionTimings = speechCues(plan.plain, marks, d); }
      else { scene.captionTimings = null; scene.captionTimingText = null; }
      scene.narrationPath = rel(outFile);
      narrations.push(scene.narrationPath);
      durations.push(d);
      scene.narrationText = plan.plain; // marca de cache, ya sin tags
      scene.narrationKey = narrationKey;
      scene.narrationLangs = [...new Set(plan.segments.map(s => s.lang))];
      // Queda registrado con que voz se narro cada escena: es lo que permite
      // auditar despues que el idioma y la voz cuadran.
      scene.narrationVoices = [...new Set(plan.segments.map(s => plan.voices[s.lang] || plan.base))];
    } catch (e) {
      log.error(`Escena ${i + 1} sin narracion:`, e.message);
      errors.push({ sceneId: scene.id, error: e.message });
      scene.narrationPath = null;
      scene.narrationKey = null;
      scene.narrationText = null;
      scene.narrationVoices = [];
      scene.narrationLangs = [];
      scene.captionTimings = null;
      scene.captionTimingText = null;
      narrations.push(null);
      durations.push(null);
    }
  }

  return {
    provider: engine.id, narrations, durations, errors,
    voice: baseVoice, voices: langVoices, warnings: voiceWarnings,
  };
}

/**
 * Concatena las narraciones respetando el timeline de escenas:
 * cada narracion arranca exactamente donde empieza su escena, con silencio
 * de relleno hasta completar la duracion de la escena.
 */
export async function buildNarrationTrack(project) {
  const dir = workDir(project.id);
  const out = path.join(dir, 'narration.wav');
  // Solo las escenas incluidas: la pista de voz tiene que durar lo mismo que
  // el video montado, y una escena excluida no esta en el montaje.
  const scenes = activeScenes(project);
  const withAudio = scenes.filter((s) => s.narrationPath && fs.existsSync(abs(s.narrationPath)));
  if (!withAudio.length) return null;

  const segmentDir = path.join(dir, 'narration-segments');
  const blockDir = path.join(dir, 'narration-blocks');
  fs.mkdirSync(segmentDir, { recursive: true });
  fs.mkdirSync(blockDir, { recursive: true });

  // Each scene becomes one exact-length sequential WAV.  FFmpeg therefore
  // opens one narration at a time instead of all course scenes simultaneously.
  const segments = [];
  for (let i = 0; i < scenes.length; i++) {
    segments.push(await makeTimelineSegment(scenes[i], i, segmentDir));
  }

  // Concatenate small cached blocks, then concatenate the blocks.  A failure
  // leaves earlier valid blocks available to the next explicit resume.
  const blocks = [];
  for (let start = 0; start < segments.length; start += NARRATION_BLOCK_SIZE) {
    const files = segments.slice(start, start + NARRATION_BLOCK_SIZE);
    const blockIndex = Math.floor(start / NARRATION_BLOCK_SIZE);
    const block = path.join(blockDir, `block_${String(blockIndex).padStart(3, '0')}.wav`);
    const blockKey = hash({ version: 2, files: files.map(f => [f, fs.statSync(f).size, fs.statSync(f).mtimeMs]) });
    blocks.push(await concatWavFiles(files, block, blockKey));
  }

  const finalKey = hash({ version: 2, blocks: blocks.map(f => [f, fs.statSync(f).size, fs.statSync(f).mtimeMs]) });
  await concatWavFiles(blocks, out, finalKey);

  return rel(out);
}

/** Prueba rapida de voz: genera un WAV corto para escuchar en la UI. */
export async function previewVoice(text, { provider = 'auto', voice = '', rate = 0, model = '', settings = {} } = {}) {
  const engine = await resolveProvider(provider);
  if (engine.id === 'none') throw new Error('No hay motor TTS disponible');
  const dir = workDir('_preview');
  const out = path.join(dir, `voice_${Date.now()}.wav`);
  await engine.synthesize(String(text || '').slice(0, 400), out, { voice, rate, model, settings });
  return rel(out);
}
