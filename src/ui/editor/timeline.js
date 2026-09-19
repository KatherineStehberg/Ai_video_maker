/** Timeline visual. Sólo dibuja: recibe el modelo ya derivado y avisa al hacer clic. */
import { timelineModel } from './format.js';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function renderTimeline(container, analysis, proposal, { onSeek } = {}) {
  const model = timelineModel(analysis, proposal);
  container.replaceChildren();
  if (!model) {
    container.append(el('p', 'muted', 'La timeline aparecerá cuando haya un análisis.'));
    return;
  }

  const track = el('div', 'tl');
  track.style.setProperty('--tl-duration', String(model.duration));

  // Capa 1: segmentos propuestos (si los hay), como bloques de fondo.
  const segments = el('div', 'tl-row tl-segments');
  if (model.segments.length) {
    for (const s of model.segments) {
      const block = el('div', `tl-seg tl-seg--${s.kind}`);
      block.style.left = `${s.at * 100}%`;
      block.style.width = `${Math.max(s.width * 100, 0.4)}%`;
      block.title = `Segmento ${s.index + 1}: ${s.sourceStart.toFixed(3)}–${s.sourceEnd.toFixed(3)} s · ${s.speed.toFixed(4)}× (${s.reason})`;
      block.append(el('span', 'tl-seg-label', s.kind === 'normal' ? '1×' : `${s.speed.toFixed(2)}×`));
      block.addEventListener('click', () => onSeek?.(s.sourceStart));
      segments.append(block);
    }
  } else {
    segments.append(el('p', 'tl-empty', 'Sin propuesta todavía: crea una para ver los segmentos.'));
  }

  // Capa 2: beats (marcas finas) y onsets (puntos).
  const rhythm = el('div', 'tl-row tl-rhythm');
  for (const b of model.beats) {
    const tick = el('div', `tl-beat${b.supported ? ' is-supported' : ''}`);
    tick.style.left = `${b.at * 100}%`;
    tick.title = `Beat en ${b.timestamp.toFixed(3)} s`;
    rhythm.append(tick);
  }
  for (const o of model.onsets) {
    const dot = el('div', 'tl-onset');
    dot.style.left = `${o.at * 100}%`;
    dot.title = `Evento de audio en ${o.timestamp.toFixed(3)} s`;
    rhythm.append(dot);
  }
  if (!model.beats.length && !model.onsets.length) rhythm.append(el('p', 'tl-empty', 'Sin eventos de audio detectados.'));

  // Capa 3: cortes visuales, con su número de frame.
  const cuts = el('div', 'tl-row tl-cuts');
  for (const c of model.cuts) {
    const mark = el('button', 'tl-cut');
    mark.type = 'button';
    mark.style.left = `${c.at * 100}%`;
    mark.title = `Corte en ${c.timestamp.toFixed(3)} s · frame ${c.frameExact ? '' : '~'}${c.frame}`;
    mark.setAttribute('aria-label', mark.title);
    mark.addEventListener('click', () => onSeek?.(c.timestamp));
    cuts.append(mark);
  }
  if (!model.cuts.length) cuts.append(el('p', 'tl-empty', 'Sin cortes visuales detectados.'));

  const axis = el('div', 'tl-axis');
  for (let i = 0; i <= 4; i++) {
    const label = el('span', 'tl-axis-label', `${(model.duration * i / 4).toFixed(1)} s`);
    label.style.left = `${i * 25}%`;
    axis.append(label);
  }

  track.append(
    labelled('Segmentos', segments),
    labelled('Ritmo', rhythm),
    labelled('Cortes', cuts),
    axis,
  );
  container.append(track);
}

function labelled(text, row) {
  const wrap = el('div', 'tl-line');
  wrap.append(el('span', 'tl-line-label', text), row);
  return wrap;
}
