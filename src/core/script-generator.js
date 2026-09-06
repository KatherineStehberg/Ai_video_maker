import { resolveProvider } from '../providers/llm/index.js';
import { getTemplate } from '../templates/index.js';
import { logger } from '../lib/logger.js';

const log = logger('script');

/**
 * Generacion de guion.
 *
 * DISENO CLAVE: la IA es OPCIONAL.
 *  - Si hay LLM disponible, genera el guion desde el brief.
 *  - Si NO hay LLM, devuelve un ESQUELETO editable con los beats del template.
 *    El usuario escribe encima. El pipeline sigue funcionando igual.
 */

function systemPrompt(project, brand, template) {
  return [
    'Eres un guionista de video corto para redes sociales.',
    `Idioma de salida: ${project.language === 'en' ? 'ingles' : 'espanol'}.`,
    brand?.name && brand.name !== 'Sin marca' ? `Marca: ${brand.name}.` : '',
    'Reglas estrictas:',
    '- Escribe SOLO el texto narrado, sin acotaciones tecnicas ni nombres de plano.',
    '- Una linea por escena.',
    '- Cada linea empieza con "## " seguida del texto de la escena.',
    '- Frases cortas, lenguaje hablado, sin emojis ni hashtags.',
    `- Ritmo objetivo: ${template.targetSeconds[0]}-${template.targetSeconds[1]} segundos en total.`,
    `- Maximo ${template.maxScenes} escenas.`,
  ].filter(Boolean).join('\n');
}

function userPrompt(project, template) {
  const beats = template.beats.map((b, i) => `${i + 1}. [${b.role}] ${b.prompt}`).join('\n');
  return [
    `Tema / brief: ${project.brief || project.title}`,
    project.objective ? `Objetivo: ${project.objective}` : '',
    project.audience ? `Audiencia: ${project.audience}` : '',
    project.cta ? `CTA final: ${project.cta}` : '',
    '',
    'Estructura obligatoria (una escena por punto):',
    beats,
    '',
    'Devuelve solo las lineas "## texto".',
  ].filter(Boolean).join('\n');
}

/** Extrae las lineas "## ..." de la respuesta del LLM; tolera formato imperfecto. */
export function parseScriptOutput(raw) {
  const text = String(raw || '');
  const marked = text.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('##'))
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .filter(Boolean);
  if (marked.length >= 2) return marked;

  // Fallback: el LLM ignoro el formato. Usamos parrafos / lineas no vacias.
  return text.split(/\r?\n+/)
    .map((l) => l.replace(/^[-*\d.)\s]+/, '').trim())
    .filter((l) => l.length > 10);
}

/** Esqueleto sin IA: una linea por beat, lista para que el usuario la edite. */
export function skeletonScript(project, template) {
  return template.beats
    .map((b) => `## [${b.role.toUpperCase()}] ${b.prompt}. (Escribe aqui tu texto)`)
    .join('\n');
}

/**
 * Devuelve { script, lines[], source }
 *   source: 'llm' | 'skeleton' | 'manual'
 * NUNCA lanza por falta de LLM.
 */
export async function generateScript(project, brand = {}, { provider = 'auto' } = {}) {
  const template = getTemplate(project.template);

  // Si el usuario ya escribio un guion, se respeta tal cual.
  if (project.script?.trim() && !project.script.includes('(Escribe aqui tu texto)')) {
    return { script: project.script, lines: parseScriptOutput(project.script), source: 'manual' };
  }

  const llm = await resolveProvider(provider);
  if (llm.id === 'none') {
    log.info('Sin LLM: se genera esqueleto editable (modo sin IA)');
    const script = skeletonScript(project, template);
    return { script, lines: parseScriptOutput(script), source: 'skeleton' };
  }

  try {
    const raw = await llm.complete({
      system: systemPrompt(project, brand, template),
      prompt: userPrompt(project, template),
      maxTokens: 1400,
      temperature: 0.75,
    });
    const lines = parseScriptOutput(raw);
    if (lines.length < 2) throw new Error('Respuesta del LLM demasiado corta');
    const trimmed = lines.slice(0, template.maxScenes);
    return {
      script: trimmed.map((l) => `## ${l}`).join('\n'),
      lines: trimmed,
      source: 'llm',
      providerId: llm.id,
    };
  } catch (e) {
    // Degradar, nunca romper: el usuario sigue pudiendo trabajar a mano.
    log.warn('LLM fallo, se cae a esqueleto:', e.message);
    const script = skeletonScript(project, template);
    return { script, lines: parseScriptOutput(script), source: 'skeleton', error: e.message };
  }
}

/**
 * Sugiere prompts visuales por escena. Con LLM los genera; sin LLM deriva
 * palabras clave del propio texto (suficiente para buscar imagenes locales).
 */
export async function suggestVisualPrompts(project, { provider = 'auto' } = {}) {
  const scenes = project.scenes || [];
  const llm = await resolveProvider(provider);

  if (llm.id === 'none') {
    return scenes.map((s) => keywordsFrom(s.text));
  }
  try {
    const raw = await llm.complete({
      system: 'Devuelve una descripcion visual corta (max 12 palabras, en ingles, apta para banco ' +
        'de imagenes) por cada escena. Una por linea, prefijada con "## ". Sin numeracion.',
      prompt: scenes.map((s, i) => `${i + 1}. ${s.text}`).join('\n'),
      maxTokens: 600,
      temperature: 0.5,
    });
    const lines = parseScriptOutput(raw);
    return scenes.map((s, i) => lines[i] || keywordsFrom(s.text));
  } catch {
    return scenes.map((s) => keywordsFrom(s.text));
  }
}

const STOPWORDS = new Set([
  'para', 'como', 'este', 'esta', 'esto', 'pero', 'porque', 'cuando', 'donde', 'sobre',
  'entre', 'todo', 'toda', 'mas', 'muy', 'que', 'con', 'los', 'las', 'del', 'una', 'uno',
  'por', 'sin', 'the', 'and', 'for', 'you', 'your', 'with', 'this', 'that', 'from',
]);

/** Palabras significativas del texto, para buscar assets sin depender de IA. */
export function keywordsFrom(text, max = 6) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w))
    .slice(0, max)
    .join(' ');
}
