/**
 * Límites técnicos REALES del flujo de generación.
 *
 * Un límite aquí existe sólo por una de estas razones:
 *   a) más allá el equipo deja de responder (RAM, tiempo de render, disco), o
 *   b) la entrada es inequívocamente un error o un abuso.
 *
 * NO existen límites "de producto" que decidan por la usuaria cuán largo puede
 * ser su video. Un guion de una clase de 12 minutos es un caso de uso normal,
 * no un abuso, y pasa sin tocarlo. Cuando algo no cabe, se rechaza la petición
 * entera con un mensaje que dice el número exacto; NUNCA se recorta el guion en
 * silencio.
 */

/**
 * Prompt = la IDEA del video, no su guion. 20 000 caracteres es varias páginas
 * de brief: quien pega más que eso está pegando el guion, y para eso está
 * `script`, que admite veinte veces más.
 */
export const PROMPT_MAX = 20_000;

/**
 * Guion completo, en caracteres. 400 000 caracteres son ~65 000 palabras:
 * a 115 palabras por minuto de narración local, unas 9 horas de video. El
 * límite lo pone el render, no el texto.
 */
export const SCRIPT_MAX_CHARS = 400_000;

/** Un guion vacío no es un guion: se rechaza con un mensaje, no se rellena. */
export const SCRIPT_MIN_CHARS = 1;

/**
 * Escenas por proyecto. Cada escena es un clip MP4 intermedio en disco, así que
 * el techo lo marca el sistema de archivos y el tiempo de concat, no la RAM
 * (los clips se generan y se concatenan de uno en uno). 600 escenas a ~10 s son
 * más de una hora y media de video.
 */
export const MAX_ESCENAS = 600;

/** Narración por escena. Un párrafo largo cabe; una novela entera, no. */
export const SCENE_TEXT_MAX = 2_000;

/**
 * Duración de UNA escena. El mínimo evita clips de 0 frames; el máximo evita
 * que un fallo de segmentación produzca una sola escena de media hora sobre
 * una imagen fija.
 */
export const SCENE_DURATION_LIMITS = { min: 0.5, max: 120 };

/**
 * Duración OBJETIVO del video, cuando se indica una. Es opcional: lo normal es
 * `auto` y que mande el guion. 7 200 s = 2 horas.
 */
export const DURATION_LIMITS = { min: 3, max: 7_200 };

/**
 * Cuerpo HTTP de las rutas de generación. Tiene que caber el guion completo más
 * las escenas ya editadas, que repiten el texto: 8 MB deja margen de sobra.
 */
export const HTTP_BODY_MAX = 8 * 1024 * 1024;

/**
 * Desfase tolerado entre la duración estimada del guion y la duración objetivo
 * antes de avisar. Relativo, con un suelo absoluto para videos cortos.
 */
export const TOLERANCIA_OBJETIVO = { relativa: 0.15, absoluta: 5 };

/** Mensaje único para un guion que se pasa del límite técnico. */
export const mensajeGuionLargo = largo =>
  `El guion tiene ${largo.toLocaleString('es')} caracteres y el límite técnico de este equipo es ` +
  `${SCRIPT_MAX_CHARS.toLocaleString('es')}. No se ha recortado nada: divide el guion en dos proyectos ` +
  'y únelos al exportar.';

/** Mensaje único para un prompt que se pasa del límite técnico. */
export const mensajePromptLargo = largo =>
  `El prompt tiene ${largo.toLocaleString('es')} caracteres y el límite es ${PROMPT_MAX.toLocaleString('es')}. ` +
  'Si lo que estás pegando es el guion completo, mándalo en el campo «guion» en vez de en el prompt: ' +
  `ahí caben ${SCRIPT_MAX_CHARS.toLocaleString('es')} caracteres.`;
