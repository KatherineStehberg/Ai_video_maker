/**
 * VISTA PREVIA CENTRAL
 *
 * Compone en el navegador lo que el render hara con FFmpeg: la imagen de la
 * escena, el rotulo y el subtitulo, dentro de un marco con la proporcion del
 * formato.
 *
 * ES UNA APROXIMACION Y SE DICE. No usa libass ni la misma tipografia, asi que
 * el salto de linea exacto puede variar un caracter. Lo que SI es exacto,
 * porque sale de la misma metrica del backend:
 *   - el tamano de letra relativo al alto del encuadre;
 *   - el margen inferior y las zonas seguras;
 *   - que el rotulo nunca cae sobre la banda de subtitulos.
 *
 * Cuando existe un MP4 al dia, la interfaz ofrece verlo: ESE si es definitivo.
 */

import { escenasVisibles, escenaEn, proyectoVisible, reloj } from './state.js';

/** Envuelve un texto en como mucho `maxLineas`, sin cortar palabras. */
export function partirEnLineas(texto, maxChars, maxLineas = 2) {
  const palabras = String(texto || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!palabras.length) return [];
  const lineas = [];
  let actual = '';
  for (const p of palabras) {
    if (!actual) actual = p;
    else if ((actual + ' ' + p).length <= maxChars) actual += ' ' + p;
    else { lineas.push(actual); actual = p; }
    if (lineas.length === maxLineas) break;
  }
  if (actual && lineas.length < maxLineas) lineas.push(actual);
  return lineas.slice(0, maxLineas);
}

/**
 * El trozo de subtitulo que toca en este instante.
 *
 * Reparte el texto de la escena entre su duracion igual que hace el backend
 * (proporcional al numero de caracteres), asi que el subtitulo cambia a la vez
 * que cambiaria en el video.
 */
export function subtituloEn(escena, segundo, maxChars, maxLineas) {
  if (!escena || !escena.text) return '';
  const lineas = partirEnLineas(escena.text, maxChars, 999);
  if (!lineas.length) return '';

  const grupos = [];
  for (let i = 0; i < lineas.length; i += maxLineas) grupos.push(lineas.slice(i, i + maxLineas));

  const pesos = grupos.map(g => Math.max(1, g.join(' ').length));
  const total = pesos.reduce((a, b) => a + b, 0);
  const dentro = Math.max(0, Math.min(escena.duration, segundo - escena.start));

  let acumulado = 0;
  for (let i = 0; i < grupos.length; i++) {
    acumulado += pesos[i];
    const fin = escena.duration * (acumulado / total);
    if (dentro < fin || i === grupos.length - 1) return grupos[i].join('\n');
  }
  return grupos.at(-1).join('\n');
}

const POS_ROTULO = { top: 0.08, 'upper-third': 0.16, center: 0.44, 'lower-third': 0.62, bottom: 0.72 };
const FACTOR_ROTULO = { small: 1.1, medium: 1.45, large: 1.85, xlarge: 2.4 };

export function crearPreview({ marco, img, video, vacioEl, rotulo, subtitulo, zonaArriba, zonaAbajo }) {
  // El tamano del marco solo cambia si cambia la ventana o el formato. Medirlo
  // en cada tic de la reproduccion (diez veces por segundo) obligaba al
  // navegador a recalcular el layout de toda la pagina justo despues de cada
  // escritura, y en un proyecto de 279 escenas eso bloqueaba la voz.
  let cache = { clave: null, px: 0 };
  let sucio = true;
  if (typeof ResizeObserver !== 'undefined' && marco.parentElement) {
    new ResizeObserver(() => { sucio = true; }).observe(marco.parentElement);
  }
  const medirMarco = (dimensiones) => {
    const clave = `${dimensiones?.width}x${dimensiones?.height}`;
    if (!sucio && cache.clave === clave && cache.px) return cache.px;
    cache = { clave, px: ajustarMarco(marco, dimensiones) };
    sucio = false;
    return cache.px;
  };

  return {
    /**
     * @param {object} s  estado del editor
     */
    pintar(s) {
      const escenas = escenasVisibles(s);
      const d = s.derivado;
      if (!d) return;
      // El proyecto VISIBLE, con los cambios sin guardar encima: lo que se ve
      // tiene que ser lo que se va a guardar, no lo ultimo que dijo el servidor.
      const p = proyectoVisible(s) || {};

      marco.dataset.formato = p.aspectRatio || '9:16';
      // Alto del marco EN PANTALLA: es la referencia para convertir los
      // tamanos del render (px sobre 1920) a px reales de la vista previa.
      const marcoPx = medirMarco(d.dimensiones);
      const alto = d.dimensiones?.height || 1920;
      // `font-size` en porcentaje es relativo a la fuente del PADRE, no a la
      // altura de la caja: puesto asi, un subtitulo de 48 px salia a 0,7 px y
      // no se veia. Se convierte a pixeles reales.
      const aPx = valorDelRender => Math.max(6, (valorDelRender / alto) * marcoPx);
      const i = escenaEn(escenas, s.tiempo);
      const e = escenas[i] || escenas[0];

      // ---- fondo ----
      const verMp4 = s.fuentePreview === 'mp4' && d.salida?.url;
      if (verMp4) {
        video.hidden = false; img.hidden = true; vacioEl.hidden = true;
        if (video.getAttribute('src') !== d.salida.url) video.src = d.salida.url;
      } else {
        video.hidden = true;
        const r = e?.recurso;
        if (r?.url && r.kind === 'image') {
          img.hidden = false; vacioEl.hidden = true;
          if (img.getAttribute('src') !== r.url) img.src = r.url;
        } else if (r?.url && r.kind === 'video') {
          img.hidden = true; vacioEl.hidden = true;
          video.hidden = false;
          if (video.getAttribute('src') !== r.url) video.src = r.url;
        } else {
          img.hidden = true; vacioEl.hidden = false;
          vacioEl.textContent = e ? 'Esta escena se renderizará con un fondo de marca' : 'Sin escenas';
        }
      }

      // Sobre el MP4 definitivo NO se dibujan overlays: ya vienen quemados, y
      // superponerlos otra vez los duplicaria en pantalla.
      const overlays = !verMp4;

      // ---- zonas seguras ----
      const m = d.subtitulos?.metrica;
      const verZonas = s.zonasSeguras && m;
      zonaArriba.hidden = !verZonas;
      zonaAbajo.hidden = !verZonas;
      if (verZonas) {
        zonaArriba.style.height = `${(m.safeTop / alto) * 100}%`;
        zonaAbajo.style.height = `${(m.safeBottom / alto) * 100}%`;
      }

      // ---- subtitulo ----
      const subsOn = overlays && p.captions?.enabled !== false && e;
      subtitulo.hidden = !subsOn;
      if (subsOn && m) {
        const texto = subtituloEn(e, s.tiempo, m.maxCharsPerLine, m.maxLines);
        subtitulo.textContent = texto;
        subtitulo.hidden = !texto;
        // Todo en porcentaje del alto del marco: asi la vista previa mantiene
        // la proporcion aunque el marco mida lo que mida en pantalla.
        const est = p.captions?.style || {};
        subtitulo.style.fontSize = `${aPx(m.fontSize).toFixed(1)}px`;
        subtitulo.style.color = est.color || '#ffffff';
        subtitulo.style.fontFamily = `${est.fontFamily || 'Arial'}, sans-serif`;
        subtitulo.style.fontWeight = est.bold === false ? '500' : '700';
        subtitulo.style.textAlign = est.alignment || 'center';
        if (est.background === 'box') {
          subtitulo.style.textShadow = 'none';
          subtitulo.style.background = 'transparent';
          // La caja envuelve al texto, no a la franja entera.
          subtitulo.style.setProperty('--caja', hexA(est.backgroundColor || '#000000', est.backgroundOpacity ?? 0.6));
        } else {
          subtitulo.style.background = 'transparent';
          subtitulo.style.textShadow = est.background === 'none'
            ? 'none'
            : `0 0 3px ${est.outlineColor || '#000'}, 0 0 3px ${est.outlineColor || '#000'}, 0 1px 2px ${est.outlineColor || '#000'}`;
          subtitulo.style.removeProperty('--caja');
        }
        subtitulo.dataset.fondo = est.background || 'outline';

        const pos = est.position || 'bottom';
        subtitulo.style.top = pos === 'top' ? `${(m.marginV / alto) * 100}%` : 'auto';
        subtitulo.style.bottom = pos === 'bottom' ? `${(m.marginV / alto) * 100}%` : 'auto';
        if (pos === 'center') { subtitulo.style.top = '44%'; subtitulo.style.bottom = 'auto'; }
      }

      // ---- rotulo ----
      const rotOn = overlays && e?.showOnScreenText && String(e.onScreenTitle || '').trim();
      rotulo.hidden = !rotOn;
      if (rotOn) {
        const est = e.onScreenStyle || {};
        const base = m ? m.fontSize : alto / 30;
        const tam = base * (FACTOR_ROTULO[est.size] || FACTOR_ROTULO.large);
        rotulo.textContent = partirEnLineas(e.onScreenTitle, 26, 2).join('\n');
        rotulo.style.fontSize = `${aPx(tam).toFixed(1)}px`;
        rotulo.style.color = est.color || '#ffffff';
        rotulo.style.top = `${(POS_ROTULO[e.onScreenPosition] ?? 0.16) * 100}%`;
        if (est.background === 'box') {
          rotulo.style.background = hexA(est.backgroundColor || '#000000', est.backgroundOpacity ?? 0.45);
          rotulo.style.padding = '.12em .3em';
          rotulo.style.borderRadius = '4px';
          rotulo.style.textShadow = 'none';
        } else if (est.background === 'outline') {
          rotulo.style.background = 'transparent';
          rotulo.style.padding = '0';
          rotulo.style.textShadow = `0 0 4px ${est.outlineColor || '#000'}, 0 0 4px ${est.outlineColor || '#000'}`;
        } else {
          rotulo.style.background = 'transparent';
          rotulo.style.padding = '0';
          rotulo.style.textShadow = 'none';
        }
      }
    },
  };
}

/**
 * Da al marco el mayor tamano que cabe en su contenedor SIN deformarse.
 *
 * Se calcula aqui y no en CSS porque con `aspect-ratio` hay que fijar una de
 * las dos dimensiones, y entonces la otra queda a merced de `max-height` o
 * `max-width`: el recorte no vuelve a resolver la proporcion y el encuadre
 * sale estirado (un 16:9 salia a 2.04).
 */
function ajustarMarco(marco, dimensiones) {
  const caja = marco.parentElement?.getBoundingClientRect();
  if (!caja || !caja.width || !caja.height) return marco.getBoundingClientRect().height || 0;
  const ar = (dimensiones?.width || 1080) / (dimensiones?.height || 1920);
  // Se prueba a llenar el ancho; si no cabe de alto, manda el alto.
  let ancho = caja.width;
  let alto = ancho / ar;
  if (alto > caja.height) { alto = caja.height; ancho = alto * ar; }
  marco.style.width = `${Math.floor(ancho)}px`;
  marco.style.height = `${Math.floor(alto)}px`;
  return Math.floor(alto);
}

/** #rrggbb + alfa -> rgba(), para poder usar la opacidad tal cual. */
function hexA(hex, alfa) {
  const h = String(hex || '#000000').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, Number(alfa) || 0))})`;
}

export { reloj };
