/**
 * Tarjetas de escena del borrador. Sólo vista: dibuja los campos editables y
 * devuelve lo que la usuaria dejó escrito. No habla con la API.
 *
 * Clases CSS: ver editor.css, sección "TARJETAS DE ESCENA DEL BORRADOR".
 */

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function campo({ etiqueta, valor, clase, filas = 0, tipo = 'text', extra = {} }) {
  const label = el('label', null, etiqueta);
  const input = document.createElement(filas ? 'textarea' : 'input');
  if (filas) input.rows = filas; else input.type = tipo;
  input.className = clase;
  input.value = valor ?? '';
  Object.assign(input, extra);
  label.append(input);
  return { label, input };
}

/**
 * Dibuja una tarjeta por escena. `onChange` avisa de cualquier edición y
 * `onRegenerate` se dispara con el índice al pulsar «Regenerar escena».
 */
export function renderDraft(container, escenas, { onChange, onRegenerate } = {}) {
  container.replaceChildren();
  escenas.forEach((e, i) => {
    const tarjeta = el('div', 'escena');
    tarjeta.dataset.index = String(i);
    tarjeta.append(el('span', 'escena-numero', String(i + 1)));

    const campos = el('div', 'escena-campos');
    campos.append(el('span', 'escena-rol', e.role || 'escena'));

    const narracion = campo({ etiqueta: 'Narración (lo que se escucha)', valor: e.text, clase: 'escena-text', filas: 2 });
    campos.append(narracion.label);

    const fila = el('div', 'escena-fila');
    const titulo = campo({ etiqueta: 'Texto en pantalla', valor: e.onScreenTitle, clase: 'escena-titulo', extra: { maxLength: 60 } });
    const visual = campo({ etiqueta: 'Instrucción visual', valor: e.visualPrompt, clase: 'escena-visual', extra: { maxLength: 200 } });
    const duracion = campo({ etiqueta: 'Segundos', valor: e.duration, clase: 'escena-duracion', tipo: 'number', extra: { min: 0.5, max: 30, step: 0.5 } });

    const regenerar = el('button', 'btn btn-mini', 'Regenerar escena');
    regenerar.type = 'button';
    regenerar.addEventListener('click', () => onRegenerate?.(i));

    fila.append(titulo.label, visual.label, duracion.label, regenerar);
    campos.append(fila);
    tarjeta.append(campos);

    for (const input of [narracion.input, titulo.input, visual.input, duracion.input]) {
      input.addEventListener('input', () => onChange?.(readDraft(container)));
    }
    container.append(tarjeta);
  });
}

/** Lee las escenas tal y como están en pantalla. */
export function readDraft(container) {
  return [...container.querySelectorAll('.escena')].map(tarjeta => ({
    role: tarjeta.querySelector('.escena-rol').textContent,
    text: tarjeta.querySelector('.escena-text').value.trim(),
    onScreenTitle: tarjeta.querySelector('.escena-titulo').value.trim(),
    visualPrompt: tarjeta.querySelector('.escena-visual').value.trim(),
    duration: Number(tarjeta.querySelector('.escena-duracion').value),
  }));
}

/** Comprueba el borrador antes de producir, para avisar en la interfaz. */
export function validateDraft(escenas) {
  if (!escenas?.length) return 'El guion no tiene escenas.';
  for (const [i, e] of escenas.entries()) {
    if (!e.text) return `La escena ${i + 1} se quedó sin narración.`;
    if (!Number.isFinite(e.duration) || e.duration < 0.5 || e.duration > 30) {
      return `La duración de la escena ${i + 1} debe estar entre 0.5 y 30 segundos.`;
    }
  }
  return null;
}

/** Duración total estimada del borrador, en segundos. */
export const duracionTotal = escenas =>
  Number((escenas || []).reduce((a, e) => a + (Number(e.duration) || 0), 0).toFixed(2));
