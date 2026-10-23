/**
 * Tarjetas de proyectos recientes de la pantalla de inicio.
 * Sólo vista: recibe la lista del backend y avisa por callback.
 */

const el = (tag, className, text) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
};

/** Estado del backend -> etiqueta en lenguaje común + tono de color. */
export const ESTADOS = {
  queued: { texto: 'En cola', tono: 'trabajo' },
  generating: { texto: 'Generando', tono: 'trabajo' },
  generated: { texto: 'Generando', tono: 'trabajo' },
  analyzing: { texto: 'Analizando', tono: 'trabajo' },
  editing: { texto: 'Preparando montaje', tono: 'trabajo' },
  completed: { texto: 'Listo', tono: 'ok' },
  exportado: { texto: 'Exportado', tono: 'ok' },
  aprobado: { texto: 'Aprobado', tono: 'ok' },
  borrador: { texto: 'Borrador', tono: 'neutro' },
  failed: { texto: 'Error', tono: 'error' },
  interrumpido: { texto: 'Recuperado', tono: 'aviso' },
};

export const etiquetaEstado = estado => ESTADOS[estado] || { texto: estado || 'Desconocido', tono: 'neutro' };

/** Fecha corta y legible; nunca una cadena ISO cruda en pantalla. */
export function fechaCorta(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('es', { day: '2-digit', month: 'short' }) +
    ' · ' + d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
}

/** Duración legible: segundos por debajo del minuto, m:ss por encima. */
export function duracionCorta(segundos) {
  const s = Number(segundos);
  if (!Number.isFinite(s) || s <= 0) return null;
  if (s < 60) return `${s.toFixed(0)} s`;
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')} min`;
}

/**
 * Dibuja la rejilla de proyectos. `onAbrir` recibe el proyecto para continuar
 * editándolo; `onVer` sólo abre su vista previa.
 */
export function renderProjects(container, proyectos, { onAbrir, onVer } = {}) {
  container.replaceChildren();

  if (!proyectos?.length) {
    const vacio = el('div', 'vacio');
    vacio.append(
      el('span', 'vacio-icono', '✦'),
      el('p', null, 'Todavía no has creado ningún video.'),
      el('p', 'ayuda', 'Empieza con «Crear video con IA» y aquí quedará guardado para retomarlo cuando quieras.'),
    );
    container.append(vacio);
    return;
  }

  for (const p of proyectos) {
    const estado = etiquetaEstado(p.estado);
    const tarjeta = el('article', 'proyecto');
    tarjeta.dataset.id = p.id;

    // MINIATURA. La imagen de la primera escena identifica el proyecto de un
    // vistazo, que es justo lo que no se podía hacer con doscientas tarjetas
    // iguales. Sin imagen se enseña el título: nunca un recuadro gris vacío.
    const mini = el('div', 'proyecto-mini');
    if (p.miniatura) {
      const img = document.createElement('img');
      img.src = p.miniatura;
      img.alt = '';
      img.loading = 'lazy';
      // Si el archivo ya no está, se cae al título en vez de dejar el icono roto.
      img.addEventListener('error', () => { img.remove(); mini.textContent = p.titulo.slice(0, 60); });
      mini.append(img);
    } else {
      mini.textContent = p.titulo.slice(0, 60);
    }
    tarjeta.append(mini);

    const cuerpo = el('div', 'proyecto-cuerpo');
    cuerpo.append(el('div', 'proyecto-titulo', p.titulo));

    const pill = el('span', 'pill', estado.texto);
    pill.dataset.tono = estado.tono;
    const linea = el('div', 'proyecto-datos');
    const partes = [
      p.formato,
      duracionCorta(p.duracionReal ?? (p.duracionPedida === 'auto' ? null : p.duracionPedida)),
      p.escenas ? `${p.escenas} escenas` : null,
      fechaCorta(p.creado),
    ].filter(Boolean);
    linea.textContent = partes.join(' · ');
    cuerpo.append(pill, linea);

    if (p.error) cuerpo.append(el('div', 'mini', p.error.slice(0, 120)));

    const acciones = el('div', 'proyecto-acciones');

    // EDITAR abre el editor visual sobre el proyecto guardado. Sólo aparece si
    // el proyecto llegó a existir en disco: sin escenas no hay nada que editar.
    if (p.projectId) {
      const editar = el('a', 'btn btn-mini btn-principal', 'Editar');
      editar.href = `/project-editor.html?id=${encodeURIComponent(p.projectId)}`;
      editar.title = 'Abrir el editor visual: escenas, textos, subtítulos y audio';
      acciones.append(editar);
    }

    const abrir = el('button', `btn btn-mini${p.projectId ? '' : ' btn-principal'}`, 'Continuar');
    abrir.addEventListener('click', () => onAbrir?.(p));
    acciones.append(abrir);

    if (p.analysisId) {
      const ver = el('button', 'btn btn-mini', 'Reproducir');
      ver.addEventListener('click', () => onVer?.(p));
      acciones.append(ver);
    }
    cuerpo.append(acciones);
    tarjeta.append(cuerpo);
    container.append(tarjeta);
  }
}
