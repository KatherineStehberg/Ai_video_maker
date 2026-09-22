/**
 * LINEA DE TIEMPO: de que se compone el video, segundo a segundo.
 *
 * Aqui se calcula lo que la interfaz dibuja: los bloques de cada escena, las
 * transiciones entre ellas, y las pistas de musica y efectos con su volumen y
 * su licencia. La interfaz solo pinta; las decisiones estan aqui, donde se
 * pueden probar sin navegador.
 *
 * DOS REGLAS QUE NO SE NEGOCIAN
 *
 * 1. Las escenas EXCLUIDAS no ocupan tiempo. Aparecen marcadas, pero no
 *    desplazan a las demas: la linea de tiempo tiene que decir exactamente lo
 *    mismo que el MP4.
 * 2. NO HAY ONDAS FALSAS. Un bloque solo trae onda si existe el audio real; si
 *    no, trae `onda: null` y el motivo. Dibujar una onda decorativa sobre una
 *    pista que no suena es mentir sobre el contenido del video.
 *
 * Modulo puro: sin disco y sin FFmpeg.
 */

import { transicionesDe, porId as transicionPorId } from './transitions.js';
import { planDeMezcla, normalizarAudio, momentoDeEfecto } from './audio.js';

/** Un bloque por escena incluida, con el segundo en que empieza y acaba. */
export function bloquesDeEscena(project) {
  let t = 0;
  return (project?.scenes || []).map((s, i) => {
    const dur = Number(s.duration) || 0;
    const start = t;
    if (!s.excluida) t += dur;
    return {
      id: s.id,
      numero: i + 1,
      start: Number(start.toFixed(3)),
      end: Number((start + (s.excluida ? 0 : dur)).toFixed(3)),
      duration: Number(dur.toFixed(3)),
      excluida: Boolean(s.excluida),
    };
  });
}

/**
 * Bloques de transicion, situados en la FRONTERA entre dos escenas.
 *
 * La transicion no es un trozo de tiempo anadido: se solapa con el final de la
 * escena anterior y el principio de la siguiente. Por eso el bloque se dibuja
 * centrado en la frontera, mitad a cada lado.
 */
export function bloquesDeTransicion(project) {
  const escenas = bloquesDeEscena(project).filter(b => !b.excluida);
  return transicionesDe(project).map(t => {
    // `fromScene` es la posicion 1-based entre las escenas INCLUIDAS.
    const frontera = escenas[t.fromScene - 1]?.end ?? 0;
    const mitad = t.duration / 2;
    return {
      type: t.type,
      label: transicionPorId(t.type)?.label || t.type,
      duration: t.duration,
      fromScene: t.fromScene,
      toScene: t.toScene,
      fromSceneId: t.fromSceneId,
      toSceneId: t.toSceneId,
      enabled: true,
      frontera: Number(frontera.toFixed(3)),
      start: Number(Math.max(0, frontera - mitad).toFixed(3)),
      end: Number((frontera + mitad).toFixed(3)),
      motivo: t.motivo || null,
    };
  });
}

/**
 * Pista de musica: un bloque por repeticion cuando esta en bucle.
 *
 * Se necesita la duracion real del archivo para saber cuantas vueltas da. Si no
 * se conoce, se devuelve UN bloque que cubre el video y `repeticiones: null`,
 * en vez de inventar cortes donde no se sabe que los haya.
 */
export function pistaDeMusica(project, total, { duracionArchivo = null } = {}) {
  const { music } = normalizarAudio({ music: project?.music });
  if (!music.path) return null;

  const bloques = [];
  if (duracionArchivo > 0 && music.loop) {
    for (let t = 0; t < total; t += duracionArchivo) {
      bloques.push({ start: Number(t.toFixed(3)), end: Number(Math.min(total, t + duracionArchivo).toFixed(3)) });
    }
  } else {
    const fin = duracionArchivo > 0 ? Math.min(total, duracionArchivo) : total;
    bloques.push({ start: 0, end: Number(fin.toFixed(3)) });
  }

  return {
    path: music.path,
    titulo: music.credit?.titulo || music.path.split('/').pop(),
    activa: music.enabled,
    volumen: music.volume,
    loop: music.loop,
    fadeIn: music.fadeIn,
    fadeOut: music.fadeOut,
    // La licencia viene de la ficha que hay junto al archivo en disco. Sin
    // ficha, la pista NO deberia haberse podido elegir; si aparece una asi, se
    // marca para que la interfaz lo diga en vez de callarlo.
    licencia: music.credit?.licencia || null,
    credito: music.credit || null,
    sinLicencia: !music.credit?.licencia,
    repeticiones: duracionArchivo > 0 && music.loop ? bloques.length : null,
    bloques,
    // Sin analisis del archivo no hay onda; no se dibuja uno decorativo.
    onda: null,
  };
}

/** Pista de efectos: un bloque por efecto, en el segundo en que suena. */
export function pistaDeEfectos(project, total) {
  const { sfx } = normalizarAudio({ sfx: project?.sfx });
  const activas = (project?.scenes || []).filter(s => !s.excluida);

  return sfx.map(e => {
    const t = momentoDeEfecto(e, activas);
    const fuera = t === null || t >= total;
    return {
      id: e.id,
      path: e.path,
      titulo: e.titulo || e.path.split('/').pop(),
      sceneId: e.sceneId,
      start: t,
      // Sin duracion declarada suena entero; en la linea de tiempo se dibuja
      // con un ancho minimo para que el bloque se pueda ver y seleccionar.
      duration: e.duration,
      end: t === null ? null : Number((t + (e.duration || 0.4)).toFixed(3)),
      volumen: e.volume,
      activo: e.enabled && !fuera,
      licencia: e.credit?.licencia || null,
      credito: e.credit || null,
      sinLicencia: !e.credit?.licencia,
      motivo: t === null ? 'Su escena está excluida del montaje.'
        : t >= total ? 'Empieza después del final del video.'
          : !e.enabled ? 'Silenciado.' : null,
      onda: null,
    };
  });
}

/**
 * Linea de tiempo completa.
 *
 * `narracion` es la pista de voz ya montada, si existe; se pasa desde fuera
 * porque saber si un archivo esta en disco no es cosa de un modulo puro.
 */
export function lineaDeTiempo(project, { narracion = null, existe = () => true, duracionMusica = null } = {}) {
  const escenas = bloquesDeEscena(project);
  const total = Number(escenas.filter(e => !e.excluida).reduce((a, e) => a + e.duration, 0).toFixed(3));
  const plan = planDeMezcla(project, { narracion, existe });

  return {
    duracion: total,
    escenas,
    transiciones: bloquesDeTransicion(project),
    musica: pistaDeMusica(project, total, { duracionArchivo: duracionMusica }),
    efectos: pistaDeEfectos(project, total),
    // Lo que de verdad va a sonar en el MP4, para que la linea de tiempo y la
    // exportacion no puedan contar cosas distintas.
    mezcla: {
      pistas: plan.fuentes.length,
      hayAudio: plan.hayAudio,
      descartadas: plan.descartadas,
    },
  };
}
