import { listAllVoices, resolveProvider } from '../providers/tts/index.js';

/**
 * Selección de voz para narrar en español.
 *
 * Narrar español con una voz inglesa (la Zira que trae Windows por defecto)
 * suena mal y se entiende peor. Aquí se busca una voz española entre las
 * instaladas y, si no hay ninguna, se AVISA de forma explícita en lugar de
 * usar la inglesa en silencio.
 */

/**
 * Prioridad por región. Español de Chile primero, luego el resto de América
 * Latina, luego España y por último cualquier variante de español.
 */
const PRIORIDAD = [
  { test: /^es-CL/i, puntos: 100, etiqueta: 'español de Chile' },
  { test: /^es-(419|MX|AR|CO|PE|UY|EC|BO|PY|VE|CR|GT)/i, puntos: 80, etiqueta: 'español latinoamericano' },
  { test: /^es-US/i, puntos: 70, etiqueta: 'español (EE. UU.)' },
  { test: /^es-ES/i, puntos: 50, etiqueta: 'español de España' },
  { test: /^es/i, puntos: 40, etiqueta: 'español' },
];

/** Puntúa una voz; 0 significa que no es española. */
export function puntuarVoz(voz) {
  const idioma = String(voz?.language || voz?.locale || '').trim();
  const nombre = String(voz?.name || voz?.id || '');
  for (const p of PRIORIDAD) {
    if (p.test.test(idioma)) return { puntos: p.puntos, etiqueta: p.etiqueta, esEspanol: true };
  }
  // Algunos modelos de Piper no declaran cultura, pero sí la llevan en el
  // nombre del archivo (es_CL-..., es_ES-...).
  if (/(^|[_\-\b])es[_\-]/i.test(nombre)) {
    const region = /es[_-](CL)/i.test(nombre) ? 100 : /es[_-](419|MX|AR|CO|PE)/i.test(nombre) ? 80 : 45;
    return { puntos: region, etiqueta: 'español (detectado por el nombre del modelo)', esEspanol: true };
  }
  return { puntos: 0, etiqueta: idioma || 'idioma desconocido', esEspanol: false };
}

/**
 * Elige la mejor voz española entre las disponibles.
 * Devuelve siempre un diagnóstico utilizable por la interfaz.
 */
export function elegirVoz(voces = []) {
  const puntuadas = voces
    .map(v => ({ voz: v, ...puntuarVoz(v) }))
    .sort((a, b) => b.puntos - a.puntos);

  const espanolas = puntuadas.filter(v => v.esEspanol);
  if (espanolas.length) {
    const mejor = espanolas[0];
    return {
      voz: mejor.voz, nombre: mejor.voz.name || mejor.voz.id,
      provider: mejor.voz.provider, etiqueta: mejor.etiqueta,
      esEspanol: true, aviso: null,
      alternativas: espanolas.slice(1).map(v => v.voz.name || v.voz.id),
    };
  }

  const cualquiera = puntuadas[0];
  if (!cualquiera) {
    return { voz: null, nombre: null, provider: null, esEspanol: false,
      aviso: 'No hay ninguna voz de síntesis instalada: el video se montará sin narración.',
      alternativas: [] };
  }

  const nombre = cualquiera.voz.name || cualquiera.voz.id;
  return {
    voz: cualquiera.voz, nombre, provider: cualquiera.voz.provider,
    etiqueta: cualquiera.etiqueta, esEspanol: false,
    aviso: `No hay ninguna voz en español instalada. Se usará «${nombre}» (${cualquiera.etiqueta}), ` +
      'que pronunciará el español con acento extranjero. Para arreglarlo: Configuración → Hora e idioma → ' +
      'Idioma y voz → añadir español, o instala Piper con un modelo es_CL/es_419 (PIPER_PATH y PIPER_MODEL en .env).',
    alternativas: [],
  };
}

/** Busca la voz disponible ahora mismo en este equipo. */
export async function vozDisponible() {
  const motor = await resolveProvider('auto');
  if (motor.id === 'none') {
    return { voz: null, nombre: null, provider: 'none', esEspanol: false,
      aviso: 'No hay motor de voz disponible: el video se montará sin narración.', alternativas: [] };
  }
  let voces = [];
  try { voces = await listAllVoices(); } catch { voces = []; }
  return { ...elegirVoz(voces), motor: motor.id };
}
