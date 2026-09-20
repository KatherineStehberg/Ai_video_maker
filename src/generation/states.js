/**
 * Estados del flujo de generación y progreso REAL.
 *
 * El porcentaje que se publica sale siempre de algo contado: escenas
 * terminadas sobre escenas totales dentro de la etapa en curso. No hay
 * temporizadores ni animaciones que finjan avance mientras no pasa nada; si
 * una etapa tarda, el porcentaje se queda quieto, que es la verdad.
 */

/**
 * Etapas en el orden en que ocurren. `peso` es la fracción del total que
 * ocupa cada una, medida sobre proyectos largos reales: el render se lleva la
 * mitad del tiempo y la voz casi un tercio.
 */
export const ETAPAS = [
  { id: 'preparando-guion', label: 'Preparando el guion', peso: 0.03 },
  { id: 'creando-escenas', label: 'Creando las escenas', peso: 0.04 },
  { id: 'buscando-visuales', label: 'Buscando visuales', peso: 0.13 },
  { id: 'generando-voz', label: 'Generando la voz', peso: 0.27 },
  { id: 'creando-subtitulos', label: 'Creando subtítulos', peso: 0.05 },
  { id: 'renderizando-segmentos', label: 'Renderizando segmentos', peso: 0.40 },
  { id: 'concatenando', label: 'Uniendo los segmentos', peso: 0.08 },
];

/** Estados terminales. `error-recuperable` significa que se puede reanudar. */
export const ESTADO_LISTO = 'listo';
export const ESTADO_ERROR_RECUPERABLE = 'error-recuperable';
export const ESTADO_ERROR = 'error';
export const ESTADO_EN_COLA = 'en-cola';

export const ESTADOS = [
  ESTADO_EN_COLA,
  ...ETAPAS.map(e => e.id),
  ESTADO_LISTO,
  ESTADO_ERROR_RECUPERABLE,
  ESTADO_ERROR,
];

const indiceDe = id => ETAPAS.findIndex(e => e.id === id);

/** Fracción acumulada antes de que empiece la etapa `id`. */
export function baseDeEtapa(id) {
  const i = indiceDe(id);
  if (i < 0) return 0;
  return ETAPAS.slice(0, i).reduce((a, e) => a + e.peso, 0);
}

/**
 * Porcentaje global a partir de la etapa y de cuántas escenas lleva hechas.
 *
 * @param {string} etapa        id de la etapa en curso
 * @param {number} hechas       escenas terminadas en esta etapa
 * @param {number} totales      escenas totales del proyecto
 */
export function porcentaje(etapa, hechas = 0, totales = 0) {
  if (etapa === ESTADO_LISTO) return 100;
  if (etapa === ESTADO_EN_COLA) return 0;
  const i = indiceDe(etapa);
  if (i < 0) return 0;
  const dentro = totales > 0 ? Math.min(1, Math.max(0, hechas / totales)) : 0;
  return Number(((baseDeEtapa(etapa) + ETAPAS[i].peso * dentro) * 100).toFixed(1));
}

/**
 * Instantánea de progreso lista para la interfaz. Siempre lleva las cifras
 * crudas al lado del porcentaje, para que se pueda contrastar.
 */
export function instantanea({ etapa, hechas = 0, totales = 0, operacion = null, detalle = null } = {}) {
  const meta = ETAPAS.find(e => e.id === etapa);
  return {
    estado: etapa,
    etiqueta: meta?.label ?? (etapa === ESTADO_LISTO ? 'Listo'
      : etapa === ESTADO_ERROR_RECUPERABLE ? 'Error recuperable'
        : etapa === ESTADO_ERROR ? 'Error' : 'En cola'),
    escenasCompletadas: hechas,
    escenasTotales: totales,
    porcentaje: porcentaje(etapa, hechas, totales),
    operacion: operacion || meta?.label || null,
    detalle,
    actualizado: new Date().toISOString(),
  };
}

/** ¿Este estado permite reanudar sin rehacer lo ya producido? */
export const esReanudable = estado =>
  estado === ESTADO_ERROR_RECUPERABLE || (ETAPAS.some(e => e.id === estado));
