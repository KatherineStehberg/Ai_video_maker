/**
 * ESTILO Y GEOMETRIA DE LOS SUBTITULOS
 *
 * Aqui vive TODO lo que decide como se ve un subtitulo: cuanto mide la letra,
 * donde se apoya, cuantas lineas caben y cuantos caracteres entran en cada una.
 * El renderer y el generador de .ass importan de aqui; ninguno calcula tamanos
 * por su cuenta.
 *
 * Modulo puro: sin disco, sin FFmpeg y sin DOM. Se puede probar entero.
 *
 * ----------------------------------------------------------------------------
 * POR QUE UNA TABLA Y NO UNA FORMULA GEOMETRICA
 *
 * No existe un factor unico que sirva para los cuatro formatos. Un 9:16 se ve
 * en un telefono con el brazo estirado y necesita letra grande; un 16:9 se ve
 * en una pantalla mayor y mas lejos, y la misma proporcion resultaria enorme.
 * Son decisiones de plataforma, no de geometria.
 *
 * Asi que se fijan los DOS extremos medidos (9:16 y 16:9) y los formatos
 * intermedios se interpolan linealmente sobre la relacion ancho/alto. El
 * resultado reproduce exactamente los extremos y da un tamano coherente para
 * 1:1 y 4:5, que se ven en el mismo telefono que el vertical pero con menos
 * altura disponible.
 */

import { clamp } from '../lib/util.js';

/** Anclas medidas: tamano de letra sobre la dimension MENOR del encuadre. */
const ANCLAS = [
  // 9:16 -> 1080x1920, 64 px sobre 1080 de lado menor.
  { ratio: 9 / 16, k: 64 / 1080 },
  // 16:9 -> 1920x1080, 48 px sobre 1080 de lado menor.
  { ratio: 16 / 9, k: 48 / 1080 },
];

/**
 * Banda inferior que NO se puede ocupar, como fraccion de la altura.
 *
 * En vertical es la mas ancha a proposito: TikTok e Instagram dibujan encima el
 * nombre de la cuenta, la descripcion, la musica y la barra de progreso. Un
 * subtitulo que caiga ahi queda tapado en el telefono aunque se vea bien en el
 * MP4.
 */
export const ZONA_SEGURA_INFERIOR = {
  '9:16': 0.18,
  '4:5': 0.14,
  '1:1': 0.12,
  '16:9': 0.10,
};

/** Banda superior reservada (logo, reloj del sistema, cabeceras de la app). */
export const ZONA_SEGURA_SUPERIOR = {
  '9:16': 0.12,
  '4:5': 0.10,
  '1:1': 0.08,
  '16:9': 0.08,
};

/** Ancho maximo del bloque de texto, como fraccion del ancho del encuadre. */
export const ANCHO_MAXIMO = 0.85;

/** Nunca mas de dos lineas simultaneas: es lo que se lee de un vistazo. */
export const MAX_LINEAS = 2;

/**
 * Avance medio de un glifo en una sans-serif negrita, en "em".
 * Se usa para estimar cuantos caracteres caben en una linea sin medir la
 * fuente real. Es conservador: prefiere una linea corta a una que se salga.
 */
const AVANCE_POR_CARACTER = 0.5;

/** Limite de lectura comoda por linea, aunque el ancho permita mas. */
const CARACTERES_MAX = 42;
const CARACTERES_MIN = 16;

/** Tipografias ofrecidas en la interfaz. Todas existen en una instalacion base. */
export const TIPOGRAFIAS = [
  { id: 'Arial', label: 'Arial · neutra' },
  { id: 'Verdana', label: 'Verdana · muy legible en pantalla' },
  { id: 'Tahoma', label: 'Tahoma · compacta' },
  { id: 'Segoe UI', label: 'Segoe UI · interfaz de Windows' },
  { id: 'Georgia', label: 'Georgia · con serifa' },
  { id: 'Impact', label: 'Impact · titular' },
];

export const POSICIONES = ['bottom', 'center', 'top'];
export const ALINEACIONES = ['center', 'left', 'right'];
export const FONDOS = ['outline', 'box', 'none'];

/**
 * PRESETS.
 *
 * `fontScale` multiplica el tamano calculado para el formato, asi que un preset
 * sigue adaptandose a 9:16, 16:9, 1:1 y 4:5 en lugar de fijar pixeles.
 */
export const PRESETS = {
  'redes-sociales': {
    id: 'redes-sociales',
    label: 'Redes sociales',
    description: 'Letra grande con contorno grueso, apoyada por encima de los controles de TikTok e Instagram.',
    style: {
      fontFamily: 'Arial', fontScale: 1, bold: true,
      color: '#ffffff', outlineColor: '#000000', outlineScale: 1.15,
      background: 'outline', backgroundColor: '#000000', backgroundOpacity: 0,
      position: 'bottom', alignment: 'center', maxLines: 2, maxWidthPct: 0.85,
    },
  },
  curso: {
    id: 'curso',
    label: 'Curso',
    description: 'Caja oscura semitransparente: se lee sobre diapositivas y capturas de pantalla claras.',
    style: {
      fontFamily: 'Verdana', fontScale: 0.92, bold: false,
      color: '#ffffff', outlineColor: '#000000', outlineScale: 0.6,
      background: 'box', backgroundColor: '#101820', backgroundOpacity: 0.7,
      position: 'bottom', alignment: 'center', maxLines: 2, maxWidthPct: 0.82,
    },
  },
  limpio: {
    id: 'limpio',
    label: 'Limpio',
    description: 'Contorno fino y letra algo menor: molesta poco cuando la imagen es lo importante.',
    style: {
      fontFamily: 'Segoe UI', fontScale: 0.92, bold: false,
      color: '#ffffff', outlineColor: '#000000', outlineScale: 0.7,
      background: 'outline', backgroundColor: '#000000', backgroundOpacity: 0,
      position: 'bottom', alignment: 'center', maxLines: 2, maxWidthPct: 0.8,
    },
  },
  'alto-contraste': {
    id: 'alto-contraste',
    label: 'Alto contraste',
    description: 'Caja negra opaca y amarillo sobre negro. Pensado para baja vision y pantallas al sol.',
    style: {
      fontFamily: 'Verdana', fontScale: 1.05, bold: true,
      color: '#ffe600', outlineColor: '#000000', outlineScale: 1.3,
      background: 'box', backgroundColor: '#000000', backgroundOpacity: 0.95,
      position: 'bottom', alignment: 'center', maxLines: 2, maxWidthPct: 0.88,
    },
  },
};

export const PRESET_POR_DEFECTO = 'redes-sociales';

/** Estilo base: el preset por defecto, mas los campos que el usuario puede fijar. */
export function defaultCaptionStyle() {
  return {
    preset: PRESET_POR_DEFECTO,
    ...PRESETS[PRESET_POR_DEFECTO].style,
    // `null` significa «calculalo para este formato». Un numero lo fija en pixeles.
    fontSize: null,
    outlineWidth: null,
    marginVPct: null,
  };
}

const hex = (value, fallback) => {
  const v = String(value ?? '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : fallback;
};

const numeroONulo = (value, min, max) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? clamp(n, min, max) : null;
};

/**
 * Normaliza el estilo que llega de la interfaz, del disco o de la API.
 *
 * Aplicar un preset es pasar `preset` con un id distinto al guardado: entonces
 * manda el preset y lo demas se descarta. Mientras el preset no cambie, los
 * campos sueltos mandan sobre el, que es lo que permite retocar un preset sin
 * perder el retoque al recargar.
 */
export function normalizeCaptionStyle(input = {}, previous = null) {
  const entrada = input && typeof input === 'object' ? input : {};
  const base = previous ? { ...defaultCaptionStyle(), ...previous } : defaultCaptionStyle();
  const pedido = String(entrada.preset ?? base.preset ?? PRESET_POR_DEFECTO);
  const preset = PRESETS[pedido] ? pedido : (PRESETS[base.preset] ? base.preset : PRESET_POR_DEFECTO);

  // Cambio de preset: se parte de sus valores, no de los anteriores.
  const partida = preset !== base.preset
    ? { ...defaultCaptionStyle(), ...PRESETS[preset].style, preset }
    : base;

  const tomar = (clave, valorPorDefecto) => (entrada[clave] === undefined ? (partida[clave] ?? valorPorDefecto) : entrada[clave]);

  const fontFamily = String(tomar('fontFamily', 'Arial')).slice(0, 60) || 'Arial';
  const background = FONDOS.includes(tomar('background')) ? tomar('background') : partida.background;
  const position = POSICIONES.includes(tomar('position')) ? tomar('position') : partida.position;
  const alignment = ALINEACIONES.includes(tomar('alignment')) ? tomar('alignment') : partida.alignment;

  return {
    preset,
    fontFamily,
    // El rango llega hasta 3x para no impedir un subtitulo enorme deliberado;
    // el calculo de caracteres por linea lo compensa solo.
    fontScale: clamp(Number(tomar('fontScale', 1)) || 1, 0.5, 3),
    fontSize: numeroONulo(tomar('fontSize', null), 8, 400),
    bold: Boolean(tomar('bold', true)),
    color: hex(tomar('color'), '#ffffff'),
    outlineColor: hex(tomar('outlineColor'), '#000000'),
    outlineScale: clamp(Number(tomar('outlineScale', 1)) ?? 1, 0, 3),
    outlineWidth: numeroONulo(tomar('outlineWidth', null), 0, 40),
    background,
    backgroundColor: hex(tomar('backgroundColor'), '#000000'),
    backgroundOpacity: clamp(Number(tomar('backgroundOpacity', 0)) || 0, 0, 1),
    position,
    alignment,
    maxLines: clamp(Math.round(Number(tomar('maxLines', MAX_LINEAS)) || MAX_LINEAS), 1, MAX_LINEAS),
    maxWidthPct: clamp(Number(tomar('maxWidthPct', ANCHO_MAXIMO)) || ANCHO_MAXIMO, 0.4, 0.95),
    marginVPct: numeroONulo(tomar('marginVPct', null), 0, 0.45),
  };
}

/** Relacion de aspecto "a:b" mas cercana a unas dimensiones concretas. */
export function aspectoDe(width, height) {
  const r = width / height;
  const candidatos = Object.keys(ZONA_SEGURA_INFERIOR);
  let mejor = candidatos[0];
  let distancia = Infinity;
  for (const id of candidatos) {
    const [a, b] = id.split(':').map(Number);
    const d = Math.abs(a / b - r);
    if (d < distancia) { distancia = d; mejor = id; }
  }
  return mejor;
}

/** Tamano de letra base, en pixeles reales, para un encuadre concreto. */
export function fontSizeBase(width, height) {
  const r = width / height;
  const [a, b] = ANCLAS;
  // Interpolacion lineal entre las dos anclas, extendida fuera del tramo.
  const t = (r - a.ratio) / (b.ratio - a.ratio);
  const k = a.k + t * (b.k - a.k);
  const menor = Math.min(width, height);
  // El recorte evita que un formato extremo produzca una letra absurda.
  return Math.round(clamp(k * menor, menor * 0.02, menor * 0.12));
}

/**
 * Metrica completa de los subtitulos para un encuadre y un estilo.
 *
 * Devuelve pixeles reales, listos para escribirse en un .ass cuyo PlayRes sea
 * el tamano del video. Nada de esto depende del formato de entrega.
 */
export function captionMetrics(width, height, style = {}) {
  const s = normalizeCaptionStyle(style);
  const aspecto = aspectoDe(width, height);

  const fontSize = s.fontSize ?? Math.round(fontSizeBase(width, height) * s.fontScale);

  const outlineWidth = s.outlineWidth ?? Math.max(
    s.background === 'box' ? 0 : 2,
    Math.round((fontSize / 11) * s.outlineScale),
  );

  const seguraInferior = ZONA_SEGURA_INFERIOR[aspecto] ?? 0.12;
  const seguraSuperior = ZONA_SEGURA_SUPERIOR[aspecto] ?? 0.08;

  // El margen vertical es la distancia desde el borde correspondiente. Nunca
  // baja de la zona segura: ese es el punto de tener zonas seguras.
  const minimo = s.position === 'top' ? seguraSuperior : seguraInferior;
  const marginV = Math.round(height * Math.max(s.marginVPct ?? minimo, minimo));

  const anchoUtil = width * s.maxWidthPct;
  const marginH = Math.round((width - anchoUtil) / 2);

  const maxCharsPerLine = Math.round(clamp(
    anchoUtil / (fontSize * AVANCE_POR_CARACTER),
    CARACTERES_MIN,
    CARACTERES_MAX,
  ));

  // Altura que ocupa el bloque de subtitulos, con su interlineado y su caja.
  const interlineado = 1.2;
  const relleno = s.background === 'box' ? Math.round(fontSize / 3) : outlineWidth;
  const blockHeight = Math.round(fontSize * interlineado * s.maxLines + relleno * 2);

  return {
    aspecto, width, height,
    fontSize, outlineWidth, marginV, marginH,
    maxCharsPerLine, maxLines: s.maxLines,
    blockHeight,
    safeBottom: Math.round(height * seguraInferior),
    safeTop: Math.round(height * seguraSuperior),
    style: s,
  };
}

/**
 * Banda vertical [y0, y1] que ocupan los subtitulos en este encuadre.
 *
 * La usa el texto destacado para no escribir encima: un texto destacado y un
 * subtitulo pueden convivir en la misma escena, pero no en el mismo sitio.
 */
export function captionBand(width, height, style = {}) {
  const m = captionMetrics(width, height, style);
  if (m.style.position === 'top') return { y0: m.marginV, y1: m.marginV + m.blockHeight };
  if (m.style.position === 'center') {
    const centro = Math.round(height / 2);
    return { y0: centro - Math.round(m.blockHeight / 2), y1: centro + Math.round(m.blockHeight / 2) };
  }
  return { y0: height - m.marginV - m.blockHeight, y1: height - m.marginV };
}

/** Vista para la interfaz: presets, tipografias y opciones, sin duplicar textos. */
export function captionStyleOptions() {
  return {
    // Cada preset viaja CON sus valores: la interfaz aplica el preset sin
    // tener que preguntar otra vez al backend, y sin duplicar la tabla.
    presets: Object.values(PRESETS).map(p => ({ id: p.id, label: p.label, description: p.description, style: { ...p.style } })),
    fonts: TIPOGRAFIAS,
    positions: POSICIONES,
    alignments: ALINEACIONES,
    backgrounds: FONDOS,
    maxLines: MAX_LINEAS,
    safeBottom: ZONA_SEGURA_INFERIOR,
    safeTop: ZONA_SEGURA_SUPERIOR,
  };
}
