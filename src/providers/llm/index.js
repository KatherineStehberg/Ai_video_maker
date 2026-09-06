import { CONFIG } from '../../config.js';
import { logger } from '../../lib/logger.js';

const log = logger('llm');

/**
 * Contrato de un provider LLM:
 *   id, label
 *   isAvailable(): Promise<boolean>
 *   complete({ system, prompt, maxTokens, temperature }): Promise<string>
 *
 * REGLA DEL PROYECTO: ningun provider es obligatorio.
 * `none` siempre esta disponible y hace que la capa IA sea opcional.
 */

const none = {
  id: 'none',
  label: 'Sin IA (guion manual)',
  isAvailable: async () => true,
  async complete() {
    const err = new Error('NO_LLM');
    err.code = 'NO_LLM';
    throw err;
  },
};

/** Ollama local: gratis, sin API key, corre en la maquina del usuario. */
const ollama = {
  id: 'ollama',
  label: 'Ollama local ($0)',
  async isAvailable() {
    try {
      const res = await fetch(`${CONFIG.llm.ollamaUrl}/api/tags`, {
        signal: AbortSignal.timeout(2500),
      });
      return res.ok;
    } catch {
      return false;
    }
  },
  async complete({ system, prompt, maxTokens = 1200, temperature = 0.7 }) {
    const res = await fetch(`${CONFIG.llm.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: CONFIG.llm.ollamaModel,
        stream: false,
        options: { temperature, num_predict: maxTokens },
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    return data?.message?.content?.trim() || '';
  },
};

/**
 * Cualquier endpoint compatible con la API de OpenAI:
 * DeepSeek, Groq, OpenRouter (modelos :free), Together, LM Studio, llama.cpp server...
 * Se configura por .env; sin API key el provider queda inactivo.
 */
const openaiCompatible = {
  id: 'openai-compatible',
  label: 'API compatible OpenAI (DeepSeek/Groq/OpenRouter/LM Studio)',
  async isAvailable() {
    return Boolean(CONFIG.llm.baseUrl && CONFIG.llm.model);
  },
  async complete({ system, prompt, maxTokens = 1200, temperature = 0.7 }) {
    const headers = { 'content-type': 'application/json' };
    if (CONFIG.llm.apiKey) headers.authorization = `Bearer ${CONFIG.llm.apiKey}`;
    const res = await fetch(`${CONFIG.llm.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: CONFIG.llm.model,
        temperature,
        max_tokens: maxTokens,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    return data?.choices?.[0]?.message?.content?.trim() || '';
  },
};

const REGISTRY = { none, ollama, 'openai-compatible': openaiCompatible };

export function getProvider(name) {
  return REGISTRY[name] || null;
}

/** Resuelve el provider efectivo. Si nada esta disponible devuelve `none`. */
export async function resolveProvider(preferred = 'auto') {
  const order = preferred && preferred !== 'auto'
    ? [preferred]
    : [CONFIG.llm.provider, 'ollama', 'openai-compatible', 'none'];
  for (const name of order) {
    const p = REGISTRY[name];
    if (!p) continue;
    try {
      if (await p.isAvailable()) return p;
    } catch (e) {
      log.warn(`LLM ${name} no disponible:`, e.message);
    }
  }
  return none;
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
