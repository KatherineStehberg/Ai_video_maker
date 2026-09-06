import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './lib/paths.js';

/**
 * Carga .env de forma manual (sin dependencias externas).
 * Formato: KEY=VALUE, ignora lineas vacias y comentarios (#).
 * Nunca sobreescribe variables ya presentes en process.env.
 */
export function loadEnv() {
  const file = path.join(PATHS.root, '.env');
  if (!fs.existsSync(file)) return {};
  const loaded = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
    loaded[key] = true;
  }
  return loaded;
}

loadEnv();

/** Relaciones de aspecto soportadas y su resolucion de render. */
export const ASPECTS = {
  '16:9': { width: 1920, height: 1080, label: 'Horizontal (YouTube, LinkedIn, Facebook)' },
  '9:16': { width: 1080, height: 1920, label: 'Vertical (Shorts, Reels, TikTok)' },
  '1:1': { width: 1080, height: 1080, label: 'Cuadrado (feed Instagram / Facebook)' },
  '4:5': { width: 1080, height: 1350, label: 'Retrato (feed Instagram)' },
};

/** Perfil de render adaptado a hardware modesto (CPU-only, pocos nucleos). */
export const RENDER_PROFILES = {
  fast: { fps: 24, crf: 28, preset: 'veryfast', scaleHint: 1, audioBitrate: '128k' },
  balanced: { fps: 25, crf: 23, preset: 'medium', scaleHint: 1, audioBitrate: '192k' },
  quality: { fps: 30, crf: 20, preset: 'slow', scaleHint: 1, audioBitrate: '192k' },
};

export const CONFIG = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 4321),

  llm: {
    provider: process.env.LLM_PROVIDER || 'none',
    ollamaUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
    ollamaModel: process.env.OLLAMA_MODEL || 'llama3.2:3b',
    baseUrl: process.env.LLM_BASE_URL || '',
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || '',
  },

  tts: {
    provider: process.env.TTS_PROVIDER || (process.platform === 'win32' ? 'sapi' : 'none'),
    piperPath: process.env.PIPER_PATH || '',
    piperModel: process.env.PIPER_MODEL || '',
  },

  subtitles: {
    provider: process.env.SUBTITLE_PROVIDER || 'estimated',
    whisperBin: process.env.WHISPER_BIN || '',
    whisperModel: process.env.WHISPER_MODEL || '',
  },

  image: {
    provider: process.env.IMAGE_PROVIDER || 'local',
    pexelsKey: process.env.PEXELS_API_KEY || '',
  },

  render: {
    profile: process.env.RENDER_PROFILE || 'fast',
    threads: Number(process.env.RENDER_THREADS || 0), // 0 = decide FFmpeg
  },
};

/** Vista segura de la config para exponer en la API (sin secretos). */
export function publicConfig() {
  return {
    llm: {
      provider: CONFIG.llm.provider,
      model: CONFIG.llm.model || CONFIG.llm.ollamaModel,
      hasApiKey: Boolean(CONFIG.llm.apiKey),
    },
    tts: { provider: CONFIG.tts.provider, piperConfigured: Boolean(CONFIG.tts.piperPath) },
    subtitles: { provider: CONFIG.subtitles.provider },
    image: { provider: CONFIG.image.provider, hasPexelsKey: Boolean(CONFIG.image.pexelsKey) },
    render: CONFIG.render,
    aspects: ASPECTS,
  };
}
