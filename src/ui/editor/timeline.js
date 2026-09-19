/**
 * Línea de tiempo visual. Sólo dibuja: recibe el modelo ya derivado por
 * format.js y avisa por callback cuando se hace clic. No habla con la API.
 *
 * Clases CSS usadas (ver editor.css, sección TIMELINE):
 *   .pista-fila / .pista-nombre / .pista / .segmento / .beat / .corte / .eje
 */
import { timelineModel } from './format.js';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function renderTimeline(container, analysis, proposal, { onSeek, onSelect, seleccionada = null } = {}) {
  const model = timelineModel(analysis, proposal);
  container.replaceChildren();
  if (!model) {
    container.append(el('p', 'ayuda', 'Aquí verás los cortes y el ritmo en cuanto analices un video.'));
    return;
  }

  const linea = el('div', 'timeline-lineas');

  // Pista 1: trozos del montaje propuesto, coloreados según su velocidad.
  const segmentos = el('div', 'pista pista-bloques');
  if (model.segments.length) {
    for (const s of model.segments) {
      const bloque = el('div', `bloque bloque-${s.kind}`);
      bloque.style.left = `${s.at * 100}%`;
      bloque.style.width = `${Math.max(s.width * 100, 0.4)}%`;
      bloque.title = `Trozo ${s.index + 1}: ${s.sourceStart.toFixed(2)}–${s.sourceEnd.toFixed(2)} s · ${s.speed.toFixed(2)}×`;
      if (s.index === seleccionada) bloque.setAttribute('aria-pressed', 'true');
      bloque.append(el('span', 'bloque-txt', s.kind === 'normal' ? `${s.index + 1}` : `${s.index + 1} · ${s.speed.toFixed(2)}×`));
      bloque.setAttribute('role', 'button');
      bloque.setAttribute('tabindex', '0');
      bloque.setAttribute('aria-pressed', 'false');
      bloque.addEventListener('click', () => { onSeek?.(s.sourceStart); onSelect?.(s.index); });
      bloque.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); bloque.click(); } });
      segmentos.append(bloque);
    }
  } else {
    segmentos.append(el('p', 'pista-vacia', 'Crea una propuesta para ver los trozos.'));
  }

  // Pista 2: beats de la música y sonidos destacados.
  const ritmo = el('div', 'pista pista-fina pista-ritmo');
  for (const b of model.beats) {
    const marca = el('div', `beat${b.supported ? ' beat-fuerte' : ''}`);
    marca.style.left = `${b.at * 100}%`;
    marca.title = `Beat · ${b.timestamp.toFixed(2)} s`;
    ritmo.append(marca);
  }
  for (const o of model.onsets) {
    const punto = el('div', 'evento');
    punto.style.left = `${o.at * 100}%`;
    punto.title = `Sonido · ${o.timestamp.toFixed(2)} s`;
    ritmo.append(punto);
  }
  if (!model.beats.length && !model.onsets.length) ritmo.append(el('p', 'pista-vacia', 'No se detectó ritmo en el audio.'));

  // Pista 3: cortes visuales detectados.
  const cortes = el('div', 'pista pista-fina pista-cortes');
  for (const c of model.cuts) {
    const marca = el('button', 'corte');
    marca.type = 'button';
    marca.style.left = `${c.at * 100}%`;
    marca.title = `Corte · ${c.timestamp.toFixed(2)} s (frame ${c.frameExact ? '' : '~'}${c.frame})`;
    marca.setAttribute('aria-label', marca.title);
    marca.addEventListener('click', () => onSeek?.(c.timestamp));
    cortes.append(marca);
  }
  if (!model.cuts.length) cortes.append(el('p', 'pista-vacia', 'No se detectaron cortes.'));

  const eje = el('div', 'eje');
  for (let i = 0; i <= 4; i++) {
    const marca = el('span', 'eje-marca', `${(model.duration * i / 4).toFixed(1)} s`);
    marca.style.left = `${i * 25}%`;
    eje.append(marca);
  }

  linea.append(fila('Trozos', segmentos), fila('Ritmo', ritmo), fila('Cortes', cortes), eje);
  container.append(linea);
}

function fila(nombre, pista) {
  const wrap = el('div', 'pista-fila');
  wrap.append(el('span', 'pista-nombre', nombre), pista);
  return wrap;
}
