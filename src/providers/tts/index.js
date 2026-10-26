import * as sapi from './sapi.js';
import * as piper from './piper.js';
import * as edge from './edge.js';
import * as elevenlabs from './elevenlabs.js';
import { CONFIG } from '../../config.js';
import { logger } from '../../lib/logger.js';

const log = logger('tts');

/**
 * Provider "none": el video se renderiza sin narracion (modo silencioso).
 * Existe para que el pipeline NUNCA dependa de un motor de voz.
 */
const none = {
  id: 'none',
  label: 'Sin narracion (silencio)',
  isAvailable: async () => true,
  listVoices: async () => [],
  synthesize: async () => {
    throw new Error('El provider TTS "none" no genera audio');
  },
};

const REGISTRY = { sapi, piper, edge, elevenlabs, none };

export function getProvider(name) {
  return REGISTRY[name] || null;
}

/** Resuelve el provider efectivo: 'auto' elige el primero disponible. */
export async function resolveProvider(preferred = 'auto') {
  const order = preferred && preferred !== 'auto'
    ? [preferred]
    : [...new Set([CONFIG.tts.provider, 'edge', 'piper', 'sapi'].filter(n => n !== 'none' && n !== 'elevenlabs')), 'none'];

  for (const name of order) {
    const p = REGISTRY[name];
    if (!p) continue;
    try {
      if (await p.isAvailable()) return p;
      if (preferred === name && p.unavailableMessage) throw new Error(p.unavailableMessage);
    } catch (e) {
      if (preferred === name) throw e;
      log.warn(`Provider ${name} no disponible:`, e.message);
    }
  }
  if (preferred === 'elevenlabs') throw new Error('ElevenLabs no está configurado: agrega ELEVENLABS_API_KEY en el backend.');
  return none;
}

/** Todas las voces de todos los providers disponibles. */
export async function listAllVoices({ errors = null } = {}) {
  const out = [];
  for (const name of ['elevenlabs', 'edge', 'piper', 'sapi']) {
    const p = REGISTRY[name];
    try {
      if (await p.isAvailable()) out.push(...(await p.listVoices()));
    } catch (error) {
      if (errors) errors[name] = error.message;
    }
  }
  return out;
}

export async function listProviderModels(name) {
  const provider = REGISTRY[name];
  return provider?.listModels ? provider.listModels() : [];
}

export async function catalog() {
  const errors = {};
  const voices = await listAllVoices({ errors });
  let models = [];
  try {
    models = await listProviderModels('elevenlabs');
  } catch (error) {
    errors.elevenlabs = error.message;
  }
  if (!models.length && !CONFIG.tts.elevenLabsApiKey) {
    models = [{ id: CONFIG.tts.elevenLabsModel, name: CONFIG.tts.elevenLabsModel, canUseStyle: true, languages: ['en', 'es'] }];
  }
  return {
    voices,
    errors,
    models: { elevenlabs: models },
    providers: await status(),
    elevenLabsModel: CONFIG.tts.elevenLabsModel,
    elevenLabsVoiceSettings: CONFIG.tts.elevenLabsVoiceSettings,
  };
}

export async function status() {
  const out = {};
  for (const [name, p] of Object.entries(REGISTRY)) {
    try {
      out[name] = { available: await p.isAvailable(), label: p.label };
    } catch (e) {
      out[name] = { available: false, label: p.label, error: e.message };
    }
  }
  return out;
}
