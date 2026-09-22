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
 * FAMILIAS del catalogo, para que elegir entre casi sesenta transiciones no sea
 * una lista interminable.
 */
export const CATEGORIAS = [
  { id: 'basica', label: 'Básicas' },
  { id: 'fundido', label: 'Fundidos' },
  { id: 'deslizar', label: 'Deslizamientos' },
  { id: 'barrido', label: 'Barridos' },
  { id: 'forma', label: 'Formas' },
  { id: 'efecto', label: 'Efectos' },
];

/**
 * Transiciones que este FFmpeg ANUNCIA pero no puede ejecutar.
 *
 * `squeezev` aparece en la ayuda del filtro y tumba el proceso al renderizar
 * (violacion de acceso, comprobado dos veces). Estar en la lista de ayuda no
 * basta: por eso hay esta segunda reja.
 */
export const INESTABLES = {
  squeezev: 'Esta versión de FFmpeg se cierra al renderizarla.',
};

/**
 * Catalogo. `xfade` es el nombre EXACTO del filtro de FFmpeg; si este FFmpeg no
 * lo trae, la transicion se ofrece deshabilitada y etiquetada, nunca simulada.
 *
 * LAS DIRECCIONES ESTAN MEDIDAS, no deducidas del nombre: se cruzaron dos
 * clips planos (rojo -> azul) y se miro, a mitad de transicion, en que mitad
 * del cuadro estaba ya la escena nueva. `slideleft`, por ejemplo, NO entra por
 * la izquierda: entra por la derecha y empuja hacia la izquierda.
 */
export const CATALOGO = [
  // ---- basicas ----
  { id: 'none', label: 'Sin transición', categoria: 'basica', xfade: null, descripcion: 'Corte seco entre escenas.' },
  { id: 'fade', label: 'Fundido', categoria: 'basica', xfade: 'fade', descripcion: 'La escena anterior se funde con la siguiente.' },
  { id: 'dissolve', label: 'Disolver', categoria: 'basica', xfade: 'dissolve', descripcion: 'Disolución granulada, más orgánica que el fundido.' },

  // ---- fundidos ----
  { id: 'fadeslow', label: 'Fundido lento', categoria: 'fundido', xfade: 'fadeslow', descripcion: 'Fundido que arranca despacio y se acelera al final.' },
  { id: 'fadefast', label: 'Fundido rápido', categoria: 'fundido', xfade: 'fadefast', descripcion: 'Fundido que resuelve pronto y se posa al final.' },
  { id: 'fadeblack', label: 'Fundido a negro', categoria: 'fundido', xfade: 'fadeblack', descripcion: 'Pasa por negro entre las dos escenas.' },
  { id: 'fadewhite', label: 'Fundido a blanco', categoria: 'fundido', xfade: 'fadewhite', descripcion: 'Pasa por blanco: más luminoso que el fundido a negro.' },
  { id: 'fadegrays', label: 'Fundido en grises', categoria: 'fundido', xfade: 'fadegrays', descripcion: 'Pierde el color, cambia de escena y lo recupera.' },
  { id: 'distance', label: 'Fundido por color', categoria: 'fundido', xfade: 'distance', descripcion: 'El cambio avanza por zonas según su color.' },

  // ---- deslizamientos ----
  { id: 'slideleft', label: 'Deslizar desde la derecha', categoria: 'deslizar', xfade: 'slideleft', descripcion: 'La escena nueva entra por la derecha y empuja a la anterior.' },
  { id: 'slideright', label: 'Deslizar desde la izquierda', categoria: 'deslizar', xfade: 'slideright', descripcion: 'La escena nueva entra por la izquierda y empuja a la anterior.' },
  { id: 'slideup', label: 'Deslizar desde abajo', categoria: 'deslizar', xfade: 'slideup', descripcion: 'La escena nueva entra por abajo y empuja a la anterior.' },
  { id: 'slidedown', label: 'Deslizar desde arriba', categoria: 'deslizar', xfade: 'slidedown', descripcion: 'La escena nueva entra por arriba y empuja a la anterior.' },
  { id: 'coverleft', label: 'Cubrir desde la derecha', categoria: 'deslizar', xfade: 'coverleft', descripcion: 'La escena nueva pasa por encima desde la derecha; la anterior se queda quieta.' },
  { id: 'coverright', label: 'Cubrir desde la izquierda', categoria: 'deslizar', xfade: 'coverright', descripcion: 'La escena nueva pasa por encima desde la izquierda.' },
  { id: 'coverup', label: 'Cubrir desde abajo', categoria: 'deslizar', xfade: 'coverup', descripcion: 'La escena nueva sube por encima de la anterior.' },
  { id: 'coverdown', label: 'Cubrir desde arriba', categoria: 'deslizar', xfade: 'coverdown', descripcion: 'La escena nueva baja por encima de la anterior.' },
  { id: 'revealleft', label: 'Revelar hacia la izquierda', categoria: 'deslizar', xfade: 'revealleft', descripcion: 'La escena anterior se va por la izquierda y deja ver la nueva.' },
  { id: 'revealright', label: 'Revelar hacia la derecha', categoria: 'deslizar', xfade: 'revealright', descripcion: 'La escena anterior se va por la derecha y deja ver la nueva.' },
  { id: 'revealup', label: 'Revelar hacia arriba', categoria: 'deslizar', xfade: 'revealup', descripcion: 'La escena anterior sube y deja ver la nueva.' },
  { id: 'revealdown', label: 'Revelar hacia abajo', categoria: 'deslizar', xfade: 'revealdown', descripcion: 'La escena anterior baja y deja ver la nueva.' },
  { id: 'smoothleft', label: 'Deslizar suave desde la derecha', categoria: 'deslizar', xfade: 'smoothleft', descripcion: 'Como deslizar, pero con el borde difuminado.' },
  { id: 'smoothright', label: 'Deslizar suave desde la izquierda', categoria: 'deslizar', xfade: 'smoothright', descripcion: 'Como deslizar, pero con el borde difuminado.' },
  { id: 'smoothup', label: 'Deslizar suave desde abajo', categoria: 'deslizar', xfade: 'smoothup', descripcion: 'Como deslizar, pero con el borde difuminado.' },
  { id: 'smoothdown', label: 'Deslizar suave desde arriba', categoria: 'deslizar', xfade: 'smoothdown', descripcion: 'Como deslizar, pero con el borde difuminado.' },
  { id: 'squeezeh', label: 'Aplastar en horizontal', categoria: 'deslizar', xfade: 'squeezeh', descripcion: 'La escena anterior se estrecha hasta desaparecer.' },
  { id: 'squeezev', label: 'Aplastar en vertical', categoria: 'deslizar', xfade: 'squeezev', descripcion: 'La escena anterior se aplasta hasta desaparecer.' },

  // ---- barridos ----
  { id: 'wipeleft', label: 'Barrido hacia la izquierda', categoria: 'barrido', xfade: 'wipeleft', descripcion: 'Una línea vertical descubre la escena nueva desde la derecha.' },
  { id: 'wiperight', label: 'Barrido hacia la derecha', categoria: 'barrido', xfade: 'wiperight', descripcion: 'Una línea vertical descubre la escena nueva desde la izquierda.' },
  { id: 'wipeup', label: 'Barrido hacia arriba', categoria: 'barrido', xfade: 'wipeup', descripcion: 'Una línea horizontal descubre la escena nueva desde abajo.' },
  { id: 'wipedown', label: 'Barrido hacia abajo', categoria: 'barrido', xfade: 'wipedown', descripcion: 'Una línea horizontal descubre la escena nueva desde arriba.' },
  { id: 'wipetl', label: 'Barrido a la esquina superior izquierda', categoria: 'barrido', xfade: 'wipetl', descripcion: 'La escena nueva entra por la esquina inferior derecha.' },
  { id: 'wipetr', label: 'Barrido a la esquina superior derecha', categoria: 'barrido', xfade: 'wipetr', descripcion: 'La escena nueva entra por la esquina inferior izquierda.' },
  { id: 'wipebl', label: 'Barrido a la esquina inferior izquierda', categoria: 'barrido', xfade: 'wipebl', descripcion: 'La escena nueva entra por la esquina superior derecha.' },
  { id: 'wipebr', label: 'Barrido a la esquina inferior derecha', categoria: 'barrido', xfade: 'wipebr', descripcion: 'La escena nueva entra por la esquina superior izquierda.' },
  { id: 'diagtl', label: 'Diagonal suave, esquina superior izquierda', categoria: 'barrido', xfade: 'diagtl', descripcion: 'Barrido diagonal difuminado; la escena nueva entra por la esquina opuesta.' },
  { id: 'diagtr', label: 'Diagonal suave, esquina superior derecha', categoria: 'barrido', xfade: 'diagtr', descripcion: 'Barrido diagonal difuminado; la escena nueva entra por la esquina opuesta.' },
  { id: 'diagbl', label: 'Diagonal suave, esquina inferior izquierda', categoria: 'barrido', xfade: 'diagbl', descripcion: 'Barrido diagonal difuminado; la escena nueva entra por la esquina opuesta.' },
  { id: 'diagbr', label: 'Diagonal suave, esquina inferior derecha', categoria: 'barrido', xfade: 'diagbr', descripcion: 'Barrido diagonal difuminado; la escena nueva entra por la esquina opuesta.' },
  { id: 'horzopen', label: 'Apertura horizontal', categoria: 'barrido', xfade: 'horzopen', descripcion: 'El cuadro se abre por el centro hacia los lados.' },
  { id: 'horzclose', label: 'Cierre horizontal', categoria: 'barrido', xfade: 'horzclose', descripcion: 'El cuadro se cierra desde los lados hacia el centro.' },
  { id: 'vertopen', label: 'Apertura vertical', categoria: 'barrido', xfade: 'vertopen', descripcion: 'El cuadro se abre por el centro hacia arriba y abajo.' },
  { id: 'vertclose', label: 'Cierre vertical', categoria: 'barrido', xfade: 'vertclose', descripcion: 'El cuadro se cierra desde arriba y abajo hacia el centro.' },
  { id: 'radial', label: 'Barrido radial', categoria: 'barrido', xfade: 'radial', descripcion: 'Una manecilla recorre el cuadro y va dejando la escena nueva.' },

  // ---- formas ----
  { id: 'circleopen', label: 'Círculo que se abre', categoria: 'forma', xfade: 'circleopen', descripcion: 'Un círculo crece desde el centro con la escena nueva.' },
  { id: 'circleclose', label: 'Círculo que se cierra', categoria: 'forma', xfade: 'circleclose', descripcion: 'Un círculo se cierra sobre la escena anterior.' },
  { id: 'circlecrop', label: 'Círculo a negro', categoria: 'forma', xfade: 'circlecrop', descripcion: 'La imagen se cierra en un círculo sobre negro y vuelve a abrirse.' },
  { id: 'rectcrop', label: 'Rectángulo a negro', categoria: 'forma', xfade: 'rectcrop', descripcion: 'La imagen se cierra en un rectángulo sobre negro y vuelve a abrirse.' },

  // ---- efectos ----
  { id: 'zoomin', label: 'Zoom suave', categoria: 'efecto', xfade: 'zoomin', descripcion: 'La escena nueva entra acercándose.' },
  { id: 'pixelize', label: 'Pixelado', categoria: 'efecto', xfade: 'pixelize', descripcion: 'Las dos escenas se cruzan pasando por bloques gruesos.' },
  { id: 'hblur', label: 'Desenfoque', categoria: 'efecto', xfade: 'hblur', descripcion: 'El cambio ocurre con la imagen movida, como un barrido de cámara.' },
  { id: 'hlslice', label: 'Tiras hacia la izquierda', categoria: 'efecto', xfade: 'hlslice', descripcion: 'La escena nueva entra por la derecha en tiras horizontales.' },
  { id: 'hrslice', label: 'Tiras hacia la derecha', categoria: 'efecto', xfade: 'hrslice', descripcion: 'La escena nueva entra por la izquierda en tiras horizontales.' },
  { id: 'vuslice', label: 'Tiras hacia arriba', categoria: 'efecto', xfade: 'vuslice', descripcion: 'La escena nueva entra por abajo en tiras verticales.' },
  { id: 'vdslice', label: 'Tiras hacia abajo', categoria: 'efecto', xfade: 'vdslice', descripcion: 'La escena nueva entra por arriba en tiras verticales.' },
  { id: 'hlwind', label: 'Viento hacia la izquierda', categoria: 'efecto', xfade: 'hlwind', descripcion: 'La escena nueva entra por la derecha deshilachada, como al viento.' },
  { id: 'hrwind', label: 'Viento hacia la derecha', categoria: 'efecto', xfade: 'hrwind', descripcion: 'La escena nueva entra por la izquierda deshilachada, como al viento.' },
  { id: 'vuwind', label: 'Viento hacia arriba', categoria: 'efecto', xfade: 'vuwind', descripcion: 'La escena nueva entra por abajo deshilachada, como al viento.' },
  { id: 'vdwind', label: 'Viento hacia abajo', categoria: 'efecto', xfade: 'vdwind', descripcion: 'La escena nueva entra por arriba deshilachada, como al viento.' },
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
  return CATALOGO.map((t) => {
    if (t.xfade === null) return { ...t, disponible: true, motivo: null };
    if (INESTABLES[t.xfade]) return { ...t, disponible: false, motivo: INESTABLES[t.xfade] };
    if (!set.has(t.xfade)) return { ...t, disponible: false, motivo: 'Este FFmpeg no trae esta transición.' };
    return { ...t, disponible: true, motivo: null };
  });
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
