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

/** Opciones del texto destacado. Mismo vocabulario que core/on-screen-text.js. */
export const POSICIONES_DESTACADO = [
  ['top', 'Arriba del todo'],
  ['upper-third', 'Tercio superior'],
  ['center', 'Centro'],
  ['lower-third', 'Tercio inferior'],
  ['bottom', 'Abajo'],
];
export const TAMANOS_DESTACADO = [
  ['small', 'Pequeño'],
  ['medium', 'Mediano'],
  ['large', 'Grande'],
  ['xlarge', 'Enorme'],
];
export const FONDOS_DESTACADO = [
  ['box', 'Caja semitransparente'],
  ['outline', 'Sólo contorno'],
  ['none', 'Sin fondo ni contorno'],
];
export const ANIMACIONES_DESTACADO = [
  ['fade', 'Aparece suave'],
  ['slide-up', 'Sube al entrar'],
  ['pop', 'Entrada seca'],
  ['none', 'Sin animación'],
];

/** Máximo de palabras de un texto destacado. Coincide con el backend. */
export const PALABRAS_DESTACADO_MAX = 8;

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

function seleccion(etiqueta, clase, opciones, valor) {
  const label = el('label', null, etiqueta);
  const select = document.createElement('select');
  select.className = clase;
  for (const [v, t] of opciones) {
    const o = document.createElement('option');
    o.value = v; o.textContent = t;
    select.append(o);
  }
  select.value = valor;
  label.append(select);
  return { label, select };
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
 * Bloque «Agregar texto destacado sobre la imagen» de una tarjeta de escena.
 *
 * Al apagarlo la escena conserva imagen, narración y subtítulos: lo único que
 * desaparece es el rótulo. Por eso el texto escrito NO se borra al desactivar,
 * sólo se oculta el panel.
 */
function bloqueDestacado(e, alCambiar) {
  const caja = el('details', 'escena-destacado');
  const activo = Boolean(e.showOnScreenText && String(e.onScreenTitle || '').trim());
  caja.open = activo;

  const resumen = el('summary');
  const casilla = document.createElement('input');
  casilla.type = 'checkbox';
  casilla.className = 'escena-destacado-on';
  casilla.checked = activo;
  const etiqueta = el('span', null, 'Agregar texto destacado sobre la imagen');
  const estado = el('span', 'mini escena-destacado-estado');
  resumen.append(casilla, etiqueta, estado);
  caja.append(resumen);

  const panel = el('div', 'escena-destacado-panel');

  const titulo = campo({
    etiqueta: `Texto (2–${PALABRAS_DESTACADO_MAX} palabras)`,
    valor: e.onScreenTitle, clase: 'escena-titulo', extra: { maxLength: 60 },
  });
  panel.append(titulo.label);

  const estilo = e.onScreenStyle || {};
  const rejilla = el('div', 'escena-destacado-rejilla');
  const pos = seleccion('Posición', 'escena-destacado-pos', POSICIONES_DESTACADO, e.onScreenPosition || 'upper-third');
  const size = seleccion('Tamaño', 'escena-destacado-size', TAMANOS_DESTACADO, estilo.size || 'large');
  const bg = seleccion('Fondo', 'escena-destacado-bg', FONDOS_DESTACADO, estilo.background || 'box');
  const anim = seleccion('Entrada', 'escena-destacado-anim', ANIMACIONES_DESTACADO, e.onScreenAnimation || 'fade');
  const color = campo({ etiqueta: 'Color', valor: estilo.color || '#ffffff', clase: 'escena-destacado-color', tipo: 'color' });
  rejilla.append(pos.label, size.label, bg.label, anim.label, color.label);
  panel.append(rejilla);

  // VISTA PREVIA: un rectángulo con la proporción del video y el rótulo
  // dibujado donde caería. No es el render, pero sí el sitio y el aspecto.
  const previa = el('div', 'escena-previa');
  const rotulo = el('span', 'escena-previa-rotulo');
  const franja = el('span', 'escena-previa-subtitulo', 'subtítulos');
  previa.append(rotulo, franja);
  panel.append(el('span', 'mini', 'Vista previa'), previa);

  const aviso = el('p', 'mini escena-destacado-aviso');
  panel.append(aviso);
  caja.append(panel);

  const refrescar = () => {
    const encendido = casilla.checked;
    panel.hidden = !encendido;
    const texto = titulo.input.value.trim();
    const palabras = texto ? texto.split(/\s+/).length : 0;

    estado.textContent = encendido
      ? (texto ? `· ${palabras} palabra${palabras === 1 ? '' : 's'}` : '· sin texto todavía')
      : '· desactivado';

    // Aviso, no bloqueo: el backend acorta a ocho palabras de todos modos.
    aviso.textContent = !encendido || !texto
      ? ''
      : palabras > PALABRAS_DESTACADO_MAX
        ? `Son ${palabras} palabras: al producir se recortará a ${PALABRAS_DESTACADO_MAX}. El subtítulo sigue llevando la narración entera.`
        : palabras < 2
          ? 'Con una sola palabra funciona, pero suele leerse mejor con dos o tres.'
          : '';

    rotulo.textContent = texto || 'Tu texto aquí';
    rotulo.dataset.vacio = texto ? 'no' : 'si';
    previa.dataset.pos = pos.select.value;
    previa.dataset.size = size.select.value;
    previa.dataset.bg = bg.select.value;
    rotulo.style.color = color.input.value;
    alCambiar?.();
  };

  // Escribir el rótulo a mano lo blinda: una propuesta automática posterior
  // ya no lo pisa.
  titulo.input.addEventListener('input', () => {
    const tarjeta = caja.closest('.escena');
    if (tarjeta) tarjeta.dataset.rotuloManual = 'si';
    refrescar();
  });
  for (const control of [casilla, pos.select, size.select, bg.select, anim.select, color.input]) {
    control.addEventListener('change', refrescar);
  }
  // `summary` alterna el desplegable al pulsar; sobre la casilla no debe.
  casilla.addEventListener('click', ev => {
    ev.stopPropagation();
    if (casilla.checked) caja.open = true;
  });

  refrescar();
  return { caja, refrescar };
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
    tarjeta.dataset.rotuloManual = e.onScreenTextManual ? 'si' : 'no';

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
    const visual = campo({ etiqueta: 'Qué se busca', valor: e.visualPrompt, clase: 'escena-visual', extra: { maxLength: 200 } });
    const duracion = campo({ etiqueta: 'Segundos', valor: e.duration, clase: 'escena-duracion', tipo: 'number', extra: { min: SCENE_SEGUNDOS.min, max: SCENE_SEGUNDOS.max, step: 0.5 } });
    fila.append(visual.label, duracion.label);
    campos.append(fila);

    // TEXTO DESTACADO. Es distinto del subtítulo: el subtítulo lleva TODA la
    // narración en todas las escenas; esto es un rótulo corto en unas pocas.
    const destacado = bloqueDestacado(e, () => onChange?.(readDraft(container)));
    campos.append(destacado.caja);

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

    for (const input of [narracion.input, visual.input, duracion.input]) {
      input.addEventListener('input', () => onChange?.(readDraft(container)));
    }
    container.append(tarjeta);
  });
}

/** Lee las escenas tal y como están en pantalla, conservando las excluidas. */
export function readDraft(container) {
  return [...container.querySelectorAll('.escena')].map(t => {
    const activo = t.querySelector('.escena-destacado-on').checked;
    const titulo = t.querySelector('.escena-titulo').value.trim();
    return {
      role: t.querySelector('.escena-rol').textContent,
      text: t.querySelector('.escena-text').value.trim(),
      // Los cinco campos del rótulo viajan siempre, también cuando está
      // apagado: apagarlo NO puede borrar lo que la usuaria escribió.
      showOnScreenText: activo && Boolean(titulo),
      onScreenTitle: titulo,
      onScreenPosition: t.querySelector('.escena-destacado-pos').value,
      onScreenAnimation: t.querySelector('.escena-destacado-anim').value,
      onScreenStyle: {
        size: t.querySelector('.escena-destacado-size').value,
        color: t.querySelector('.escena-destacado-color').value,
        background: t.querySelector('.escena-destacado-bg').value,
      },
      onScreenTextManual: t.dataset.rotuloManual === 'si',
      visualPrompt: t.querySelector('.escena-visual').value.trim(),
      duration: Number(t.querySelector('.escena-duracion').value),
      excluida: t.dataset.incluida === 'no',
    };
  });
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
