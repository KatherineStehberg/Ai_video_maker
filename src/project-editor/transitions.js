/**
 * TRANSICIONES ENTRE ESCENAS
 *
 * Una transicion pertenece a la escena de DESTINO: describe como ENTRA esa
 * escena desde la anterior. Por eso la primera escena nunca tiene transicion,
 * y por eso excluir una escena reindexa las transiciones solo: la que entra en
 * la siguiente pasa a venir de la anterior sin tocar nada.
 *
 *     escena 1      escena 2      escena 3
 *        |   \_ transicion 1-2 _/   |
 *                          \_ transicion 2-3 _/
 *
 * COMO SE RENDERIZAN, Y POR QUE NO SE ACORTA EL VIDEO
 *
 * El filtro `xfade` de FFmpeg SOLAPA dos clips: la salida dura la suma menos el
 * solape. Si no se compensara, cada transicion robaria tiempo al video y la voz
 * y los subtitulos, que se calculan sobre las duraciones planificadas,
 * quedarian desplazados.
 *
 * La compensacion es simple: el clip ANTERIOR se renderiza con `d` segundos de
 * mas (sigue su propio contenido), y el solape se come justo ese sobrante.
 *
 *     len(i)  = duracion planificada + d(i+1)
 *     offset  = suma de duraciones planificadas hasta i
 *     total   = suma de duraciones planificadas          <- no cambia
 *
 * Modulo puro: sin disco y sin FFmpeg. La lista de transiciones que ESTE
 * FFmpeg sabe hacer se consulta aparte (ver `filtrarDisponibles`).
 */

/** Limites de duracion de una transicion, en segundos. */
export const DURACION = { min: 0.1, max: 2, porDefecto: 0.5 };

/**
 * Fraccion de la escena mas corta que puede ocupar una transicion.
 *
 * Con mas de la mitad, una escena corta se pasaria casi entera mezclada con la
 * vecina y dejaria de leerse como escena propia.
 */
export const MAXIMO_POR_ESCENA = 0.5;

/**
 * Catalogo. `xfade` es el nombre EXACTO del filtro de FFmpeg; si este FFmpeg no
 * lo trae, la transicion se ofrece deshabilitada y etiquetada, nunca simulada.
 */
export const CATALOGO = [
  { id: 'none', label: 'Sin transición', xfade: null, descripcion: 'Corte seco entre escenas.' },
  { id: 'fade', label: 'Fundido', xfade: 'fade', descripcion: 'La escena anterior se funde con la siguiente.' },
  { id: 'dissolve', label: 'Disolver', xfade: 'dissolve', descripcion: 'Disolución granulada, más orgánica que el fundido.' },
  { id: 'slideleft', label: 'Deslizar desde la derecha', xfade: 'slideleft', descripcion: 'La escena nueva empuja a la anterior hacia la izquierda.' },
  { id: 'slideright', label: 'Deslizar desde la izquierda', xfade: 'slideright', descripcion: 'La escena nueva empuja a la anterior hacia la derecha.' },
  { id: 'slideup', label: 'Deslizar desde abajo', xfade: 'slideup', descripcion: 'La escena nueva empuja a la anterior hacia arriba.' },
  { id: 'slidedown', label: 'Deslizar desde arriba', xfade: 'slidedown', descripcion: 'La escena nueva empuja a la anterior hacia abajo.' },
  { id: 'wipeleft', label: 'Barrido horizontal', xfade: 'wipeleft', descripcion: 'Una línea vertical barre la imagen de un lado a otro.' },
  { id: 'wipeup', label: 'Barrido vertical', xfade: 'wipeup', descripcion: 'Una línea horizontal barre la imagen de abajo a arriba.' },
  { id: 'zoomin', label: 'Zoom suave', xfade: 'zoomin', descripcion: 'La escena nueva entra acercándose.' },
  { id: 'fadeblack', label: 'Fundido a negro', xfade: 'fadeblack', descripcion: 'Pasa por negro entre las dos escenas.' },
];

export const porId = id => CATALOGO.find(t => t.id === id) || null;

/**
 * Marca cada transicion del catalogo como disponible o no, segun lo que este
 * FFmpeg soporte de verdad.
 *
 * @param {string[]} soportadas  nombres de xfade que trae este FFmpeg
 */
export function filtrarDisponibles(soportadas = []) {
  const set = new Set(soportadas);
  return CATALOGO.map(t => ({
    ...t,
    disponible: t.xfade === null ? true : set.has(t.xfade),
    motivo: t.xfade === null || set.has(t.xfade) ? null : 'Este FFmpeg no trae esta transición.',
  }));
}

/** Normaliza lo que venga del disco o de la interfaz al contrato del proyecto. */
export function normalizarTransicion(valor) {
  // COMPATIBILIDAD: antes se guardaba una cadena ('none' | 'fade' | …).
  if (typeof valor === 'string') {
    const t = porId(valor) ? valor : (valor === 'none' ? 'none' : 'fade');
    return { type: t, duration: t === 'none' ? 0 : DURACION.porDefecto, enabled: t !== 'none' };
  }
  const v = valor && typeof valor === 'object' ? valor : {};
  const type = porId(v.type) ? v.type : 'none';
  const d = Number(v.duration);
  const duration = type === 'none' ? 0
    : Math.min(DURACION.max, Math.max(DURACION.min, Number.isFinite(d) ? d : DURACION.porDefecto));
  return { type, duration: Number(duration.toFixed(3)), enabled: type === 'none' ? false : v.enabled !== false };
}

/**
 * ¿Cabe esta transicion entre dos escenas?
 *
 * Devuelve la duracion ACOTADA y el motivo del recorte, en vez de rechazar sin
 * mas: es mas util recortar a lo que cabe y decirlo.
 */
export function validarTransicion(transicion, { duracionAnterior, duracionActual, esPrimera = false } = {}) {
  const t = normalizarTransicion(transicion);
  if (t.type === 'none' || !t.enabled) return { ok: true, transicion: { ...t, duration: 0, enabled: false }, motivo: null };
  if (esPrimera) {
    return { ok: false, transicion: { type: 'none', duration: 0, enabled: false },
      motivo: 'La primera escena no entra desde ninguna otra: no puede llevar transición.' };
  }
  const vecinaMasCorta = Math.min(Number(duracionAnterior) || 0, Number(duracionActual) || 0);
  const tope = Math.max(0, vecinaMasCorta * MAXIMO_POR_ESCENA);
  if (tope < DURACION.min) {
    return { ok: false, transicion: { type: 'none', duration: 0, enabled: false },
      motivo: `Las escenas vecinas son demasiado cortas (${vecinaMasCorta.toFixed(2)} s) para una transición.` };
  }
  if (t.duration > tope) {
    return { ok: true, transicion: { ...t, duration: Number(tope.toFixed(3)) },
      motivo: `La transición se acortó a ${tope.toFixed(2)} s: no puede ocupar más de la mitad de la escena más corta.` };
  }
  return { ok: true, transicion: t, motivo: null };
}

/**
 * Transiciones EFECTIVAS del proyecto, ya validadas y reindexadas sobre las
 * escenas incluidas.
 *
 * Las escenas excluidas no cuentan: si se excluye la escena 2, la transicion
 * que entraba en la 3 pasa a ir de la 1 a la 3 sin que nadie toque nada.
 */
export function transicionesDe(project) {
  const activas = (project?.scenes || []).filter(s => !s.excluida);
  const salida = [];
  for (let i = 1; i < activas.length; i++) {
    const anterior = activas[i - 1];
    const actual = activas[i];
    const { transicion, motivo } = validarTransicion(actual.transition, {
      duracionAnterior: anterior.duration,
      duracionActual: actual.duration,
      esPrimera: false,
    });
    if (transicion.type === 'none' || !transicion.enabled || transicion.duration <= 0) continue;
    salida.push({
      type: transicion.type,
      duration: transicion.duration,
      // Numeros de escena TAL Y COMO SE VEN en el montaje (1, 2, 3…), que es lo
      // que importa cuando hay escenas excluidas por medio.
      fromScene: i,          // posicion entre las activas (1 = primera)
      toScene: i + 1,
      fromSceneId: anterior.id,
      toSceneId: actual.id,
      enabled: true,
      motivo: motivo || null,
    });
  }
  return salida;
}

/**
 * Plan de montaje: cuanto dura cada clip y con que transicion se enlaza.
 *
 * `extra` es el sobrante que hay que renderizar de mas al final de un clip para
 * que el solape no acorte el video.
 */
export function planDeMontaje(project) {
  const activas = (project?.scenes || []).filter(s => !s.excluida);
  const trans = transicionesDe(project);
  const porDestino = new Map(trans.map(t => [t.toScene, t]));

  const clips = activas.map((s, i) => {
    const siguiente = porDestino.get(i + 2);   // transicion que entra en la escena i+1 (1-based)
    const planificada = Number(s.duration) || 0;
    return {
      index: i,
      id: s.id,
      planificada,
      extra: siguiente ? siguiente.duration : 0,
      render: Number((planificada + (siguiente ? siguiente.duration : 0)).toFixed(3)),
      entra: porDestino.get(i + 1) || null,
    };
  });

  const total = Number(clips.reduce((a, c) => a + c.planificada, 0).toFixed(3));
  return { clips, transiciones: trans, total, conTransiciones: trans.length > 0 };
}
