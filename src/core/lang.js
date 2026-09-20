/**
 * IDIOMA DE NARRACION
 *
 * Un guion puede ser monolingue (es / en) o bilingue. El idioma de cada tramo
 * se marca de forma EXPLICITA en el texto:
 *
 *     Hoy practicamos [en]the board approved the budget[/en] y seguimos.
 *
 * No hay deteccion heuristica: una frase corta o un nombre propio se clasifican
 * mal con demasiada frecuencia, y el error se escucha. Lo que no lleva marca
 * usa el idioma base del proyecto.
 *
 * Los tags son marcas de produccion: nunca se narran ni llegan a los
 * subtitulos ni al texto en pantalla.
 */

/** Idiomas de proyecto admitidos. 'bilingual' narra en ambos segun los tags. */
export const LANGUAGES = ['es', 'en', 'bilingual'];

/** Voces preferidas por idioma cuando el proyecto no fija una. */
export const DEFAULT_VOICES = {
  en: 'Microsoft Zira Desktop',
  es: 'Microsoft Sabina Desktop',
};

const PAIR_RE = /\[(en|es)\]([\s\S]*?)\[\/\1\]/gi;
const STRAY_RE = /\[\/?(?:en|es)\]/gi;

/** Idioma base del proyecto: el que se usa para el texto sin marcar. */
export function baseLanguage(language) {
  const l = String(language || '').toLowerCase();
  if (l === 'en') return 'en';
  // 'bilingual' narra en espanol lo que no lleva marca; el ingles va marcado.
  return 'es';
}

export function normalizeLanguage(language) {
  const l = String(language || '').toLowerCase();
  return LANGUAGES.includes(l) ? l : 'es';
}

/**
 * Quita los tags conservando el texto interior.
 * Se usa en subtitulos, titulos en pantalla y metadatos.
 */
export function stripLangTags(text) {
  return String(text ?? '')
    .replace(PAIR_RE, (_m, _lang, inner) => inner)
    .replace(STRAY_RE, '')   // tags sueltos o mal cerrados: tampoco se ven
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** true si el texto trae alguna marca de idioma (incluso suelta). */
export function hasLangTags(text) {
  STRAY_RE.lastIndex = 0;
  return STRAY_RE.test(String(text ?? ''));
}

/**
 * Parte el texto en tramos con idioma.
 * Devuelve [{ lang, text }] sin tramos vacios. El texto fuera de tags toma
 * `base`. Un tag mal cerrado no rompe nada: se limpia y el resto sigue.
 */
export function parseLangSegments(text, base = 'es') {
  const source = String(text ?? '');
  const baseLang = base === 'en' ? 'en' : 'es';
  const out = [];
  const push = (lang, chunk) => {
    const clean = String(chunk).replace(STRAY_RE, '');
    if (clean.trim()) out.push({ lang, text: clean.trim() });
  };

  let last = 0;
  PAIR_RE.lastIndex = 0;
  let m;
  while ((m = PAIR_RE.exec(source)) !== null) {
    push(baseLang, source.slice(last, m.index));
    push(m[1].toLowerCase(), m[2]);
    last = m.index + m[0].length;
  }
  push(baseLang, source.slice(last));

  // Tramos contiguos del mismo idioma se unen: un <voice> por frase corta
  // entrecorta la prosodia sin necesidad.
  return out.reduce((acc, seg) => {
    const prev = acc[acc.length - 1];
    if (prev && prev.lang === seg.lang) prev.text += ` ${seg.text}`;
    else acc.push({ ...seg });
    return acc;
  }, []);
}

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const xmlEscape = s => String(s).replace(/[&<>"']/g, c => XML_ESCAPES[c]);

/** Cultura SSML por idioma. */
export const CULTURE = { en: 'en-US', es: 'es-MX' };

/**
 * SSML para SAPI (System.Speech). Un <voice> por tramo, con `name` explicito:
 * seleccionar por nombre es determinista, mientras que dejarlo a xml:lang
 * depende de que voz tenga el sistema por defecto para esa cultura.
 */
export function buildSsml(segments, voices, { baseLang = 'es' } = {}) {
  const body = segments.map((seg) => {
    const name = voices[seg.lang] || voices[baseLang] || '';
    const culture = CULTURE[seg.lang] || CULTURE.es;
    const attrs = name
      ? `name="${xmlEscape(name)}" xml:lang="${culture}"`
      : `xml:lang="${culture}"`;
    return `<voice ${attrs}>${xmlEscape(seg.text)}</voice>`;
  }).join('');

  return '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
    + `xml:lang="${CULTURE[baseLang] || CULTURE.es}">${body}</speak>`;
}

/** Idioma de una voz instalada a partir de su cultura ('es-MX' -> 'es'). */
export function voiceLanguage(voice) {
  return String(voice?.language || '').slice(0, 2).toLowerCase();
}

/**
 * Elige la voz de un idioma entre las instaladas.
 * Orden: la preferida del proyecto (si es de ese idioma) > la voz por defecto
 * del idioma > la primera instalada de ese idioma.
 */
export function pickVoice(lang, installed = [], preferred = '') {
  const sameLang = installed.filter(v => voiceLanguage(v) === lang);
  const wanted = String(preferred || '').trim();
  if (wanted && sameLang.some(v => v.name === wanted)) return wanted;
  const byDefault = sameLang.find(v => v.name === DEFAULT_VOICES[lang]);
  if (byDefault) return byDefault.name;
  return sameLang[0]?.name || '';
}

/**
 * Resuelve que voz narra cada idioma y avisa cuando la seleccion no cuadra
 * con el idioma declarado (ingles leido por voz espanola y viceversa).
 *
 * Devuelve { baseLang, voices:{en,es}, base, warnings[] }.
 */
export function resolveVoices(project, installed = []) {
  const language = normalizeLanguage(project?.language);
  const baseLang = baseLanguage(language);
  const warnings = [];

  const requested = String(project?.voice?.name || '').trim();
  const requestedEntry = installed.find(v => v.name === requested);
  const requestedLang = requestedEntry ? voiceLanguage(requestedEntry) : '';

  // La voz principal debe hablar el idioma base. Si no, se sustituye y se avisa.
  let basePreferred = requested;
  if (requested && requestedLang && requestedLang !== baseLang) {
    basePreferred = '';
    const replacement = pickVoice(baseLang, installed, project?.voice?.[baseLang]);
    if (replacement) {
      warnings.push(
        `El proyecto declara idioma "${language}" pero la voz seleccionada `
        + `(${requested}, ${requestedEntry.language}) es de otro idioma. `
        + `Se narra con ${replacement}.`,
      );
    } else {
      warnings.push(
        `El proyecto declara idioma "${language}" pero la voz seleccionada `
        + `(${requested}, ${requestedEntry.language}) es de otro idioma y no hay `
        + 'ninguna voz instalada del idioma declarado. Se narra con la seleccionada.',
      );
      basePreferred = requested;
    }
  }

  const voices = {
    es: pickVoice('es', installed, project?.voice?.es || (baseLang === 'es' ? basePreferred : '')),
    en: pickVoice('en', installed, project?.voice?.en || (baseLang === 'en' ? basePreferred : '')),
  };

  const base = voices[baseLang] || basePreferred || requested;
  return { language, baseLang, voices, base, warnings };
}

/**
 * Plan de narracion de un texto: tramos, voces y SSML cuando hace falta.
 * `ssml` es null si basta una sola voz (camino de texto plano de siempre).
 */
export function narrationPlan(text, project, installed = []) {
  const { baseLang, voices, base, warnings } = resolveVoices(project, installed);
  const segments = parseLangSegments(text, baseLang);
  const needsSsml = segments.some(s => (voices[s.lang] || base) !== base);
  return {
    baseLang,
    voices,
    base,
    segments,
    warnings,
    plain: stripLangTags(text),
    ssml: needsSsml ? buildSsml(segments, voices, { baseLang }) : null,
  };
}
