import * as sapi from './sapi.js';
import * as piper from './piper.js';
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

const REGISTRY = { sapi, piper, none };

export function getProvider(name) {
  return REGISTRY[name] || null;
}

/** Resuelve el provider efectivo: 'auto' elige el primero disponible. */
export async function resolveProvider(preferred = 'auto') {
  const order = preferred && preferred !== 'auto'
    ? [preferred]
    : [CONFIG.tts.provider, 'piper', 'sapi', 'none'];

  for (const name of order) {
    const p = REGISTRY[name];
    if (!p) continue;
    try {
      if (await p.isAvailable()) return p;
    } catch (e) {
      log.warn(`Provider ${name} no disponible:`, e.message);
    }
  }
  return none;
}

/** Todas las voces de todos los providers disponibles. */
export async function listAllVoices() {
  const out = [];
  for (const name of ['piper', 'sapi']) {
    const p = REGISTRY[name];
    try {
      if (await p.isAvailable()) out.push(...(await p.listVoices()));
    } catch {
      /* provider no operativo */
    }
  }
  return out;
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
