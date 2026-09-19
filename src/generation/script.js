import { getTemplate } from '../templates/index.js';
import { resolveProvider } from '../providers/llm/index.js';
import { keywordsFrom, parseScriptOutput } from '../core/script-generator.js';
import { estimateDuration, clamp } from '../lib/util.js';

/**
 * Redacción del guion a partir del prompt.
 *
 * Dos caminos, en este orden:
 *   1. LLM, si hay uno configurado (Ollama local, API compatible OpenAI, Gemini).
 *   2. PLANTILLA LOCAL: sin IA, sin red y sin coste.
 *
 * La plantilla local NO escribe como un guionista: compone frases a partir de
 * los beats del template e inserta el tema extraído del prompt. El resultado
 * habla del tema pedido y es editable escena por escena, pero es texto de
 * plantilla, y así se declara (`source: 'plantilla-local'`). No se presenta
 * como redacción de IA.
 */

/** Muletillas típicas del prompt que no forman parte del tema. */
const PREFIJOS = /^(un |una |el |la |los |las )?(video|v[ií]deo|clip|reel|short|anuncio|spot)\b[^]*?\b(sobre|acerca de|de|para|que muestre|que explique)\b/i;
const COLAS = /\b(tono|estilo|formato|duraci[oó]n|con m[uú]sica|para (tiktok|instagram|youtube|reels|shorts))\b[^]*$/i;

/** Extrae el tema del prompt, quitando envoltorio descriptivo. */
export function extraerTema(prompt) {
  let t = String(prompt || '').replace(/\s+/g, ' ').trim();
  t = t.replace(COLAS, '').trim();
  const sinPrefijo = t.replace(PREFIJOS, '').trim();
  if (sinPrefijo.length >= 8) t = sinPrefijo;
  t = t.split(/[.;]/)[0].trim();          // primera oración
  t = t.replace(/[,\s]+$/, '');
  return t.length >= 3 ? t : String(prompt || '').trim().slice(0, 80);
}

/** Título corto para mostrar en pantalla: sin artículos iniciales y capitalizado. */
function titular(texto, max = 42) {
  const limpio = String(texto).replace(/\s+/g, ' ').trim().replace(/^[¿¡]/, '');
  const corto = limpio.length <= max ? limpio : limpio.slice(0, max).replace(/\s+\S*$/, '') + '…';
  return corto.charAt(0).toUpperCase() + corto.slice(1);
}

/**
 * Banco de frases por rol de beat. Cada entrada recibe el contexto y devuelve
 * { narracion, titulo }. Es copy de plantilla, deliberadamente sobrio.
 */
const FRASES = {
  hook: ({ tema }) => ({ narracion: `¿Te interesa ${tema}?`, titulo: titular(tema) }),
  problem: ({ tema, publico }) => ({
    narracion: `Muchas personas${publico ? ` (${publico})` : ''} no saben por dónde empezar con ${tema}.`,
    titulo: '¿Por dónde empiezo?',
  }),
  context: ({ tema }) => ({ narracion: `Hoy ${tema} es más accesible de lo que parece.`, titulo: 'Por qué importa' }),
  promise: ({ tema }) => ({ narracion: `Te explicamos lo esencial sobre ${tema} en muy poco tiempo.`, titulo: 'Lo esencial' }),
  point: ({ tema, indice, claves }) => {
    const clave = claves[indice % Math.max(1, claves.length)];
    return clave
      ? { narracion: `${titular(clave, 120)}.`, titulo: titular(clave) }
      : { narracion: `Una idea clave sobre ${tema}.`, titulo: `Idea ${indice + 1}` };
  },
  proof: ({ tema }) => ({ narracion: `Es una forma concreta de avanzar con ${tema}.`, titulo: 'En concreto' }),
  offer: ({ tema }) => ({ narracion: `Aquí puedes empezar con ${tema} cuando quieras.`, titulo: 'Empieza hoy' }),
  cta: ({ cta }) => ({ narracion: cta || 'Escríbenos y te contamos cómo empezar.', titulo: titular(cta || 'Escríbenos') }),
};

const porDefecto = ({ tema, indice }) => ({ narracion: `Más sobre ${tema}.`, titulo: `Punto ${indice + 1}` });

/**
 * Trocea el prompt en ideas aprovechables para los beats de tipo "point".
 * Se usa lo que escribió la usuaria antes que cualquier frase inventada.
 */
export function ideasDelPrompt(prompt) {
  return String(prompt || '')
    .split(/[.;\n]|,(?=\s*(?:y|con|para|que)\b)/i)
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(s => s.split(/\s+/).length >= 3 && s.length <= 140)
    .slice(1);                            // la primera oración ya es el tema
}

/**
 * Borrador local del guion. Devuelve escenas con narración, título en pantalla,
 * instrucción visual y duración estimada. No toca la red.
 */
export function draftLocal(spec, template) {
  const tema = extraerTema(spec.prompt);
  const claves = ideasDelPrompt(spec.prompt);
  const ctx = { tema, publico: spec.audience || null, cta: spec.cta || null, claves };

  const [minSec, maxSec] = template.sceneSeconds;
  let indicePunto = 0;

  const escenas = template.beats.map((beat, i) => {
    const hacer = FRASES[beat.role] || porDefecto;
    const { narracion, titulo } = hacer({ ...ctx, indice: beat.role === 'point' ? indicePunto++ : i });
    const duracion = clamp(estimateDuration(narracion, template.wpm), minSec, maxSec);
    return {
      role: beat.role,
      text: narracion,
      onScreenTitle: titulo,
      visualPrompt: keywordsFrom(`${tema} ${narracion}`),
      duration: Number(duracion.toFixed(2)),
    };
  });

  return { escenas, tema, source: 'plantilla-local' };
}

/** Convierte escenas en el formato de guion "## línea" que entiende el pipeline. */
export const escenasAGuion = escenas => escenas.map(e => `## ${e.text}`).join('\n');

/**
 * Punto de entrada: intenta el LLM configurado y, si no hay o falla, cae a la
 * plantilla local. Nunca lanza por falta de IA.
 */
export async function draftScript(spec, { templateId, provider = 'auto' } = {}) {
  const template = getTemplate(templateId);
  const llm = await resolveProvider(provider);

  if (llm.id === 'none') {
    return { ...draftLocal(spec, template), templateId: template.id, provider: 'ninguno' };
  }

  try {
    const raw = await llm.complete({
      system: [
        'Eres guionista de video corto en español.',
        'Devuelve una línea por escena, cada una empezando con "## ".',
        'Solo el texto que se narra: sin acotaciones, sin emojis, sin hashtags.',
        `Máximo ${template.beats.length} escenas, frases habladas y breves.`,
      ].join('\n'),
      prompt: [
        `Tema: ${spec.prompt}`,
        spec.audience ? `Audiencia: ${spec.audience}` : '',
        spec.platform ? `Plataforma: ${spec.platform}` : '',
        '',
        'Estructura:',
        template.beats.map((b, i) => `${i + 1}. [${b.role}] ${b.prompt}`).join('\n'),
      ].filter(Boolean).join('\n'),
      maxTokens: 900,
      temperature: 0.7,
    });

    const lineas = parseScriptOutput(raw).slice(0, template.beats.length);
    if (lineas.length < 2) throw new Error('El modelo devolvió muy pocas escenas');

    const [minSec, maxSec] = template.sceneSeconds;
    const tema = extraerTema(spec.prompt);
    const escenas = lineas.map((text, i) => ({
      role: template.beats[i]?.role || 'point',
      text,
      onScreenTitle: titular(text),
      visualPrompt: keywordsFrom(`${tema} ${text}`),
      duration: Number(clamp(estimateDuration(text, template.wpm), minSec, maxSec).toFixed(2)),
    }));
    return { escenas, tema, source: 'llm', provider: llm.id, templateId: template.id };
  } catch (e) {
    // Degradar, nunca romper: la plantilla local siempre produce algo editable.
    const local = draftLocal(spec, template);
    return { ...local, templateId: template.id, provider: 'ninguno', llmError: e.message };
  }
}
