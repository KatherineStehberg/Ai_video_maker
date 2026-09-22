/**
 * LINEA DE TIEMPO MULTIPISTA
 *
 * Seis pistas, y cada una solo aparece si tiene contenido real:
 *
 *   Texto destacado   un bloque por escena con rotulo
 *   Subtitulos        un bloque por escena subtitulada
 *   Narracion         forma de onda REAL de narration.wav
 *   Visual            miniatura de la imagen de cada escena
 *   Musica            forma de onda REAL de la pista
 *   Cortes            marcas de cambio de escena
 *
 * SIN ARRASTRAR. Un clip se puede seleccionar, y eso mueve el cabezal y el
 * panel; no se puede mover, porque mover un clip todavia no se puede guardar y
 * un arrastre que se deshace al soltar es peor que no tenerlo.
 *
 * La forma de onda sale de `/waveform`, que lee el audio de verdad. Si no hay
 * archivo, el bloque se dibuja rayado y se dice que no hay onda: nunca se
 * inventa una.
 */

import { escenasVisibles, reloj } from './state.js';

/** Pixeles por segundo a zoom 1. Un video de 30 s entra en pantalla. */
export const PX_SEG_BASE = 40;

/** Separacion de las marcas de la regla, segun cuanto se vea. */
function pasoRegla(pxSeg) {
  for (const p of [1, 2, 5, 10, 15, 30, 60, 120, 300, 600]) {
    if (p * pxSeg >= 58) return p;
  }
  return 900;
}

const el = (tag, clase, texto) => {
  const n = document.createElement(tag);
  if (clase) n.className = clase;
  if (texto !== undefined) n.textContent = texto;
  return n;
};

/**
 * Ancho maximo del lienzo de la onda.
 *
 * Un canvas por encima de ~32 000 px no lo dibuja el navegador, y en un video
 * de media hora el clip de narracion mide 67 000 px. Se dibuja a resolucion
 * acotada y el CSS lo estira: la envolvente se ve igual y siempre se pinta.
 */
const ONDA_ANCHO_MAX = 4000;

/** Dibuja los picos en un canvas del ancho del clip. */
function pintarOnda(canvas, picos, color) {
  const real = Math.max(1, Math.round(canvas.getBoundingClientRect().width));
  const ancho = Math.min(ONDA_ANCHO_MAX, real);
  const alto = Math.max(1, Math.round(canvas.getBoundingClientRect().height));
  canvas.width = ancho; canvas.height = alto;
  const ctx = canvas.getContext('2d');
  if (!ctx || !picos?.length) return;
  ctx.clearRect(0, 0, ancho, alto);
  ctx.fillStyle = color;
  const medio = alto / 2;
  for (let x = 0; x < ancho; x++) {
    const v = picos[Math.min(picos.length - 1, Math.floor((x / ancho) * picos.length))];
    const h = Math.max(1, v * (alto - 2));
    ctx.fillRect(x, medio - h / 2, 1, h);
  }
}

/**
 * Zoom con el que un proyecto entero cabe de una vez en la pantalla.
 *
 * El tope superior es 1x: un video de cinco segundos no se amplia hasta llenar
 * la pantalla, se queda a tamano natural. Por abajo el limite es muy pequeno a
 * proposito, porque media hora de video a 40 px/s son 67 000 px y el objetivo
 * es justamente que quepa sin hacer scroll.
 */
export function zoomQueEncaja(duracionSegundos, anchoPx) {
  const d = Math.max(1, Number(duracionSegundos) || 1);
  const ancho = Math.max(200, Number(anchoPx) || 800);
  return Math.max(0.001, Math.min(1, ancho / (d * PX_SEG_BASE)));
}

export function crearTimeline({ nombres, pistas, regla, cabezal, scroll, lienzo, onSeleccionar, onMover }) {
  let ondas = { narracion: null, musica: null };

  // Pinchar en cualquier sitio mueve el cabezal: es lo que se espera de una
  // linea de tiempo, y no implica poder arrastrar clips.
  const alPinchar = (ev) => {
    const caja = lienzo.getBoundingClientRect();
    const x = ev.clientX - caja.left;
    const pxSeg = Number(lienzo.dataset.pxSeg) || PX_SEG_BASE;
    onMover?.(Math.max(0, x / pxSeg));
  };
  regla.addEventListener('pointerdown', alPinchar);

  return {
    ondas(nuevas) { ondas = { ...ondas, ...nuevas }; },

    pintar(s) {
      const d = s.derivado;
      if (!d) return;
      const escenas = escenasVisibles(s);
      const duracion = Math.max(1, d.duracion || 1);
      const pxSeg = PX_SEG_BASE * (s.zoom || 1);
      const ancho = Math.max(scroll.clientWidth, Math.ceil(duracion * pxSeg) + 24);

      lienzo.style.width = `${ancho}px`;
      lienzo.dataset.pxSeg = String(pxSeg);

      // ---- regla ----
      regla.replaceChildren();
      regla.style.width = `${ancho}px`;
      const paso = pasoRegla(pxSeg);
      for (let t = 0; t <= duracion; t += paso) {
        const marca = el('span', 'tl-marca', reloj(t));
        marca.style.left = `${t * pxSeg}px`;
        regla.append(marca);
      }

      // ---- que pistas existen de verdad ----
      const def = [
        { id: 'texto', nombre: 'Texto destacado', color: 'var(--p-texto)', cuenta: d.pistas.textoDestacado },
        { id: 'subs', nombre: 'Subtítulos', color: 'var(--p-subs)', cuenta: d.pistas.subtitulos },
        { id: 'voz', nombre: 'Narración', color: 'var(--p-voz)', cuenta: d.pistas.narracion },
        { id: 'visual', nombre: 'Visual', color: 'var(--p-visual)', cuenta: escenas.length },
        { id: 'musica', nombre: 'Música', color: 'var(--p-musica)', cuenta: d.pistas.musica },
        { id: 'cortes', nombre: 'Cortes', color: 'var(--linea-fuerte)', cuenta: Math.max(0, escenas.length - 1) },
      ].filter(p => p.cuenta > 0);

      nombres.replaceChildren();
      pistas.replaceChildren();
      pistas.style.width = `${ancho}px`;

      for (const p of def) {
        const fila = el('div', 'tl-nombre');
        const punto = el('span', 'tl-color');
        punto.style.background = p.color;
        fila.append(punto, el('span', null, p.nombre), el('span', 'cuenta', String(p.cuenta)));
        nombres.append(fila);

        const pista = el('div', 'tl-pista');
        pista.dataset.pista = p.id;
        pintarPista(pista, p, { s, escenas, pxSeg, duracion, ondas, onSeleccionar });
        pistas.append(pista);
      }

      cabezal.style.left = `${Math.min(duracion, Math.max(0, s.tiempo)) * pxSeg}px`;
    },

    /** Solo mueve el cabezal. Es lo único que cambia mientras se reproduce. */
    moverCabezal(s) {
      const pxSeg = Number(lienzo.dataset.pxSeg) || PX_SEG_BASE;
      const total = Math.max(1, s.derivado?.duracion || 1);
      cabezal.style.left = `${Math.min(total, Math.max(0, s.tiempo)) * pxSeg}px`;
    },

    /** Deja el cabezal a la vista cuando la reproducción lo saca del encuadre. */
    seguir(s) {
      const pxSeg = Number(lienzo.dataset.pxSeg) || PX_SEG_BASE;
      const x = s.tiempo * pxSeg;
      const izq = scroll.scrollLeft;
      const der = izq + scroll.clientWidth;
      if (x < izq + 40 || x > der - 40) scroll.scrollLeft = Math.max(0, x - scroll.clientWidth / 2);
    },
  };
}

function pintarPista(pista, def, { s, escenas, pxSeg, duracion, ondas, onSeleccionar }) {
  const clip = (inicio, dur, { titulo, color, index, excluida, miniatura, onda, sinOnda }) => {
    const c = el('div', 'tl-clip');
    c.style.left = `${inicio * pxSeg}px`;
    c.style.width = `${Math.max(2, dur * pxSeg)}px`;
    c.style.background = color;
    c.title = titulo;
    if (index !== undefined) {
      c.dataset.index = String(index);
      if (index === s.escenaSel) c.setAttribute('aria-current', 'true');
      c.addEventListener('click', () => onSeleccionar?.(index));
    }
    if (excluida) c.dataset.excluida = 'si';
    if (miniatura) {
      const img = document.createElement('img');
      img.src = miniatura; img.alt = ''; img.loading = 'lazy';
      c.append(img);
    }
    if (onda) {
      const cv = document.createElement('canvas');
      cv.className = 'tl-onda';
      c.append(cv);
      // El canvas necesita estar en el DOM para medir: se pinta en el
      // siguiente cuadro, cuando ya tiene tamaño.
      requestAnimationFrame(() => pintarOnda(cv, onda, 'rgba(255,255,255,.85)'));
    }
    if (sinOnda) c.dataset.onda = 'no';
    if (dur * pxSeg > 34) c.append(el('span', null, titulo.slice(0, 40)));
    return c;
  };

  if (def.id === 'visual') {
    for (const e of escenas) {
      pista.append(clip(e.start, e.end - e.start, {
        titulo: `Escena ${e.numero}`, color: 'var(--p-visual)', index: e.index,
        excluida: e.excluida,
        miniatura: e.recurso?.kind === 'image' ? e.recurso.url : null,
      }));
    }
  } else if (def.id === 'texto') {
    for (const e of escenas.filter(x => x.tieneTextoDestacado)) {
      pista.append(clip(e.start, e.end - e.start, {
        titulo: e.onScreenTitle, color: 'var(--p-texto)', index: e.index, excluida: e.excluida,
      }));
    }
  } else if (def.id === 'subs') {
    for (const e of escenas.filter(x => x.tieneSubtitulos && !x.excluida)) {
      pista.append(clip(e.start, e.end - e.start, {
        titulo: `${e.cues} subtítulo${e.cues === 1 ? '' : 's'}`, color: 'var(--p-subs)', index: e.index,
      }));
    }
  } else if (def.id === 'voz') {
    const onda = ondas.narracion?.disponible ? ondas.narracion.picos : null;
    // Una sola pista continua: la narración se monta como un único WAV.
    pista.append(clip(0, duracion, {
      titulo: onda ? 'Narración' : 'Narración (sin forma de onda)',
      color: 'var(--p-voz)', onda, sinOnda: !onda,
    }));
  } else if (def.id === 'musica') {
    const onda = ondas.musica?.disponible ? ondas.musica.picos : null;
    pista.append(clip(0, duracion, {
      titulo: onda ? 'Música' : 'Música (sin forma de onda)',
      color: 'var(--p-musica)', onda, sinOnda: !onda,
    }));
  } else if (def.id === 'cortes') {
    for (const e of escenas.slice(1)) {
      const marca = el('div', 'tl-clip');
      marca.style.left = `${e.start * pxSeg}px`;
      marca.style.width = '2px';
      marca.style.background = 'var(--tinta-tenue)';
      marca.title = `Corte en ${reloj(e.start)}`;
      marca.addEventListener('click', () => onSeleccionar?.(e.index));
      pista.append(marca);
    }
  }
}
