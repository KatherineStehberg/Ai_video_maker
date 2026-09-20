/**
 * Panel derecho: configuración de lo que esté seleccionado.
 *
 * Sólo vista. Recibe el trozo elegido y devuelve los cambios por callback;
 * quien llama decide cuándo mandarlos al backend.
 */
import { SPEED_LIMITS } from './format.js';

const el = (tag, className, text) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
};

function campo(etiqueta, control, pista) {
  const label = el('label', null, etiqueta);
  label.append(control);
  if (pista) label.append(el('span', 'mini', pista));
  return label;
}

/** Mensaje cuando no hay nada seleccionado: nunca un panel en blanco. */
export function renderVacio(container, texto) {
  container.replaceChildren();
  const caja = el('div', 'panel-vacio');
  caja.append(
    el('span', 'vacio-icono', '◧'),
    el('p', 'ayuda', texto || 'Selecciona una escena en la línea de tiempo para ajustarla aquí.'),
  );
  container.append(caja);
}

/**
 * Configuración del trozo seleccionado. `onCambio` recibe {index, speed,
 * incluido} en cuanto se toca algo; `onIr` salta a ese punto del reproductor.
 */
export function renderInspector(container, { proposal, index, onCambio, onIr } = {}) {
  container.replaceChildren();
  const seg = proposal?.segments?.[index];
  if (!seg) return renderVacio(container);

  container.append(el('h2', null, `Escena ${index + 1}`));
  container.append(el('p', 'mini', `${seg.sourceStart.toFixed(2)} s → ${seg.sourceEnd.toFixed(2)} s del original`));

  const ficha = el('dl', 'ficha');
  for (const [k, v] of [
    ['Dura', `${(seg.sourceEnd - seg.sourceStart).toFixed(2)} s`],
    ['En la salida', `${seg.start.toFixed(2)} – ${seg.end.toFixed(2)} s`],
    ['Motivo', seg.reason],
  ]) { ficha.append(el('dt', null, k), el('dd', null, v)); }
  container.append(ficha);

  // Velocidad: el único parámetro que el backend admite hoy por segmento.
  const velocidad = document.createElement('input');
  velocidad.type = 'number';
  velocidad.step = '0.05';
  velocidad.min = String(SPEED_LIMITS.min);
  velocidad.max = String(SPEED_LIMITS.max);
  velocidad.value = seg.speed.toFixed(2);
  velocidad.id = 'insp-velocidad';
  container.append(campo('Velocidad', velocidad, `Entre ${SPEED_LIMITS.min}× y ${SPEED_LIMITS.max}×. 1 es normal.`));

  const incluir = document.createElement('input');
  incluir.type = 'checkbox';
  incluir.checked = true;
  incluir.id = 'insp-incluir';
  const casilla = el('label', 'casilla');
  casilla.append(incluir, document.createTextNode('Incluir esta escena en el video'));
  container.append(casilla);

  const emitir = () => onCambio?.({ index, speed: Number(velocidad.value), incluido: incluir.checked });
  velocidad.addEventListener('input', emitir);
  incluir.addEventListener('change', emitir);

  const ir = el('button', 'btn btn-mini btn-bloque', 'Ver este momento');
  ir.addEventListener('click', () => onIr?.(seg.sourceStart));
  container.append(ir);

  // Lo que todavía NO se puede cambiar aquí se dice, en vez de mostrar
  // controles que no harían nada.
  const pendiente = el('details');
  pendiente.append(el('summary', null, 'Otros ajustes'));
  pendiente.append(el('p', 'ayuda',
    'El encuadre, el zoom y la transición se ajustan para todo el video en el paso 2, no por escena. '
    + 'El texto y los subtítulos se editan en el paso «Escenas».'));
  container.append(pendiente);
}
