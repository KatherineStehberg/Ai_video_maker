import { splitSentences } from '../lib/util.js';
import { keywordsFrom } from '../core/script-generator.js';
import { acortarDestacado, esRotuloValido } from '../core/on-screen-text.js';
import {
  MAX_ESCENAS, TOLERANCIA_OBJETIVO, SCENE_TEXT_MAX, SCENE_DURATION_LIMITS,
} from './limits.js';

/*
 * Este módulo NO importa de `script.js` a propósito: `script.js` sí importa de
 * aquí, y un ciclo entre los dos haría que el orden de carga decidiera qué
 * función está definida. La dependencia va en un solo sentido.
 */

/**
 * Segmentación de un guion largo en escenas narrables.
 *
 * Un guion educativo de 12 minutos son ~1 400 palabras y unas 80 escenas. Este
 * módulo las construye SIN perder una sola palabra y sin partir ninguna frase:
 * es la garantía de la que dependen los subtítulos, la narración y la revisión
 * escena a escena.
 *
 * Jerarquía de corte, de más fuerte a más débil:
 *   1. TÍTULO      -> siempre empieza escena nueva y da el texto en pantalla.
 *   2. PÁRRAFO     -> siempre cierra la escena en curso (es una unidad de sentido).
 *   3. ORACIÓN     -> las oraciones se agrupan hasta llenar la escena.
 *   4. (nunca)     -> dentro de una oración NO se corta jamás. Una oración que
 *                     no cabe ocupa su propia escena, más larga de lo normal,
 *                     y se declara en `advertencias`.
 *
 * Todo aquí es puro: sin disco, sin red y sin estado. Se puede probar entero.
 */

/** Velocidad de narración por defecto, medida sobre el TTS local en español. */
export const WPM_POR_DEFECTO = Number(process.env.NARRATION_WPM) > 0
  ? Number(process.env.NARRATION_WPM)
  : 115;

/**
 * Silencio entre escenas. No es decorativo: el montaje deja respirar entre
 * clips, y sin contarlo la estimación se queda corta de forma acumulativa
 * (80 escenas × 0.35 s son 28 segundos de diferencia en un video de 12 min).
 */
export const PAUSA_ENTRE_ESCENAS = 0.35;

/** Segundos de narración que se buscan por escena en un video largo. */
export const SEGUNDOS_POR_ESCENA = { min: 4, objetivo: 9, max: 20 };

/** Cuenta palabras reales, sin contar espacios ni cadenas vacías. */
export const contarPalabras = texto =>
  String(texto || '').trim().split(/\s+/).filter(Boolean).length;

/** Segundos que tarda en narrarse un número de palabras a `wpm`. */
export const segundosDePalabras = (palabras, wpm = WPM_POR_DEFECTO) =>
  (Math.max(0, palabras) / Math.max(1, wpm)) * 60;

/**
 * ¿Esta línea es un título y no narración?
 *
 * Importa distinguirlo bien porque el pipeline ya usa `## ` para marcar la
 * narración de cada escena (ver `escenasAGuion`). La diferencia está en que un
 * título es corto y no termina en punto:
 *
 *   "## Módulo 2: el pretérito"                -> título
 *   "## Hoy veremos cómo se forma el pretérito." -> narración
 */
export function esTitulo(linea) {
  const t = String(linea || '').trim();
  if (!t) return false;

  const conAlmohadilla = /^#{1,6}\s+/.test(t);
  const cuerpo = t.replace(/^#{1,6}\s+/, '').replace(/^[-*•]\s+/, '').trim();
  if (!cuerpo) return false;

  // Una frase narrada termina en puntuación de cierre; un título, no.
  const terminaEnFrase = /[.!?…]$/.test(cuerpo);
  const corto = cuerpo.length <= 90 && contarPalabras(cuerpo) <= 14;

  if (conAlmohadilla) return corto && !terminaEnFrase;
  // Sin almohadilla: "MÓDULO 2" en mayúsculas, o "Objetivos de la clase:".
  if (!corto) return false;
  if (/:$/.test(cuerpo) && contarPalabras(cuerpo) <= 10) return true;
  const letras = cuerpo.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g, '');
  return letras.length >= 4 && letras === letras.toUpperCase() && !terminaEnFrase;
}

/** Acorta un título por palabras, nunca a mitad de una. */
export function tituloCorto(texto, max = 60) {
  const limpio = String(texto || '').replace(/\s+/g, ' ').trim().replace(/^[¿¡]/, '').replace(/[.?!]+$/, '');
  if (limpio.length <= max) return limpio.charAt(0).toUpperCase() + limpio.slice(1);
  const corto = limpio.slice(0, max).replace(/\s+\S*$/, '');
  return corto.charAt(0).toUpperCase() + corto.slice(1);
}

/** Quita la marca de título y deja el texto limpio. */
export const textoDelTitulo = linea =>
  String(linea || '').trim().replace(/^#{1,6}\s+/, '').replace(/^[-*•]\s+/, '').replace(/:$/, '').trim();

/**
 * Trocea el guion en bloques { titulo, parrafos[] }.
 *
 * Un bloque agrupa todo lo que cuelga de un título. Sin títulos, el guion
 * entero es un solo bloque y mandan los párrafos.
 */
export function bloquesDelGuion(texto) {
  const lineas = String(texto || '').replace(/\r\n?/g, '\n').split('\n');
  const bloques = [];
  let actual = { titulo: null, parrafos: [] };
  let parrafo = [];

  const cerrarParrafo = () => {
    if (parrafo.length) actual.parrafos.push(parrafo.join(' ').replace(/\s+/g, ' ').trim());
    parrafo = [];
  };
  const cerrarBloque = () => {
    cerrarParrafo();
    if (actual.titulo || actual.parrafos.length) bloques.push(actual);
    actual = { titulo: null, parrafos: [] };
  };

  for (const linea of lineas) {
    const t = linea.trim();
    if (!t) { cerrarParrafo(); continue; }
    if (esTitulo(t)) { cerrarBloque(); actual = { titulo: textoDelTitulo(t), parrafos: [] }; continue; }
    parrafo.push(t);
  }
  cerrarBloque();

  return bloques.filter(b => b.titulo || b.parrafos.length);
}

/**
 * Agrupa oraciones en escenas sin partir ninguna.
 *
 * Devuelve listas de oraciones. Una oración que por sí sola pasa del máximo
 * SIEMPRE sale en su propia escena: preferimos una escena larga a una frase
 * mutilada.
 */
export function agruparOraciones(oraciones, { palabrasObjetivo, palabrasMax }) {
  const grupos = [];
  let actual = [];
  let palabras = 0;

  for (const oracion of oraciones) {
    const n = contarPalabras(oracion);

    // La oración no cabe ni sola: va aparte, entera, sin tocarla.
    if (n > palabrasMax) {
      if (actual.length) { grupos.push(actual); actual = []; palabras = 0; }
      grupos.push([oracion]);
      continue;
    }

    // Añadirla pasaría del máximo duro: se cierra la escena en curso.
    if (actual.length && palabras + n > palabrasMax) {
      grupos.push(actual);
      actual = [oracion];
      palabras = n;
      continue;
    }

    actual.push(oracion);
    palabras += n;

    // Ya se alcanzó el objetivo: se cierra aquí, en un límite de oración.
    if (palabras >= palabrasObjetivo) { grupos.push(actual); actual = []; palabras = 0; }
  }

  if (actual.length) grupos.push(actual);
  return grupos;
}

/**
 * Split an abnormally long sentence only at punctuation that already exists.
 * If one clause is still too large, reject it instead of silently clamping its
 * duration later in the project model.
 */
export function normalizarOracionesLargas(oraciones, { palabrasMax, wpm = WPM_POR_DEFECTO } = {}) {
  const maxPorDuracion = Math.max(1, Math.floor((SCENE_DURATION_LIMITS.max * wpm) / 60));
  const limitePalabras = Math.min(palabrasMax || maxPorDuracion, maxPorDuracion);
  const salida = [];

  for (const oracion of oraciones) {
    const cabe = contarPalabras(oracion) <= limitePalabras && oracion.length <= SCENE_TEXT_MAX;
    if (cabe) { salida.push(oracion); continue; }

    const clausulas = String(oracion).match(/[^,;:—–]+(?:[,;:—–]+|$)/g)?.map(s => s.trim()).filter(Boolean) || [];
    if (clausulas.length < 2 || clausulas.some(c => contarPalabras(c) > limitePalabras || c.length > SCENE_TEXT_MAX)) {
      const palabras = contarPalabras(oracion);
      const segundos = segundosDePalabras(palabras, wpm);
      throw new Error(
        `Una oración tiene ${oracion.length} caracteres, ${palabras} palabras y duraría aproximadamente ` +
        `${segundos.toFixed(1)} s. El máximo por escena es ${SCENE_TEXT_MAX} caracteres y ` +
        `${SCENE_DURATION_LIMITS.max} s. Añade puntuación para dividirla en escenas; no se ha recortado nada.`,
      );
    }
    salida.push(...clausulas);
  }
  return salida;
}

/**
 * Decide si la apertura de seccion merece un rotulo, y cual.
 *
 * Un titulo de seccion es un buen destacado; una muletilla de dialogo no.
 * `acortarDestacado` lo limita a ocho palabras y `duplicaNarracion` descarta
 * lo que solo repetiria lo que ya dice el subtitulo.
 */
export function rotuloDeSeccion(cruda) {
  const apagado = { onScreenTitle: '', showOnScreenText: false };
  if (!cruda.abreSeccion || !cruda.seccion) return apagado;

  // Un trozo de dialogo no es un titulo aunque el detector lo marcara.
  if (!esRotuloValido(cruda.seccion, cruda.texto)) return apagado;
  return { onScreenTitle: acortarDestacado(tituloCorto(cruda.seccion, 60)), showOnScreenText: true };
}

/**
 * Convierte un guion completo en escenas.
 *
 * @param {string} texto        el guion tal cual lo escribió la usuaria
 * @param {object} opciones     { wpm, segundosPorEscena, tema }
 * @returns {{escenas: object[], palabras: number, advertencias: string[]}}
 */
export function segmentarGuion(texto, {
  wpm = WPM_POR_DEFECTO,
  segundosPorEscena = SEGUNDOS_POR_ESCENA,
  tema = '',
} = {}) {
  const advertencias = [];
  const palabrasObjetivo = Math.max(3, Math.round((segundosPorEscena.objetivo * wpm) / 60));
  const palabrasMax = Math.max(palabrasObjetivo + 2, Math.round((segundosPorEscena.max * wpm) / 60));

  const bloques = bloquesDelGuion(texto);
  const crudas = [];

  for (const bloque of bloques) {
    // Un título sin párrafos debajo es contenido narrable por sí mismo: no se
    // descarta nunca, porque descartarlo sería perder texto del guion.
    if (bloque.titulo && !bloque.parrafos.length) {
      crudas.push({ texto: bloque.titulo, seccion: bloque.titulo, abreSeccion: true });
      continue;
    }
    let primera = true;
    for (const parrafo of bloque.parrafos) {
      // El párrafo cierra escena: nunca se mezclan dos párrafos en una escena.
      const oraciones = normalizarOracionesLargas(splitSentences(parrafo), { palabrasMax, wpm });
      for (const grupo of agruparOraciones(oraciones, { palabrasObjetivo, palabrasMax })) {
        crudas.push({
          texto: grupo.join(' '),
          seccion: bloque.titulo,
          abreSeccion: primera && Boolean(bloque.titulo),
        });
        primera = false;
      }
    }
  }

  if (!crudas.length) return { escenas: [], palabras: 0, advertencias, secciones: 0 };

  const escenas = crudas.map((c, i) => {
    const palabras = contarPalabras(c.texto);
    const narracion = segundosDePalabras(palabras, wpm);
    const excede = narracion > segundosPorEscena.max;
    if (excede) {
      advertencias.push(
        `La escena ${i + 1} dura ${narracion.toFixed(1)} s porque contiene una frase que no cabe en ` +
        `${segundosPorEscena.max} s. Se ha dejado entera: divide la frase si prefieres una escena más corta.`,
      );
    }
    // Se acota sólo por abajo. Por arriba manda el texto: acortar aquí sería
    // hablar más rápido de lo humano o perder palabras.
    const duracion = Math.max(segundosPorEscena.min, narracion) + PAUSA_ENTRE_ESCENAS;

    return {
      role: c.abreSeccion ? 'section' : i === 0 ? 'intro' : i === crudas.length - 1 ? 'outro' : 'point',
      text: c.texto,
      // ROTULO. Solo en aperturas de seccion, y solo si el titulo de la
      // seccion da un destacado legitimo: breve y que no sea la narracion
      // copiada. Un guion narrativo con dialogos produce falsos titulos
      // («-Por ejemplo», «Me dijo»), y esos NO son rotulos.
      ...rotuloDeSeccion(c),
      abreSeccion: c.abreSeccion,
      // El tema va aparte, no pegado al texto: mezclarlos hacia que las
      // palabras del tema ganaran siempre y todas las escenas buscaran lo mismo.
      visualPrompt: keywordsFrom(c.texto, 3, { tema, contexto: crudas.filter((_, j) => j !== i).map(x => x.texto) }),
      duration: Number(duracion.toFixed(2)),
      seccion: c.seccion || null,
      palabras,
    };
  });

  if (escenas.length > MAX_ESCENAS) {
    throw new Error(
      `El guion produce ${escenas.length} escenas y el límite técnico es ${MAX_ESCENAS}. ` +
      'No se ha recortado nada: divide el guion en dos proyectos.',
    );
  }

  return {
    escenas,
    palabras: escenas.reduce((a, e) => a + e.palabras, 0),
    secciones: new Set(escenas.map(e => e.seccion).filter(Boolean)).size,
    advertencias,
  };
}

/**
 * Plan de duración de un guion, ANTES de producir nada.
 *
 * Es lo que la interfaz enseña en «duración estimada». Si hay una duración
 * objetivo y el guion no le cuadra, lo dice; no toca el guion.
 */
export function planificarDuracion(texto, {
  wpm = WPM_POR_DEFECTO,
  targetDurationSeconds = null,
  segundosPorEscena = SEGUNDOS_POR_ESCENA,
  tema = '',
} = {}) {
  const { escenas, palabras, secciones, advertencias } = segmentarGuion(texto, { wpm, segundosPorEscena, tema });
  const duracionEstimada = Number(escenas.reduce((a, e) => a + e.duration, 0).toFixed(2));
  const objetivo = targetDurationSeconds == null ? null : Number(targetDurationSeconds);

  const avisos = [...advertencias];
  let compatible = null;

  if (objetivo != null && Number.isFinite(objetivo) && objetivo > 0) {
    const desfase = duracionEstimada - objetivo;
    const margen = Math.max(TOLERANCIA_OBJETIVO.absoluta, objetivo * TOLERANCIA_OBJETIVO.relativa);
    compatible = Math.abs(desfase) <= margen;
    if (!compatible) {
      avisos.push(
        desfase > 0
          ? `El guion dura unos ${formatearDuracion(duracionEstimada)} narrado a ${wpm} palabras por minuto, ` +
            `pero pediste ${formatearDuracion(objetivo)}. No se ha quitado nada del guion: o subes la duración ` +
            'objetivo, o acortas el guion tú. Si dejas el objetivo, la voz se acelerará hasta donde suene natural ' +
            'y el video quedará más largo de lo pedido.'
          : `El guion sólo da para unos ${formatearDuracion(duracionEstimada)} y pediste ` +
            `${formatearDuracion(objetivo)}. No se ha inventado contenido de relleno: o bajas la duración ` +
            'objetivo, o alargas el guion.',
      );
    }
  }

  return {
    palabras,
    escenas: escenas.length,
    secciones,
    wpm,
    pausaEntreEscenas: PAUSA_ENTRE_ESCENAS,
    duracionEstimada,
    duracionEstimadaLegible: formatearDuracion(duracionEstimada),
    targetDurationSeconds: objetivo,
    compatibleConObjetivo: compatible,
    advertencias: avisos,
    plan: escenas,
  };
}

/** Segundos -> "12 min 30 s" / "45 s". Para mensajes de la interfaz. */
export function formatearDuracion(segundos) {
  const s = Math.round(Number(segundos) || 0);
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  const resto = s % 60;
  return resto ? `${min} min ${resto} s` : `${min} min`;
}

/**
 * Comprueba que la segmentación no perdió ni una palabra del guion original.
 *
 * Se cuentan juntos la narración y el texto en pantalla porque un TÍTULO del
 * guion no se narra: se muestra. Lo que garantiza esta función es que ninguna
 * palabra del original desaparece del video, no que todas se pronuncien.
 */
export function sinPerdidaDeTexto(original, escenas) {
  const norm = t => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const fuente = norm(original);
  const salida = norm(escenas.map(e => `${e.text} ${e.onScreenTitle || ''}`).join(' '));
  // Los títulos se repiten como texto en pantalla, así que la salida puede
  // tener MÁS palabras; lo que no puede es perder ninguna del original.
  const cuenta = new Map();
  for (const w of salida) cuenta.set(w, (cuenta.get(w) || 0) + 1);
  for (const w of fuente) {
    const n = cuenta.get(w) || 0;
    if (!n) return { ok: false, falta: w };
    cuenta.set(w, n - 1);
  }
  return { ok: true, falta: null };
}
