/**
 * Panel de segmentos editable. Sólo vista: dibuja una fila por trozo con una
 * casilla para incluirlo y un control de velocidad, y devuelve lo que el
 * usuario ha elegido. Quien llama decide cuándo enviarlo a la API.
 *
 * Clases CSS: ver editor.css, sección "PANEL DE SEGMENTOS EDITABLE".
 */
import { SPEED_LIMITS } from './format.js';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Etiqueta legible del motivo, sin jerga del backend. */
const MOTIVOS = {
  'beat-aligned': 'Ajustado a la música',
  'corte-detectado': 'Corte detectado',
  'ajuste-manual': 'Ajustado por ti',
  'duracion-objetivo': 'Ajustado a la duración pedida',
  'beat-aligned+duracion-objetivo': 'Ajustado a la música y a la duración',
};

/**
 * Dibuja el panel. `onChange` se llama con la selección actual cada vez que el
 * usuario toca algo, para que el llamante active el botón de aplicar.
 */
export function renderSegments(container, proposal, { onChange } = {}) {
  container.replaceChildren();
  if (!proposal?.segments?.length) return;

  proposal.segments.forEach((s, index) => {
    const fila = el('div', 'seg-fila');
    fila.dataset.incluido = 'si';
    fila.dataset.index = String(index);
    // Se guarda la velocidad exacta del backend. El input sólo muestra dos
    // decimales; sin esto, reenviar el valor redondeado alteraría en silencio
    // la velocidad (y la duración) de todos los trozos sin tocarlos.
    fila.dataset.speedOriginal = String(s.speed);

    fila.append(el('span', 'escena-num', String(index + 1)));

    const info = el('div');
    info.append(
      el('div', 'mini', `${s.sourceStart.toFixed(2)} s → ${s.sourceEnd.toFixed(2)} s  ·  dura ${(s.sourceEnd - s.sourceStart).toFixed(2)} s`),
      el('div', 'escena-rol', MOTIVOS[s.reason] || s.reason),
    );
    fila.append(info);

    // Velocidad: 1 = normal. Los límites son los que admite el backend.
    const velocidad = el('label', 'mini');
    velocidad.append(document.createTextNode('Velocidad'));
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.05';
    input.min = String(SPEED_LIMITS.min);
    input.max = String(SPEED_LIMITS.max);
    input.value = s.speed.toFixed(2);
    input.className = 'segmento-velocidad';
    velocidad.append(input);
    fila.append(velocidad);

    const incluir = el('label', 'casilla mini');
    const casilla = document.createElement('input');
    casilla.type = 'checkbox';
    casilla.checked = true;
    casilla.className = 'segmento-incluir';
    incluir.append(casilla, document.createTextNode('Incluir'));
    fila.append(incluir);

    casilla.addEventListener('change', () => {
      fila.dataset.incluido = casilla.checked ? 'si' : 'no';
      input.disabled = !casilla.checked;
      onChange?.(readSegments(container));
    });
    input.addEventListener('input', () => onChange?.(readSegments(container)));

    container.append(fila);
  });
}

/**
 * Lee la selección actual en el formato que espera PATCH /api/video-edits/:id.
 *
 * Si la velocidad mostrada no difiere de la original más allá de lo que el
 * input puede representar (dos decimales), se omite el campo `speed`: así el
 * backend conserva su valor exacto en lugar de recibir uno redondeado.
 */
export function readSegments(container) {
  const segments = [];
  for (const fila of container.querySelectorAll('.seg-fila')) {
    if (fila.dataset.incluido === 'no') continue;
    const index = Number(fila.dataset.index);
    const mostrada = Number(fila.querySelector('.segmento-velocidad').value);
    const original = Number(fila.dataset.speedOriginal);
    const sinCambio = Number.isFinite(original) && Number.isFinite(mostrada) && Math.abs(mostrada - original) < 5e-3;
    segments.push(sinCambio ? { index, speed: original } : { index, speed: mostrada });
  }
  return segments;
}

/**
 * Comprueba la selección antes de enviarla, para dar un mensaje claro en la
 * interfaz en vez de esperar al error del backend.
 */
export function validateSelection(segments) {
  if (!segments.length) return 'Deja al menos un trozo incluido.';
  for (const s of segments) {
    if (!Number.isFinite(s.speed)) return `El trozo ${s.index + 1} tiene una velocidad vacía o no numérica.`;
    if (s.speed < SPEED_LIMITS.min || s.speed > SPEED_LIMITS.max) {
      return `La velocidad del trozo ${s.index + 1} debe estar entre ${SPEED_LIMITS.min}× y ${SPEED_LIMITS.max}×.`;
    }
  }
  return null;
}

/** ¿Difiere la selección de lo que hay en la propuesta guardada? */
export function hasChanges(segments, proposal) {
  if (!proposal?.segments) return false;
  if (segments.length !== proposal.segments.length) return true;
  return segments.some((s, i) => s.index !== i || Math.abs(s.speed - proposal.segments[i].speed) > 5e-3);
}
