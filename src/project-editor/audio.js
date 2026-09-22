/**
 * AUDIO DEL PROYECTO: narracion, musica, efectos y audio original.
 *
 * Aqui vive el MODELO y el PLAN DE MEZCLA; el grafo de FFmpeg lo construye el
 * renderer a partir de este plan. Separarlo permite probar la mezcla entera
 * (volumenes, silencios, fundidos, solapes) sin renderizar un solo frame.
 *
 * LAS CUATRO FUENTES
 *   narracion  una pista por escena, montada en narration.wav
 *   musica     una pista de fondo que se repite hasta cubrir el video
 *   efectos    sonidos puntuales anclados a una escena o a un segundo
 *   original   el audio del video que subio la usuaria, si lo hay
 *
 * NADA SUENA SOLO. Un efecto solo existe si alguien lo eligio; este modulo no
 * anade sonidos por su cuenta.
 *
 * Modulo puro: sin disco y sin FFmpeg.
 */

/** Limites de volumen. Por encima de 1 se amplifica; el limitador evita saturar. */
export const VOLUMEN = { min: 0, max: 2 };

/** Volumen de referencia de cada fuente cuando no se dice otra cosa. */
export const VOLUMEN_POR_DEFECTO = { narracion: 1, musica: 0.12, efecto: 0.6, original: 0.8 };

/** Un efecto no puede durar mas que esto: es un sonido puntual, no una pista. */
export const EFECTO_MAX_SEGUNDOS = 30;

const num = (v, min, max, porDefecto) => {
  if (v === null || v === undefined || (typeof v === 'string' && !v.trim())) return porDefecto;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : porDefecto;
};

/**
 * Normaliza UN efecto de sonido.
 *
 * Un efecto se ancla a una escena (`sceneId`) y suena `start` segundos despues
 * del comienzo de esa escena. Sin escena, `start` cuenta desde el principio del
 * video. Asi un efecto sigue pegado a su escena aunque cambien las duraciones
 * de las anteriores.
 */
export function normalizarEfecto(e = {}) {
  return {
    id: String(e.id || '').trim() || `fx_${Math.random().toString(36).slice(2, 10)}`,
    path: e.path || null,
    sceneId: e.sceneId || null,
    start: num(e.start, 0, 86400, 0),
    volume: num(e.volume, VOLUMEN.min, VOLUMEN.max, VOLUMEN_POR_DEFECTO.efecto),
    // `null` = suena entero. Un numero lo recorta.
    duration: e.duration === null || e.duration === undefined ? null : num(e.duration, 0.05, EFECTO_MAX_SEGUNDOS, null),
    enabled: e.enabled !== false,
    credit: e.credit || null,
    titulo: e.titulo || null,
  };
}

/** Bloque de audio completo del proyecto, normalizado. */
export function normalizarAudio(partial = {}) {
  const m = partial.music || {};
  const o = partial.original || {};
  return {
    music: {
      path: m.path ?? null,
      enabled: m.enabled !== false && Boolean(m.path),
      volume: num(m.volume, VOLUMEN.min, VOLUMEN.max, VOLUMEN_POR_DEFECTO.musica),
      fadeIn: num(m.fadeIn, 0, 10, 1.5),
      fadeOut: num(m.fadeOut, 0, 10, 2),
      // La musica se repite hasta cubrir el video; se puede desactivar para que
      // suene una sola vez y despues quede silencio.
      loop: m.loop !== false,
      credit: m.credit ?? null,
    },
    sfx: (Array.isArray(partial.sfx) ? partial.sfx : []).map(normalizarEfecto).filter(e => e.path),
    original: {
      path: o.path ?? null,
      enabled: o.enabled === true && Boolean(o.path),
      volume: num(o.volume, VOLUMEN.min, VOLUMEN.max, VOLUMEN_POR_DEFECTO.original),
      // Segundo del video en el que empieza ese audio original.
      start: num(o.start, 0, 86400, 0),
    },
  };
}

/**
 * Instante ABSOLUTO en que suena un efecto, contando solo escenas incluidas.
 * Devuelve null si su escena esta excluida o ya no existe.
 */
export function momentoDeEfecto(efecto, escenasActivas) {
  if (!efecto.sceneId) return efecto.start;
  let t = 0;
  for (const s of escenasActivas) {
    if (s.id === efecto.sceneId) return Number((t + efecto.start).toFixed(3));
    t += Number(s.duration) || 0;
  }
  return null;
}

/**
 * PLAN DE MEZCLA: que fuentes suenan, con que volumen y en que segundo.
 *
 * Es lo que el renderer traduce a filtros, y lo que la interfaz usa para
 * dibujar las pistas. Una fuente silenciada o sin archivo NO entra en el plan:
 * asi el render sabe con certeza si hay algo que sonar o si toca exportar sin
 * pista de audio.
 *
 * @param {object} project
 * @param {object} opts.narracion  { path, existe } pista de voz ya montada
 * @param {function} opts.existe   comprueba si un archivo esta en disco
 */
export function planDeMezcla(project, { narracion = null, existe = () => true } = {}) {
  const audio = normalizarAudio(project?.audio || {
    music: project?.music, sfx: project?.sfx, original: project?.original ?? project?.originalAudio,
  });
  const activas = (project?.scenes || []).filter(s => !s.excluida);
  const total = Number(activas.reduce((a, s) => a + (Number(s.duration) || 0), 0).toFixed(3));
  const fuentes = [];
  const descartadas = [];

  // ---- narracion ----
  const vozActiva = project?.voice?.enabled !== false;
  const ganancia = num(project?.voice?.gain, VOLUMEN.min, VOLUMEN.max, VOLUMEN_POR_DEFECTO.narracion);
  if (narracion?.path && existe(narracion.path)) {
    if (!vozActiva) descartadas.push({ tipo: 'narracion', motivo: 'silenciada' });
    else if (ganancia <= 0) descartadas.push({ tipo: 'narracion', motivo: 'volumen a 0' });
    else fuentes.push({ tipo: 'narracion', path: narracion.path, volume: ganancia, start: 0, loop: false, recorte: total });
  } else {
    descartadas.push({ tipo: 'narracion', motivo: 'no hay voz generada' });
  }

  // ---- musica ----
  if (audio.music.path && existe(audio.music.path)) {
    if (!audio.music.enabled) descartadas.push({ tipo: 'musica', motivo: 'silenciada' });
    else if (audio.music.volume <= 0) descartadas.push({ tipo: 'musica', motivo: 'volumen a 0' });
    else {
      fuentes.push({
        tipo: 'musica', path: audio.music.path, volume: audio.music.volume, start: 0,
        loop: audio.music.loop, recorte: total,
        fadeIn: Math.min(audio.music.fadeIn, total / 2),
        fadeOut: Math.min(audio.music.fadeOut, total / 2),
      });
    }
  } else if (audio.music.path) {
    descartadas.push({ tipo: 'musica', motivo: 'el archivo ya no está' });
  }

  // ---- efectos ----
  for (const e of audio.sfx) {
    if (!existe(e.path)) { descartadas.push({ tipo: 'efecto', id: e.id, motivo: 'el archivo ya no está' }); continue; }
    if (!e.enabled) { descartadas.push({ tipo: 'efecto', id: e.id, motivo: 'silenciado' }); continue; }
    if (e.volume <= 0) { descartadas.push({ tipo: 'efecto', id: e.id, motivo: 'volumen a 0' }); continue; }
    const t = momentoDeEfecto(e, activas);
    if (t === null) { descartadas.push({ tipo: 'efecto', id: e.id, motivo: 'su escena está excluida' }); continue; }
    if (t >= total) { descartadas.push({ tipo: 'efecto', id: e.id, motivo: 'empieza después del final del video' }); continue; }
    fuentes.push({ tipo: 'efecto', id: e.id, path: e.path, volume: e.volume, start: t, loop: false, recorte: e.duration, titulo: e.titulo });
  }

  // ---- audio original del video subido ----
  if (audio.original.path && existe(audio.original.path)) {
    if (!audio.original.enabled) descartadas.push({ tipo: 'original', motivo: 'desactivado' });
    else if (audio.original.volume <= 0) descartadas.push({ tipo: 'original', motivo: 'volumen a 0' });
    else fuentes.push({ tipo: 'original', path: audio.original.path, volume: audio.original.volume, start: audio.original.start, loop: false, recorte: total });
  }

  return {
    total,
    fuentes,
    descartadas,
    // Si no hay ni una fuente, el video se exporta SIN pista de audio: no se
    // fabrica una pista de silencio para disimular.
    hayAudio: fuentes.length > 0,
    // Con varias fuentes la suma puede pasarse de 0 dBFS; el renderer pone un
    // limitador. Con una sola no hace falta tocar nada.
    necesitaLimitador: fuentes.length > 1 || fuentes.some(f => f.volume > 1),
  };
}

/** Resumen legible del plan, para la interfaz. */
export function resumenDeMezcla(plan) {
  const cuenta = tipo => plan.fuentes.filter(f => f.tipo === tipo).length;
  return {
    hayAudio: plan.hayAudio,
    narracion: cuenta('narracion') > 0,
    musica: cuenta('musica') > 0,
    efectos: cuenta('efecto'),
    original: cuenta('original') > 0,
    pistas: plan.fuentes.length,
    descartadas: plan.descartadas,
  };
}
