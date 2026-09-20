/**
 * Tarjetas de escena del borrador. Sólo vista: dibuja los campos editables,
 * devuelve lo que la usuaria dejó escrito y avisa de las acciones por callback.
 *
 * Clases CSS: ver editor.css, sección "ESCENAS (GUION)".
 */

/**
 * Mismo rango que acepta el backend (`limits.js`). Una escena de una clase
 * puede durar bastante más que una de un reel, así que el tope no puede ser el
 * de un reel.
 */
export const SCENE_SEGUNDOS = { min: 0.5, max: 120 };

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

function boton(texto, titulo, alPulsar) {
  const b = el('button', 'btn btn-mini', texto);
  b.type = 'button';
  b.title = titulo;
  b.setAttribute('aria-label', titulo);
  b.addEventListener('click', alPulsar);
  return b;
}

/**
 * Dibuja una tarjeta por escena.
 *   onChange     -> cualquier edición de texto
 *   onRegenerate -> «Regenerar escena»
 *   onAccion     -> {tipo: 'duplicar'|'excluir'|'subir'|'bajar', indice}
 */
export function renderDraft(container, escenas, { onChange, onRegenerate, onAccion } = {}) {
  container.replaceChildren();

  escenas.forEach((e, i) => {
    const tarjeta = el('div', 'escena');
    tarjeta.dataset.index = String(i);
    tarjeta.dataset.incluida = e.excluida ? 'no' : 'si';

    // Miniatura: en el borrador aún no hay imagen (se busca al producir), así
    // que se muestra el número y el tipo de escena, que ya la identifican.
    const mini = el('div', 'escena-mini');
    mini.append(el('span', 'escena-num', String(i + 1)));
    if (e.imagen) {
      const img = document.createElement('img');
      img.src = e.imagen; img.alt = '';
      mini.append(img);
    } else {
      mini.append(el('span', 'mini', (e.role || 'escena').slice(0, 8)));
    }
    tarjeta.append(mini);

    const campos = el('div', 'escena-campos');
    campos.append(el('span', 'escena-rol', e.role || 'escena'));

    const narracion = campo({ etiqueta: 'Narración (lo que se escucha)', valor: e.text, clase: 'escena-text', filas: 2 });
    campos.append(narracion.label);

    const fila = el('div', 'escena-fila');
    const titulo = campo({ etiqueta: 'Texto en pantalla', valor: e.onScreenTitle, clase: 'escena-titulo', extra: { maxLength: 60 } });
    const visual = campo({ etiqueta: 'Qué se busca', valor: e.visualPrompt, clase: 'escena-visual', extra: { maxLength: 200 } });
    const duracion = campo({ etiqueta: 'Segundos', valor: e.duration, clase: 'escena-duracion', tipo: 'number', extra: { min: SCENE_SEGUNDOS.min, max: SCENE_SEGUNDOS.max, step: 0.5 } });
    fila.append(titulo.label, visual.label, duracion.label);
    campos.append(fila);

    if (e.fuente) campos.append(el('div', 'escena-fuente', `Imagen: ${e.fuente}`));

    // Acciones sobre la escena completa.
    const acciones = el('div', 'escena-botones');
    acciones.append(
      boton('Regenerar', 'Volver a proponer esta escena', () => onRegenerate?.(i)),
      boton('Duplicar', 'Crear una copia justo debajo', () => onAccion?.({ tipo: 'duplicar', indice: i })),
      boton(e.excluida ? 'Incluir' : 'Excluir', e.excluida ? 'Volver a incluir esta escena' : 'Dejar esta escena fuera del video',
        () => onAccion?.({ tipo: 'excluir', indice: i })),
      boton('↑', 'Subir esta escena', () => onAccion?.({ tipo: 'subir', indice: i })),
      boton('↓', 'Bajar esta escena', () => onAccion?.({ tipo: 'bajar', indice: i })),
    );
    if (i === 0) acciones.querySelector('button[aria-label="Subir esta escena"]').disabled = true;
    if (i === escenas.length - 1) acciones.querySelector('button[aria-label="Bajar esta escena"]').disabled = true;
    campos.append(acciones);

    tarjeta.append(campos);

    for (const input of [narracion.input, titulo.input, visual.input, duracion.input]) {
      input.addEventListener('input', () => onChange?.(readDraft(container)));
    }
    container.append(tarjeta);
  });
}

/** Lee las escenas tal y como están en pantalla, conservando las excluidas. */
export function readDraft(container) {
  return [...container.querySelectorAll('.escena')].map(t => ({
    role: t.querySelector('.escena-rol').textContent,
    text: t.querySelector('.escena-text').value.trim(),
    onScreenTitle: t.querySelector('.escena-titulo').value.trim(),
    visualPrompt: t.querySelector('.escena-visual').value.trim(),
    duration: Number(t.querySelector('.escena-duracion').value),
    excluida: t.dataset.incluida === 'no',
  }));
}

/** Escenas que realmente irán al video: las excluidas no se envían. */
export const escenasIncluidas = escenas => (escenas || []).filter(e => !e.excluida);

/**
 * Aplica duplicar / excluir / reordenar y devuelve la lista nueva.
 * Es una función pura: se puede probar sin navegador.
 */
export function aplicarAccion(escenas, { tipo, indice }) {
  const lista = escenas.map(e => ({ ...e }));
  if (indice < 0 || indice >= lista.length) return lista;

  if (tipo === 'duplicar') {
    const copia = { ...lista[indice], onScreenTitle: lista[indice].onScreenTitle };
    lista.splice(indice + 1, 0, copia);
  } else if (tipo === 'excluir') {
    lista[indice].excluida = !lista[indice].excluida;
  } else if (tipo === 'subir' && indice > 0) {
    [lista[indice - 1], lista[indice]] = [lista[indice], lista[indice - 1]];
  } else if (tipo === 'bajar' && indice < lista.length - 1) {
    [lista[indice], lista[indice + 1]] = [lista[indice + 1], lista[indice]];
  }
  return lista;
}

/** Comprueba el borrador antes de producir, para avisar en la interfaz. */
export function validateDraft(escenas) {
  const activas = escenasIncluidas(escenas);
  if (!activas.length) return 'Deja al menos una escena incluida.';
  for (const [i, e] of escenas.entries()) {
    if (e.excluida) continue;
    if (!e.text) return `La escena ${i + 1} se quedó sin narración.`;
    if (!Number.isFinite(e.duration) || e.duration < SCENE_SEGUNDOS.min || e.duration > SCENE_SEGUNDOS.max) {
      return `La duración de la escena ${i + 1} debe estar entre ${SCENE_SEGUNDOS.min} y ${SCENE_SEGUNDOS.max} segundos.`;
    }
  }
  return null;
}

/** Duración total estimada, contando sólo las escenas incluidas. */
export const duracionTotal = escenas =>
  Number(escenasIncluidas(escenas).reduce((a, e) => a + (Number(e.duration) || 0), 0).toFixed(2));
