/**
 * ESTADO DEL EDITOR
 *
 * Sin DOM y sin red: se puede importar en Node y probar entero.
 *
 * QUE RESUELVE
 *   1. Acumula los cambios que TODAVIA no se han guardado, como un parche
 *      sobre el proyecto que vino del servidor. El proyecto original no se
 *      toca, asi que descartar es tan barato como tirar el parche.
 *   2. Deshacer y rehacer, sobre ese parche. Solo se ofrecen en la interfaz
 *      cuando de verdad hay algo que deshacer.
 *   3. Sabe si hay cambios pendientes, que es lo que decide el aviso al cerrar
 *      y el estado «Guardado» / «Cambios sin guardar».
 *
 * POR QUE UN PARCHE Y NO EDITAR EL PROYECTO
 * Guardar manda al servidor SOLO lo que cambio. Si se editara el objeto
 * entero habria que enviarlo completo y adivinar en el backend que se toco;
 * asi el backend valida campo por campo lo que llega.
 */

/** Profundidad del historial. Suficiente para una sesion de edicion. */
export const MAX_HISTORIAL = 60;

export function estadoInicial() {
  return {
    id: null,
    proyecto: null,      // lo ultimo confirmado por el servidor
    derivado: null,      // tiempos, estados de recurso, metrica de subtitulos
    capacidades: null,
    parche: {},          // cambios pendientes de guardar
    historial: [],       // parches anteriores (para deshacer)
    futuro: [],          // parches deshechos (para rehacer)
    herramienta: 'escenas',
    escenaSel: 0,
    guardando: false,
    trabajando: false,   // regenerar o exportar en curso
    error: null,
    zonasSeguras: false,
    tiempo: 0,
    reproduciendo: false,
    fuentePreview: 'aproximada',   // 'aproximada' | 'mp4'
    zoom: 1,
  };
}

const clonar = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** ¿Queda algo sin guardar? */
export function haycambios(s) {
  const p = s.parche || {};
  if (p.scenes && Object.keys(p.scenes).length) return true;
  return Object.keys(p).some(k => k !== 'scenes');
}

/**
 * Aplica un cambio al parche y empuja el anterior al historial.
 *
 * `camino` es un campo de proyecto ('title', 'captions.style.color'…).
 * Para escenas se usa `cambiarEscena`, que agrupa por id.
 */
export function cambiar(s, camino, valor) {
  const historial = [...s.historial, clonar(s.parche)].slice(-MAX_HISTORIAL);
  const parche = clonar(s.parche);

  const partes = camino.split('.');
  let nodo = parche;
  for (let i = 0; i < partes.length - 1; i++) {
    if (typeof nodo[partes[i]] !== 'object' || nodo[partes[i]] === null) nodo[partes[i]] = {};
    nodo = nodo[partes[i]];
  }
  nodo[partes.at(-1)] = valor;

  // Un cambio nuevo invalida lo deshecho: es lo que espera cualquiera que haya
  // usado un editor.
  return { ...s, parche, historial, futuro: [] };
}

/** Cambio sobre UNA escena, identificada por su id. */
export function cambiarEscena(s, sceneId, campo, valor) {
  const historial = [...s.historial, clonar(s.parche)].slice(-MAX_HISTORIAL);
  const parche = clonar(s.parche);
  parche.scenes = parche.scenes || {};
  parche.scenes[sceneId] = { ...(parche.scenes[sceneId] || {}), [campo]: valor };
  return { ...s, parche, historial, futuro: [] };
}

export function puedeDeshacer(s) { return s.historial.length > 0; }
export function puedeRehacer(s) { return s.futuro.length > 0; }

export function deshacer(s) {
  if (!puedeDeshacer(s)) return s;
  const historial = [...s.historial];
  const anterior = historial.pop();
  return { ...s, parche: anterior, historial, futuro: [clonar(s.parche), ...s.futuro].slice(0, MAX_HISTORIAL) };
}

export function rehacer(s) {
  if (!puedeRehacer(s)) return s;
  const [siguiente, ...resto] = s.futuro;
  return { ...s, parche: siguiente, historial: [...s.historial, clonar(s.parche)].slice(-MAX_HISTORIAL), futuro: resto };
}

/**
 * El proyecto TAL Y COMO SE VE AHORA: lo del servidor con el parche encima.
 * Es lo que leen los paneles y la vista previa, para que lo que se ve sea
 * siempre lo que se va a guardar.
 */
export function proyectoVisible(s) {
  if (!s.proyecto) return null;
  const p = clonar(s.proyecto);
  const parche = s.parche || {};

  for (const [k, v] of Object.entries(parche)) {
    if (k === 'scenes') continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && p[k] && typeof p[k] === 'object') {
      p[k] = fundir(p[k], v);
    } else {
      p[k] = clonar(v);
    }
  }
  return p;
}

function fundir(base, encima) {
  const salida = { ...base };
  for (const [k, v] of Object.entries(encima)) {
    salida[k] = (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object')
      ? fundir(base[k], v)
      : clonar(v);
  }
  return salida;
}

/** Las escenas derivadas con el parche aplicado encima. */
export function escenasVisibles(s) {
  const escenas = s.derivado?.escenas || [];
  const cambios = s.parche?.scenes || {};
  if (!Object.keys(cambios).length) return escenas;
  return escenas.map((e) => {
    const c = cambios[e.id];
    if (!c) return e;
    const fusion = { ...e, ...c };
    // Un recurso elegido y aun sin guardar tiene que verse YA en la tarjeta,
    // en la vista previa y en la linea de tiempo, no solo tras guardar.
    if (c.assetPath !== undefined) fusion.recurso = recursoPendiente(c.assetPath, s.creditos?.[c.assetPath]);
    if (c.assetPath !== undefined) fusion.faltaRecurso = !c.assetPath;
    return fusion;
  });
}

const EXT_VIDEO = /\.(mp4|mov|webm|m4v|mkv)$/i;

/** Ficha de recurso para una ruta elegida en el editor y aun no guardada. */
export function recursoPendiente(ruta, credito = null) {
  if (!ruta) return { estado: 'falta', etiqueta: 'Sin imagen', kind: null, url: null, path: null, credito: null };
  return {
    estado: 'listo',
    etiqueta: 'Listo (sin guardar)',
    kind: EXT_VIDEO.test(ruta) ? 'video' : 'image',
    proveedor: credito?.proveedor || 'manual',
    path: ruta,
    url: `/file?path=${encodeURIComponent(ruta)}`,
    credito,
    pendiente: true,
  };
}

export function escenaActual(s) {
  const escenas = escenasVisibles(s);
  return escenas[s.escenaSel] || escenas[0] || null;
}

/** Cuerpo de la petición de guardado: sólo lo que cambió. */
export function cuerpoGuardado(s) {
  const p = s.parche || {};
  const cuerpo = { revision: s.derivado?.revision };
  for (const [k, v] of Object.entries(p)) {
    if (k === 'scenes') continue;
    cuerpo[k] = v;
  }
  if (p.scenes) {
    cuerpo.scenes = Object.entries(p.scenes).map(([id, campos]) => ({ id, ...campos }));
  }
  return cuerpo;
}

/** Tras guardar: el servidor manda, el parche se vacía y el historial se cierra. */
export function confirmarGuardado(s, { proyecto, derivado }) {
  return { ...s, proyecto, derivado, parche: {}, historial: [], futuro: [], guardando: false, error: null };
}

/** Segundos -> "m:ss". Para el reloj del reproductor y la regla. */
export function reloj(segundos) {
  const t = Math.max(0, Math.floor(Number(segundos) || 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/** Escena que corresponde a un instante, para mover el cabezal y el preview. */
export function escenaEn(escenas, segundo) {
  if (!escenas?.length) return -1;
  for (let i = 0; i < escenas.length; i++) {
    if (segundo >= escenas[i].start && segundo < escenas[i].end) return i;
  }
  return segundo >= escenas.at(-1).end ? escenas.length - 1 : 0;
}
