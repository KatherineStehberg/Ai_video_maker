import fs from 'node:fs';
import path from 'node:path';
import { resolveProvider } from '../providers/tts/index.js';
import { probeDuration, ffmpegRun } from '../lib/ffmpeg.js';
import { workDir, rel, abs } from '../lib/paths.js';
import { logger } from '../lib/logger.js';

const log = logger('tts-core');

/**
 * Genera la narracion de cada escena.
 * Si no hay motor TTS disponible, devuelve narraciones vacias y el video
 * se renderiza en silencio: el pipeline no se rompe nunca.
 */
export async function narrateProject(project, { provider = 'auto', onProgress, force = false } = {}) {
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

  for (let i = 0; i < project.scenes.length; i++) {
    const scene = project.scenes[i];
    const text = String(scene.text || '').trim();
    onProgress?.({ step: 'tts', index: i, total: project.scenes.length, sceneId: scene.id });

    if (!text) {
      narrations.push(null);
      durations.push(null);
      continue;
    }

    const rawFile = path.join(dir, `${scene.id}.raw.wav`);
    const outFile = path.join(dir, `${scene.id}.wav`);

    // Reutiliza audio ya generado si el texto no cambio (ahorra minutos de CPU).
    if (!force && scene.narrationPath && fs.existsSync(abs(scene.narrationPath)) && scene.narrationText === text) {
      narrations.push(scene.narrationPath);
      durations.push(await probeDuration(abs(scene.narrationPath)));
      continue;
    }

    try {
      await engine.synthesize(text, rawFile, {
        voice: project.voice?.name || '',
        rate: project.voice?.rate ?? 0,
        volume: project.voice?.volume ?? 100,
      });
      // Normaliza a 48kHz estereo y recorta silencios largos de los extremos.
      await ffmpegRun([
        '-i', rawFile,
        '-af', 'silenceremove=start_periods=1:start_silence=0.1:start_threshold=-50dB,' +
               'areverse,silenceremove=start_periods=1:start_silence=0.2:start_threshold=-50dB,areverse,' +
               'loudnorm=I=-16:TP=-1.5:LRA=11',
        '-ar', '48000', '-ac', '2',
        outFile,
      ]);
      try { fs.unlinkSync(rawFile); } catch { /* temporal */ }

      const d = await probeDuration(outFile);
      narrations.push(rel(outFile));
      durations.push(d);
      scene.narrationText = text; // marca de cache
    } catch (e) {
      log.error(`Escena ${i + 1} sin narracion:`, e.message);
      errors.push({ sceneId: scene.id, error: e.message });
      narrations.push(null);
      durations.push(null);
    }
  }

  return { provider: engine.id, narrations, durations, errors };
}

/**
 * Concatena las narraciones respetando el timeline de escenas:
 * cada narracion arranca exactamente donde empieza su escena, con silencio
 * de relleno hasta completar la duracion de la escena.
 */
export async function buildNarrationTrack(project) {
  const dir = workDir(project.id);
  const out = path.join(dir, 'narration.wav');
  const scenes = project.scenes || [];
  const withAudio = scenes.filter((s) => s.narrationPath && fs.existsSync(abs(s.narrationPath)));
  if (!withAudio.length) return null;

  const inputs = [];
  const filters = [];
  let idx = 0;
  let offsetMs = 0;

  for (const s of scenes) {
    const durMs = Math.round((s.duration || 0) * 1000);
    if (s.narrationPath && fs.existsSync(abs(s.narrationPath))) {
      inputs.push('-i', abs(s.narrationPath));
      // adelay posiciona la pista en su instante del timeline.
      filters.push(`[${idx}:a]aresample=48000,adelay=${offsetMs}|${offsetMs}[a${idx}]`);
      idx++;
    }
    offsetMs += durMs;
  }

  const totalSec = (offsetMs / 1000).toFixed(3);
  const mixInputs = Array.from({ length: idx }, (_, i) => `[a${i}]`).join('');
  // amix con normalize=0 para que el volumen no baje al aumentar las entradas.
  const graph = `${filters.join(';')};${mixInputs}amix=inputs=${idx}:normalize=0:dropout_transition=0[mix]`;

  await ffmpegRun([
    ...inputs,
    '-filter_complex', graph,
    '-map', '[mix]',
    '-t', totalSec,
    '-ar', '48000', '-ac', '2',
    out,
  ]);

  return rel(out);
}

/** Prueba rapida de voz: genera un WAV corto para escuchar en la UI. */
export async function previewVoice(text, { provider = 'auto', voice = '', rate = 0 } = {}) {
  const engine = await resolveProvider(provider);
  if (engine.id === 'none') throw new Error('No hay motor TTS disponible');
  const dir = workDir('_preview');
  const out = path.join(dir, `voice_${Date.now()}.wav`);
  await engine.synthesize(String(text || '').slice(0, 400), out, { voice, rate });
  return rel(out);
}
