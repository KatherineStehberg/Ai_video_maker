import { getTemplate } from '../templates/index.js';
import { resolveProvider } from '../providers/llm/index.js';
import { keywordsFrom, parseScriptOutput } from '../core/script-generator.js';
import { estimateDuration, clamp } from '../lib/util.js';
import { segmentarGuion, WPM_POR_DEFECTO, SEGUNDOS_POR_ESCENA } from './segmenter.js';

/**
 * Ventana de segundos por escena que toca usar con este template.
 *
 * Un template corto (`reel-promocional`, 2.5-5 s) partiría un guion educativo
 * en cientos de escenas de una frase. Para guiones propios se respeta la
 * ventana del template, pero nunca por debajo de lo que hace falta para que
 * una escena contenga una idea completa.
 */
export function segundosPorEscenaDe(template) {
  const [min, max] = template?.sceneSeconds || [SEGUNDOS_POR_ESCENA.min, SEGUNDOS_POR_ESCENA.max];
  return {
    min: Math.max(1.2, min),
    objetivo: Math.max(SEGUNDOS_POR_ESCENA.min, Math.min(SEGUNDOS_POR_ESCENA.objetivo, (min + max) / 2)),
    max: Math.max(min + 1, max),
  };
}

/**
 * Redacción del guion a partir del prompt.
 *
 * Dos caminos, en este orden:
 *   1. LLM, si hay uno configurado (Ollama local, API compatible OpenAI, Gemini).
 *   2. PLANTILLA LOCAL: sin IA, sin red y sin coste.
 *
 * La plantilla local NO escribe como un guionista. Lo que hace es DETECTAR en
 * el prompt los beneficios concretos que la usuaria ya mencionó y convertirlos
 * en frases cortas. Por eso el guion habla de horarios flexibles o de práctica
 * de conversación cuando el prompt los nombra, en vez de rellenar con frases
 * vacías. Se declara siempre como `plantilla-local`, nunca como redacción de IA.
 *
 * NUNCA inventa precios, testimonios, resultados garantizados ni datos de
 * contacto: sólo reformula lo que el prompt dice.
 */

const COLAS = /\b(tono|estilo|formato|duraci[oó]n|con m[uú]sica|destaca|destacando|resalta|termina|terminando|para (tiktok|instagram|youtube|reels|shorts))\b[^]*$/i;

/**
 * Capas de envoltorio que se retiran en orden hasta llegar al tema. Se aplican
 * repetidamente porque un prompt real las encadena:
 *   "Crea un reel vertical de 15 segundos para promocionar clases de inglés"
 *    └ imperativo ┘└ formato ┘└ duración ┘└ conector ┘└──── tema ────┘
 */
const ENVOLTORIOS = [
  /^(por favor,?\s*)?(crea|haz|genera|hazme|quiero|necesito|dame)\b\s*/i,
  /^(un|una|el|la|los|las)\s+/i,
  /^(video|v[ií]deo|clip|reel|short|anuncio|spot|pieza)\b\s*/i,
  /^(vertical|horizontal|cuadrado|corto|breve)\b\s*/i,
  // Adjetivos de tipo de pieza: "promocional" no es el tema, es el formato.
  /^(promocional|publicitario|explicativo|educativo|informativo|corporativo|institucional)\b\s*/i,
  /^de\s+\d+\s*(segundos?|s|minutos?)\b\s*/i,
  /^(para\s+)?(promocionar|promover|presentar|explicar|mostrar|vender|anunciar)\b\s*/i,
  /^(sobre|acerca de|de|para|que muestre|que explique|que promocione)\b\s*/i,
];

/** Extrae el tema del prompt, quitando envoltorio descriptivo y duración. */
export function extraerTema(prompt) {
  let t = String(prompt || '').replace(/\s+/g, ' ').trim();
  t = t.replace(COLAS, '').trim();
  t = t.split(/[.;]/)[0].trim();

  // Se pela capa a capa mientras alguna coincida al principio.
  let cambio = true;
  while (cambio && t.length > 3) {
    cambio = false;
    for (const capa of ENVOLTORIOS) {
      const pelado = t.replace(capa, '').trim();
      if (pelado !== t && pelado.length >= 4) { t = pelado; cambio = true; }
    }
  }

  t = t.replace(/[,\s]+$/, '');
  return t.length >= 3 ? t : String(prompt || '').trim().slice(0, 80);
}

/**
 * Beneficios detectables en el prompt. Cada uno aporta una frase concreta y un
 * término de búsqueda visual. El orden define la prioridad al recortar.
 *
 * REGLA: la frase sólo reformula lo que el prompt ya afirma. Si el prompt no
 * menciona algo, no aparece en el guion.
 */
export const BENEFICIOS = [
  { id: 'particular', test: /\bparticular(es)?\b|\b1 a 1\b|\buno a uno\b|\bindividual(es)?\b/i,
    frase: 'Clases particulares, con toda la atención puesta en ti.', titulo: 'Clases particulares', visual: 'private tutor one on one lesson' },
  { id: 'online', test: /\bonline\b|\ba distancia\b|\bvirtual(es)?\b|\bremot[ao]s?\b/i,
    frase: 'Todo online, desde donde estés.', titulo: 'Desde donde estés', visual: 'online video call laptop study home' },
  { id: 'horarios', test: /\bhorarios?\s+flexibles?\b|\bflexibilidad\b|\ba tu ritmo\b|\bcuando quieras\b/i,
    frase: 'Horarios flexibles que se adaptan a tu agenda.', titulo: 'Horarios flexibles', visual: 'calendar schedule planning desk' },
  { id: 'conversacion', test: /\bconversaci[oó]n\b|\bhablar\b|\bspeaking\b|\bfluidez\b/i,
    frase: 'Practicas conversación desde la primera clase.', titulo: 'Practica hablando', visual: 'two people talking conversation coffee' },
  { id: 'laboral', test: /\bobjetivos?\s+laborales?\b|\btrabajo\b|\bprofesional(es)?\b|\bcarrera\b|\bentrevista\b/i,
    frase: 'Enfocado en tus objetivos laborales.', titulo: 'Para tu trabajo', visual: 'business meeting professional office' },
  { id: 'adultos', test: /\badultos?\b|\bmayores\b/i,
    frase: 'Pensado para adultos que empiezan o retoman.', titulo: 'Para adultos', visual: 'adult student learning classroom' },
  { id: 'principiantes', test: /\bprincipiantes?\b|\bdesde cero\b|\bb[aá]sico\b/i,
    frase: 'Puedes empezar desde cero.', titulo: 'Desde cero', visual: 'beginner notebook writing study' },
  { id: 'grupos', test: /\bgrupos?\b|\bgrupal(es)?\b/i,
    frase: 'También en grupos reducidos.', titulo: 'Grupos reducidos', visual: 'small group class students' },
];

/** Cierres posibles, según lo que el prompt pida hacer. */
const CIERRES = [
  { test: /\bwhatsapp\b/i, frase: 'Escríbenos por WhatsApp y te contamos.', titulo: 'Escríbenos', visual: 'person texting phone message' },
  { test: /\bsolicitar informaci[oó]n\b|\bm[aá]s informaci[oó]n\b|\binformaci[oó]n\b/i, frase: 'Solicita información y empieza cuando quieras.', titulo: 'Solicita información', visual: 'person using smartphone contact' },
  { test: /\bagenda\b|\breserva\b|\bcita\b/i, frase: 'Agenda tu primera clase.', titulo: 'Agenda tu clase', visual: 'booking appointment calendar phone' },
  { test: /\binscr[ií]b/i, frase: 'Inscríbete y comienza.', titulo: 'Inscríbete', visual: 'sign up form registration' },
];

const CIERRE_POR_DEFECTO = { frase: 'Escríbenos y te contamos cómo empezar.', titulo: 'Escríbenos', visual: 'person using smartphone contact' };

/** Título corto para pantalla. Se corta por palabras, nunca a mitad de una. */
export function titular(texto, max = 32) {
  const limpio = String(texto).replace(/\s+/g, ' ').trim().replace(/^[¿¡]/, '').replace(/[.?!]+$/, '');
  if (limpio.length <= max) return limpio.charAt(0).toUpperCase() + limpio.slice(1);
  const corto = limpio.slice(0, max).replace(/\s+\S*$/, '');
  return corto.charAt(0).toUpperCase() + corto.slice(1);
}

/**
 * Palabras por minuto REALES del TTS local narrando español.
 *
 * Los templates declaran 165-175 wpm, que es el ritmo de un locutor humano.
 * SAPI y Piper hablan bastante más despacio, así que presupuestar con el wpm
 * del template produce guiones que no caben y obligan a acelerar la voz hasta
 * que suena atropellada. Medido sobre la voz local: ~115 wpm.
 */
export const WPM_NARRACION_LOCAL = 115;

/** Ritmo efectivo para presupuestar: nunca más optimista que el TTS real. */
export const wpmEfectivo = template => Math.min(template.wpm, WPM_NARRACION_LOCAL);

/** Palabras que caben en `segundos` a `wpm` palabras por minuto. */
export const palabrasQueCaben = (segundos, wpm) => Math.max(2, Math.floor((segundos * wpm) / 60));

/**
 * Reparte `objetivo` segundos entre las escenas, en proporción a su texto.
 *
 * Escalar y recortar en un solo paso no basta: cuando una escena topa con el
 * máximo del template, su exceso se pierde y el total se queda corto (con 6
 * escenas de 5 s no se llegaba a un objetivo de 30 s). Aquí se reparte el
 * sobrante entre las escenas que todavía tienen margen, y si ninguna lo tiene
 * se estira a todas por igual: una imagen fija aguanta más tiempo en pantalla
 * sin romper nada.
 */
export function repartirDuracion(naturales, objetivo, min, max) {
  let d = naturales.map(v => clamp(v, min, max));
  for (let vuelta = 0; vuelta < 8; vuelta++) {
    const total = d.reduce((a, b) => a + b, 0);
    if (Math.abs(total - objetivo) < 0.01) return d;
    const subir = objetivo > total;
    const libres = d.map(v => (subir ? v < max - 1e-6 : v > min + 1e-6));
    if (!libres.some(Boolean)) break;
    const sumaLibres = d.reduce((a, v, i) => a + (libres[i] ? v : 0), 0);
    if (sumaLibres <= 0) break;
    const fijo = total - sumaLibres;
    const k = (objetivo - fijo) / sumaLibres;
    d = d.map((v, i) => (libres[i] ? clamp(v * k, min, max) : v));
  }
  const total = d.reduce((a, b) => a + b, 0);
  const resto = (objetivo - total) / d.length;
  return d.map(v => Math.max(0.8, v + resto));
}

/** Recorta a un número de palabras sin partir ninguna ni dejar puntuación suelta. */
export function recortarPalabras(texto, maxPalabras) {
  const palabras = String(texto).trim().split(/\s+/);
  if (palabras.length <= maxPalabras) return texto.trim();
  const corto = palabras.slice(0, maxPalabras).join(' ').replace(/[,;:]$/, '');
  return /[.?!]$/.test(corto) ? corto : `${corto}.`;
}

/**
 * Construye el guion local ajustado a la duración objetivo.
 *
 * El presupuesto manda: primero se calcula cuántas palabras caben en los
 * segundos pedidos, y luego se eligen las escenas que quepan. Si no cabe todo,
 * se recortan escenas ENTERAS por prioridad (el gancho y el cierre siempre se
 * conservan) en vez de cortar frases por la mitad.
 */
export function draftLocal(spec, template) {
  const tema = extraerTema(spec.prompt);
  const prompt = String(spec.prompt || '');
  const wpm = wpmEfectivo(template);
  // `auto`: la duración la marca el guion, no al revés. No se recorta nada.
  const automatico = spec.duration === null || spec.duration === undefined || spec.duration === 'auto';
  const objetivo = automatico ? null : Number(spec.duration) || template.targetSeconds[0];

  // 1. Gancho: nombra el tema, acotado para no comerse el presupuesto.
  const temaCorto = recortarPalabras(tema, 7).replace(/\.$/, '');
  const gancho = {
    role: 'hook', prioridad: 0,
    text: `¿Buscas ${temaCorto}?`,
    onScreenTitle: titular(tema),
    visualPrompt: keywordsFrom(`${tema}`),
  };

  // 2. Cuerpo: un beneficio por escena, sólo los que el prompt menciona.
  //    Lo que el prompt pide DESTACAR tiene prioridad sobre lo demás: si hay
  //    que recortar por duración, eso es lo último que se cae.
  const destacado = /\b(destaca|destacando|resalta|enfat[ií]za|menciona)\b([^.;]*)/i.exec(prompt)?.[2] || '';
  const cuerpo = BENEFICIOS.filter(b => b.test.test(prompt)).map((b, i) => ({
    role: 'point',
    prioridad: (b.test.test(destacado) ? 0.6 : 1) + i * 0.01,
    text: b.frase, onScreenTitle: b.titulo, visualPrompt: b.visual, beneficio: b.id,
    destacado: b.test.test(destacado),
  }));

  // 3. Cierre: la acción que el prompt pide, sin inventar datos de contacto.
  const cierreDetectado = CIERRES.find(c => c.test.test(prompt)) || CIERRE_POR_DEFECTO;
  const cierre = {
    role: 'cta', prioridad: 0.5,
    text: cierreDetectado.frase, onScreenTitle: cierreDetectado.titulo, visualPrompt: cierreDetectado.visual,
  };

  // Si el prompt no nombra ningún beneficio, se usa su propio contenido antes
  // que una frase de relleno.
  if (!cuerpo.length) {
    for (const [i, idea] of ideasDelPrompt(prompt).slice(0, 3).entries()) {
      cuerpo.push({ role: 'point', prioridad: i + 1, text: `${titular(idea, 120)}.`, onScreenTitle: titular(idea), visualPrompt: keywordsFrom(idea) });
    }
  }
  if (!cuerpo.length) {
    cuerpo.push({ role: 'point', prioridad: 1, text: `Te contamos cómo funciona ${tema}.`, onScreenTitle: titular(tema), visualPrompt: keywordsFrom(tema) });
  }

  // 4. Presupuesto: se quitan escenas de menor prioridad hasta que quepa.
  //    En modo automático no hay recorte: cabe todo lo que diga el guion.
  const presupuesto = automatico ? Infinity : palabrasQueCaben(objetivo, wpm);
  const cuenta = t => t.trim().split(/\s+/).length;
  let elegidas = [gancho, ...cuerpo, cierre];
  const descartadas = [];
  while (elegidas.reduce((a, e) => a + cuenta(e.text), 0) > presupuesto && elegidas.length > 2) {
    const peor = elegidas.reduce((a, b) => (b.prioridad > a.prioridad ? b : a));
    elegidas = elegidas.filter(e => e !== peor);
    descartadas.push(peor.onScreenTitle);
  }

  // 5. Duración por escena, repartida en proporción a su texto y ajustada para
  //    que la suma sea exactamente el objetivo.
  const [minSec, maxSec] = template.sceneSeconds;
  const naturales = elegidas.map(e => Math.max(0.8, estimateDuration(e.text, wpm)));
  const duraciones = automatico
    ? naturales.map(v => Math.max(1.2, v))          // el guion manda
    : repartirDuracion(naturales, objetivo, Math.min(minSec, 1.2), maxSec);

  const escenas = elegidas.map((e, i) => ({
    role: e.role,
    text: recortarPalabras(e.text, palabrasQueCaben(maxSec, wpm)),
    onScreenTitle: e.onScreenTitle,
    visualPrompt: e.visualPrompt,
    duration: Number(duraciones[i].toFixed(2)),
    ...(e.beneficio ? { beneficio: e.beneficio } : {}),
  }));

  return { escenas, tema, source: 'plantilla-local', descartadas,
    presupuestoPalabras: automatico ? null : presupuesto, durationMode: automatico ? 'auto' : 'fija' };
}

/** Trocea el prompt en ideas aprovechables cuando no hay beneficios detectables. */
export function ideasDelPrompt(prompt) {
  return String(prompt || '')
    .split(/[.;\n]|,(?=\s*(?:y|con|para|que)\b)/i)
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(s => s.split(/\s+/).length >= 3 && s.length <= 140)
    .slice(1);
}

/** Convierte escenas en el formato de guion "## línea" que entiende el pipeline. */
export const escenasAGuion = escenas => escenas.map(e => `## ${e.text}`).join('\n');

/** Duración estimada total del guion, en segundos. */
export const duracionGuion = escenas =>
  Number((escenas || []).reduce((a, e) => a + (Number(e.duration) || 0), 0).toFixed(2));

/**
 * Punto de entrada: intenta el LLM configurado y, si no hay o falla, cae a la
 * plantilla local. Nunca lanza por falta de IA.
 */
export async function draftScript(spec, { templateId, provider = 'auto' } = {}) {
  const template = getTemplate(templateId);

  // GUION PROPIO: manda sobre todo lo demás. No se reescribe, no se resume y
  // no se recorta; sólo se trocea en escenas narrables. Ni el LLM ni la
  // plantilla local intervienen, porque el texto ya está escrito.
  if (spec.script && String(spec.script).trim()) {
    const wpm = Number(spec.wpm) > 0 ? Number(spec.wpm) : WPM_POR_DEFECTO;
    const tema = spec.title || extraerTema(spec.prompt || spec.script);
    const { escenas, advertencias } = segmentarGuion(spec.script, {
      wpm,
      segundosPorEscena: segundosPorEscenaDe(template),
      tema,
    });
    if (!escenas.length) throw new Error('El guion no tiene texto narrable.');
    return {
      escenas, tema, source: 'guion-propio', provider: 'ninguno',
      templateId: template.id, durationMode: spec.duration == null ? 'auto' : 'fija',
      advertencias,
    };
  }

  const llm = await resolveProvider(provider);

  if (llm.id === 'none') {
    return { ...draftLocal(spec, template), templateId: template.id, provider: 'ninguno' };
  }

  try {
    const automatico = spec.duration === null || spec.duration === undefined || spec.duration === 'auto';
    const objetivo = automatico ? null : Number(spec.duration) || template.targetSeconds[0];
    const presupuesto = automatico ? 400 : palabrasQueCaben(objetivo, wpmEfectivo(template));
    const raw = await llm.complete({
      system: [
        'Eres guionista de video corto en español.',
        'Devuelve una línea por escena, cada una empezando con "## ".',
        'Solo el texto que se narra: sin acotaciones, sin emojis, sin hashtags.',
        `El guion COMPLETO no puede superar ${presupuesto} palabras: es la duración contratada.`,
        'No inventes precios, testimonios, resultados garantizados ni datos de contacto.',
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
    const naturales = lineas.map(t => Math.max(0.8, estimateDuration(t, wpmEfectivo(template))));
    const factor = automatico ? 1 : objetivo / naturales.reduce((a, b) => a + b, 0);
    const escenas = lineas.map((text, i) => ({
      role: template.beats[i]?.role || 'point',
      text,
      onScreenTitle: titular(text),
      visualPrompt: keywordsFrom(`${tema} ${text}`),
      duration: Number(clamp(naturales[i] * factor, Math.min(minSec, 1.2), maxSec).toFixed(2)),
    }));
    return { escenas, tema, source: 'llm', provider: llm.id, templateId: template.id };
  } catch (e) {
    const local = draftLocal(spec, template);
    return { ...local, templateId: template.id, provider: 'ninguno', llmError: e.message };
  }
}
