/**
 * TEXTO DESTACADO SOBRE LA IMAGEN
 *
 * Es OTRA cosa que el subtitulo, y la diferencia es el motivo de este modulo:
 *
 *   SUBTITULO        toda la narracion, palabra por palabra, en todas las
 *                    escenas, sincronizado con la voz.
 *   TEXTO DESTACADO  dos a ocho palabras, en UNAS POCAS escenas, para fijar
 *                    una idea: el titulo, la pregunta de apertura, el nombre
 *                    de un concepto, una cifra o la llamada a la accion.
 *
 * Los dos pueden convivir en la misma escena: el destacado va arriba y el
 * subtitulo abajo, y `onScreenMetrics` garantiza que no se pisan.
 *
 * Modulo puro: sin disco, sin FFmpeg y sin DOM.
 */

import { clamp } from '../lib/util.js';
import { stripLangTags } from './lang.js';
import { fontSizeBase, captionBand, ZONA_SEGURA_SUPERIOR, ZONA_SEGURA_INFERIOR, aspectoDe } from './captions-style.js';

/** Un destacado que no se lee de un vistazo ya no es un destacado. */
export const PALABRAS_DESTACADO = { min: 2, max: 8 };

/** Tope duro de caracteres: lo que cabe en dos lineas grandes sin salirse. */
export const CARACTERES_DESTACADO_MAX = 60;

export const POSICIONES_DESTACADO = ['top', 'upper-third', 'center', 'lower-third', 'bottom'];
export const ANIMACIONES_DESTACADO = ['none', 'fade', 'slide-up', 'pop'];
export const TAMANOS_DESTACADO = ['small', 'medium', 'large', 'xlarge'];
export const FONDOS_DESTACADO = ['none', 'outline', 'box'];

/**
 * Multiplicadores sobre el tamano base de subtitulo del formato.
 *
 * El destacado SIEMPRE es mayor que el subtitulo (el menor es 1.1x): si midiera
 * lo mismo, el espectador no distinguiria uno de otro.
 */
export const FACTOR_TAMANO = { small: 1.1, medium: 1.45, large: 1.85, xlarge: 2.4 };

/** Roles del guion que justifican un texto destacado. */
export const ROLES_DESTACABLES = new Set(['hook', 'intro', 'section', 'cta', 'outro', 'offer']);

/** Cifras, porcentajes y cantidades: un dato concreto se recuerda mejor escrito. */
const CIFRA = /(\d+([.,]\d+)?\s*(%|por ciento|euros?|d[oó]lares?|pesos?|minutos?|horas?|d[ií]as?|semanas?|meses?|a[nñ]os?|veces))|(\b\d{2,}\b)/i;

/**
 * Palabras de funcion con las que NINGUN titular termina.
 *
 * Si un rotulo acaba en «pero», «que» o «de», no es un titulo: es una frase
 * cortada por la mitad. Es exactamente lo que producia el detector de titulos
 * con un guion narrativo («-Isan, entiendo que tenias el don de ver
 * enfermedades, pero»).
 */
const COLA_INCOMPLETA = /\b(y|o|u|e|ni|pero|sino|aunque|porque|pues|que|qui[eé]n|cual|como|cuando|donde|si|de|del|al|a|ante|bajo|con|contra|desde|en|entre|hacia|hasta|para|por|seg[uú]n|sin|sobre|tras|el|la|los|las|un|una|unos|unas|mi|tu|su|lo|le)$/i;

/** Verbos de habla: marcan narracion o acotacion, nunca un titular. */
const VERBO_DE_HABLA = /\b(dij[eo]|dijeron|dice|digo|cont[oó]|contest[oó]|respondi[oó]|pregunt[oó]|explic[oó]|a[ñn]adi[oó]|coment[oó]|exclam[oó]|susurr[oó]|grit[oó]|carraspe[oó]|replic[oó]|murmur[oó])\b/i;

/**
 * ¿Esto parece un trozo de narracion en vez de un titular?
 *
 * Un titulo de seccion es un buen texto destacado. Una muletilla de dialogo
 * («-Por ejemplo», «Me dijo», «-Te explico») no lo es, aunque el detector de
 * titulos la haya marcado como tal por ser corta y no acabar en punto.
 *
 * NO se filtra por numero de palabras: una sola palabra puede ser un rotulo
 * perfectamente valido (el nombre de un concepto, una palabra clave).
 */
export function pareceNarracion(texto) {
  const t = stripLangTags(texto).trim();
  if (!t) return true;
  // Raya o guion de dialogo al principio: es una intervencion, no un titulo.
  if (/^[-—–]/.test(t)) return true;
  if (VERBO_DE_HABLA.test(t)) return true;
  if (COLA_INCOMPLETA.test(t.replace(/[.,;:]+$/, ''))) return true;
  return false;
}

/**
 * ¿Sirve este texto como rotulo para esta narracion?
 *
 * Reune las tres condiciones en un solo sitio para que el segmentador, el
 * proponedor y la reparacion de proyectos viejos apliquen el MISMO criterio:
 *
 *   1. No puede estar vacio.
 *   2. No puede ser un trozo de narracion (dialogo, verbo de habla, frase
 *      cortada por la mitad).
 *   3. No puede venir de RECORTAR una frase larga. Un titulo de verdad ya es
 *      corto; si hubo que podarlo, era narracion disfrazada.
 *   4. No puede duplicar la narracion de la escena.
 */
export function esRotuloValido(titulo, narracion = '') {
  const crudo = stripLangTags(titulo).replace(/\s+/g, ' ').trim();
  if (!crudo) return false;
  if (pareceNarracion(crudo)) return false;
  // Contando sin la marca de lista, para no penalizar un «# Modulo 2».
  const palabras = crudo.replace(/^[#*•\s]+/, '').split(' ').filter(Boolean).length;
  if (palabras > PALABRAS_DESTACADO.max) return false;
  const corto = acortarDestacado(crudo);
  if (!corto || pareceNarracion(corto)) return false;
  return !duplicaNarracion(corto, narracion);
}

export function defaultOnScreenStyle() {
  return {
    size: 'large',
    color: '#ffffff',
    background: 'box',
    backgroundColor: '#000000',
    backgroundOpacity: 0.45,
    outlineColor: '#000000',
    bold: true,
  };
}

const hex = (value, fallback) => {
  const v = String(value ?? '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : fallback;
};

export function normalizeOnScreenStyle(input, previous = null) {
  const base = { ...defaultOnScreenStyle(), ...(previous || {}) };
  const s = input && typeof input === 'object' ? input : {};
  const tomar = (k) => (s[k] === undefined ? base[k] : s[k]);
  return {
    size: TAMANOS_DESTACADO.includes(tomar('size')) ? tomar('size') : base.size,
    color: hex(tomar('color'), base.color),
    background: FONDOS_DESTACADO.includes(tomar('background')) ? tomar('background') : base.background,
    backgroundColor: hex(tomar('backgroundColor'), base.backgroundColor),
    backgroundOpacity: clamp(Number(tomar('backgroundOpacity')) || 0, 0, 1),
    outlineColor: hex(tomar('outlineColor'), base.outlineColor),
    bold: Boolean(tomar('bold')),
  };
}

/**
 * Acorta un texto a `max` palabras SIN partir ninguna.
 *
 * Es lo que impide que el guion entero acabe escrito sobre la imagen: por muy
 * larga que sea la narracion, el destacado nunca pasa de ocho palabras.
 */
export function acortarDestacado(texto, max = PALABRAS_DESTACADO.max) {
  const limpio = stripLangTags(texto).replace(/\s+/g, ' ').trim()
    // Se quitan marcas de lista y almohadillas, pero NO la raya de dialogo:
    // es justo la senal que delata que esto era una intervencion y no un
    // titulo. `pareceNarracion` la necesita para poder rechazarlo.
    .replace(/^[#*•\s]+/, '')
    .replace(/[.,;:]+$/, '');
  if (!limpio) return '';
  const palabras = limpio.split(' ');
  let corto = palabras.length <= max ? limpio : palabras.slice(0, max).join(' ');
  if (corto.length > CARACTERES_DESTACADO_MAX) {
    corto = corto.slice(0, CARACTERES_DESTACADO_MAX).replace(/\s+\S*$/, '');
  }
  return corto.replace(/[.,;:]+$/, '').trim();
}

/**
 * ¿Este texto destacado estaria copiando la narracion?
 *
 * Copiar la narracion entera sobre la imagen es justo lo que NO se quiere: para
 * eso ya estan los subtitulos. Se admite que coincidan cuando la narracion es
 * en si misma un gancho de pocas palabras.
 */
export function duplicaNarracion(destacado, narracion) {
  const norm = t => stripLangTags(t).toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const d = norm(destacado);
  const n = norm(narracion);
  if (!d || !n) return false;
  const palabrasNarracion = n.split(' ').length;
  if (d === n) return palabrasNarracion > PALABRAS_DESTACADO.max;
  return d.split(' ').length > PALABRAS_DESTACADO.max;
}

/**
 * Campos de texto destacado de una escena, normalizados.
 *
 * COMPATIBILIDAD: un proyecto guardado antes de que existiera
 * `showOnScreenText` solo tiene `onScreenTitle`. Si trae texto, se entiende que
 * el destacado estaba activo; si no, que no lo estaba. Asi reabrir un proyecto
 * viejo no cambia lo que se ve.
 */
export function normalizeOnScreenText(partial = {}) {
  const titulo = acortarDestacado(partial.onScreenTitle ?? '');
  const declarado = partial.showOnScreenText;
  const activo = declarado === undefined || declarado === null
    ? Boolean(titulo)
    : Boolean(declarado) && Boolean(titulo);

  return {
    showOnScreenText: activo,
    onScreenTitle: titulo,
    onScreenPosition: POSICIONES_DESTACADO.includes(partial.onScreenPosition) ? partial.onScreenPosition : 'upper-third',
    onScreenStyle: normalizeOnScreenStyle(partial.onScreenStyle),
    onScreenAnimation: ANIMACIONES_DESTACADO.includes(partial.onScreenAnimation) ? partial.onScreenAnimation : 'fade',
  };
}

/**
 * Geometria del texto destacado en un encuadre concreto, respetando las zonas
 * seguras Y la banda que ocupan los subtitulos.
 *
 * `y` es la coordenada del borde SUPERIOR del texto, en pixeles reales.
 */
export function onScreenMetrics(width, height, {
  text = '', position = 'upper-third', style = {}, captionStyle = null, captionsEnabled = true,
} = {}) {
  const s = normalizeOnScreenStyle(style);
  const aspecto = aspectoDe(width, height);
  const safeTop = Math.round(height * (ZONA_SEGURA_SUPERIOR[aspecto] ?? 0.08));
  const safeBottom = height - Math.round(height * (ZONA_SEGURA_INFERIOR[aspecto] ?? 0.12));

  const pedido = Math.round(fontSizeBase(width, height) * (FACTOR_TAMANO[s.size] ?? FACTOR_TAMANO.large));

  // El texto se reparte en como mucho dos lineas y se encoge lo justo para que
  // la mas larga quepa en el 85 % del ancho. Sin esto, un destacado largo se
  // sale por los dos lados (x=(w-text_w)/2 se vuelve negativo).
  const limpio = stripLangTags(text).replace(/\s+/g, ' ').trim();
  const lineas = repartirEnDosLineas(limpio);
  const masLarga = Math.max(1, ...lineas.map(l => l.length));
  const anchoUtil = width * 0.85;
  const cabe = Math.floor(anchoUtil / (masLarga * 0.52));
  const fontSize = Math.round(clamp(Math.min(pedido, cabe), Math.round(fontSizeBase(width, height) * 0.9), pedido));

  const relleno = s.background === 'box' ? Math.round(fontSize / 3) : 0;
  const blockHeight = Math.round(fontSize * 1.18 * lineas.length + relleno * 2);

  // Banda prohibida: donde van los subtitulos cuando estan activos.
  const banda = captionsEnabled ? captionBand(width, height, captionStyle || {}) : null;
  const holgura = Math.round(height * 0.02);

  let y;
  if (position === 'top') y = safeTop;
  else if (position === 'upper-third') y = Math.round(height * 0.16);
  else if (position === 'center') y = Math.round(height / 2 - blockHeight / 2);
  else if (position === 'lower-third') y = Math.round(height * 0.62);
  else y = safeBottom - blockHeight;

  // 1. Dentro de las zonas seguras.
  y = clamp(y, safeTop, Math.max(safeTop, safeBottom - blockHeight));

  // 2. Fuera de la banda de subtitulos. Se sube por encima; si arriba no queda
  //    sitio, se baja por debajo; si tampoco, manda la zona segura y se declara
  //    el solape para que la interfaz pueda avisar.
  let solapa = false;
  if (banda && y < banda.y1 && y + blockHeight > banda.y0) {
    const arriba = banda.y0 - holgura - blockHeight;
    const abajo = banda.y1 + holgura;
    if (arriba >= safeTop) y = arriba;
    else if (abajo + blockHeight <= safeBottom) y = abajo;
    else { y = safeTop; solapa = true; }
  }

  return {
    fontSize, lineas, blockHeight, y,
    x: 'center',
    safeTop, safeBottom,
    captionBand: banda,
    solapaConSubtitulos: solapa,
    style: s,
  };
}

/** Parte un destacado corto en una o dos lineas equilibradas, sin cortar palabras. */
export function repartirEnDosLineas(texto) {
  const t = String(texto || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const palabras = t.split(' ');
  if (palabras.length <= 3 && t.length <= 24) return [t];

  // Punto de corte mas cercano a la mitad en numero de caracteres.
  let mejor = 1, distancia = Infinity;
  for (let i = 1; i < palabras.length; i++) {
    const a = palabras.slice(0, i).join(' ').length;
    const b = palabras.slice(i).join(' ').length;
    const d = Math.abs(a - b);
    if (d < distancia) { distancia = d; mejor = i; }
  }
  const a = palabras.slice(0, mejor).join(' ');
  const b = palabras.slice(mejor).join(' ');
  // Una sola linea si ya era corta: dos lineas de tres letras se ven peor.
  return t.length <= 26 ? [t] : [a, b];
}

/**
 * Decide en QUE escenas tiene sentido un texto destacado.
 *
 * Reglas, en este orden:
 *   1. La portada o gancho (primera escena) SIEMPRE lo lleva.
 *   2. El cierre o llamada a la accion (ultima escena, o rol cta) tambien.
 *   3. El comienzo de cada seccion lo lleva, con el nombre de la seccion.
 *   4. Una escena con una cifra concreta es candidata.
 *   5. Nunca dos escenas seguidas, y nunca mas de `maxProporcion` del video.
 *
 * Devuelve indices, no escenas: quien llama decide que hacer con ellos.
 */
export function escenasDestacables(escenas, { maxProporcion = 0.35, minSeparacion = 2 } = {}) {
  const lista = Array.isArray(escenas) ? escenas : [];
  if (!lista.length) return [];

  const candidatos = [];
  lista.forEach((e, i) => {
    const rol = String(e?.role || '').toLowerCase();
    const primera = i === 0;
    const ultima = i === lista.length - 1;
    const abreSeccion = Boolean(e?.abreSeccion) || rol === 'section';
    const tieneCifra = CIFRA.test(stripLangTags(e?.text ?? ''));

    let prioridad = null;
    if (primera) prioridad = 0;                       // portada / gancho
    else if (ultima || rol === 'cta') prioridad = 1;  // cierre / llamada a la accion
    else if (abreSeccion) prioridad = 2;              // inicio de seccion
    else if (ROLES_DESTACABLES.has(rol)) prioridad = 3;
    else if (tieneCifra) prioridad = 4;               // dato importante

    if (prioridad !== null) candidatos.push({ i, prioridad });
  });

  // Tope: en un video largo no se destaca una escena de cada dos.
  const tope = Math.max(2, Math.round(lista.length * maxProporcion));
  const elegidos = [];
  for (const c of candidatos.sort((a, b) => a.prioridad - b.prioridad || a.i - b.i)) {
    if (elegidos.length >= tope) break;
    // Ni dos seguidas ni demasiado juntas: el destacado pierde fuerza.
    if (elegidos.some(i => Math.abs(i - c.i) < minSeparacion)) continue;
    elegidos.push(c.i);
  }
  return elegidos.sort((a, b) => a - b);
}

/**
 * Propone textos destacados sobre una lista de escenas del borrador.
 *
 * NO toca la narracion: solo activa `showOnScreenText` y escribe un
 * `onScreenTitle` breve en las escenas elegidas, y lo APAGA en las demas. El
 * resultado es una propuesta: la usuaria puede aceptarla, editarla, anadir o
 * quitar antes de renderizar.
 */
export function proponerTextosDestacados(escenas, { tema = '', titulo = '', respetarManual = true } = {}) {
  const lista = (Array.isArray(escenas) ? escenas : []).map(e => ({ ...e }));
  if (!lista.length) return lista;

  const elegidos = new Set(escenasDestacables(lista));

  return lista.map((e, i) => {
    // Lo que la usuaria escribio a mano manda sobre cualquier propuesta.
    if (respetarManual && e.onScreenTextManual) return e;

    if (!elegidos.has(i)) {
      // Se conserva el texto escrito, pero apagado: quitar el destacado no
      // puede borrar lo que alguien redacto.
      return { ...e, showOnScreenText: false };
    }

    const propuesto = acortarDestacado(
      e.onScreenTitle
      || (e.seccion && i !== 0 ? e.seccion : '')
      || (i === 0 ? (titulo || tema || e.text) : e.text),
    );
    if (!esRotuloValido(propuesto, e.text)) {
      return { ...e, showOnScreenText: false };
    }
    return {
      ...e,
      showOnScreenText: true,
      onScreenTitle: propuesto,
      onScreenPosition: e.onScreenPosition || 'upper-third',
      onScreenAnimation: e.onScreenAnimation || 'fade',
    };
  });
}

/** Resumen para la interfaz: cuantas escenas llevan destacado y cuales. */
export function resumenDestacados(escenas) {
  const lista = Array.isArray(escenas) ? escenas : [];
  const con = lista
    .map((e, i) => ({ i, activo: Boolean(e?.showOnScreenText && String(e?.onScreenTitle || '').trim()) }))
    .filter(e => e.activo)
    .map(e => e.i);
  return {
    total: lista.length,
    conDestacado: con.length,
    sinDestacado: lista.length - con.length,
    indices: con,
    proporcion: lista.length ? Number((con.length / lista.length).toFixed(3)) : 0,
  };
}
