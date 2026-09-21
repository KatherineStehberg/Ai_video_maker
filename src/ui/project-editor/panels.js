/**
 * PANELES CONTEXTUALES
 *
 * Una funcion por herramienta. Cada una dibuja SOLO su panel: nunca se enseñan
 * todos los formularios a la vez, que es lo que convierte un editor en una
 * lista interminable de campos.
 *
 * Todas reciben `{ s, acc }`:
 *   s    estado actual (ver state.js)
 *   acc  acciones que ofrece main.js (cambiar, seleccionar, regenerar…)
 *
 * Solo vista: aqui no se llama al backend ni se guarda nada.
 */

import { escenasVisibles, escenaActual, proyectoVisible, reloj } from './state.js';

const el = (tag, clase, texto) => {
  const n = document.createElement(tag);
  if (clase) n.className = clase;
  if (texto !== undefined) n.textContent = texto;
  return n;
};

function campo(etiqueta, control, pista) {
  const l = el('label', 'campo');
  l.append(el('span', null, etiqueta), control);
  if (pista) l.append(el('span', 'ayuda', pista));
  return l;
}

function entrada({ tipo = 'text', valor = '', ...extra } = {}) {
  const i = document.createElement('input');
  i.type = tipo;
  i.value = valor ?? '';
  Object.assign(i, extra);
  return i;
}

function area(valor, filas = 4) {
  const t = document.createElement('textarea');
  t.rows = filas;
  t.value = valor ?? '';
  return t;
}

function lista(opciones, valor) {
  const s = document.createElement('select');
  for (const o of opciones) {
    const [v, t] = Array.isArray(o) ? o : [o.id ?? o, o.label ?? o];
    const op = document.createElement('option');
    op.value = v; op.textContent = t;
    s.append(op);
  }
  s.value = valor;
  return s;
}

function boton(texto, clase, alPulsar, { deshabilitado = false, proximamente = false, titulo = '' } = {}) {
  const b = el('button', `btn ${clase || ''}${proximamente ? ' proximamente' : ''}`.trim(), texto);
  b.type = 'button';
  if (titulo) b.title = titulo;
  b.disabled = deshabilitado || proximamente;
  if (!b.disabled) b.addEventListener('click', alPulsar);
  return b;
}

const vacio = texto => el('p', 'vacio', texto);

// ==================================================================== ESCENAS

export function panelEscenas({ s, acc }) {
  const frag = document.createDocumentFragment();
  const escenas = escenasVisibles(s);
  if (!escenas.length) { frag.append(vacio('Este proyecto no tiene escenas.')); return frag; }

  const sel = s.escenaSel;

  for (const e of escenas) {
    const item = el('button', 'escena-item');
    item.type = 'button';
    item.dataset.index = String(e.index);
    item.dataset.excluida = e.excluida ? 'si' : 'no';
    if (e.index === sel) item.setAttribute('aria-current', 'true');

    const mini = el('div', 'escena-mini');
    if (e.recurso?.url && e.recurso.kind === 'image') {
      const img = document.createElement('img');
      img.src = e.recurso.url; img.alt = ''; img.loading = 'lazy';
      mini.append(img);
    } else {
      mini.append(el('span', 'mini', e.recurso?.kind === 'video' ? '▶' : '—'));
    }
    mini.append(el('span', 'num', String(e.numero)));

    const datos = el('div', 'escena-datos');
    datos.append(el('div', 'escena-tiempo', `${reloj(e.start)} · ${e.duration.toFixed(1)} s`));
    datos.append(el('div', 'escena-texto', e.text || '(sin narración)'));

    // Indicadores de un vistazo: voz, subtítulos, rótulo y avisos de recurso.
    const marcas = el('div', 'marcas');
    const marcar = (texto, tipo) => {
      const m = el('span', 'marca-ind', texto);
      if (tipo) m.dataset.tipo = tipo;
      marcas.append(m);
    };
    if (e.tieneNarracion) marcar('voz', 'voz');
    if (e.tieneSubtitulos) marcar('subs', 'subs');
    if (e.tieneTextoDestacado) marcar('rótulo', 'texto');
    if (e.faltaRecurso) marcar('falta imagen', 'falta');
    else if (e.recurso?.estado === 'fallback') marcar('fondo', 'fallback');
    if (e.excluida) marcar('excluida');
    datos.append(marcas);

    item.append(mini, datos);
    item.addEventListener('click', () => acc.seleccionar(e.index));
    frag.append(item);
  }

  // ---- configuración de la escena seleccionada ----
  const e = escenaActual(s);
  if (!e) return frag;

  const caja = el('div', 'bloque');
  caja.append(el('h3', null, `Escena ${e.numero}`));

  const narr = area(e.text, 3);
  narr.addEventListener('input', () => acc.cambiarEscena(e.id, 'text', narr.value));
  caja.append(campo('Narración (lo que se escucha)', narr));

  const dur = entrada({ tipo: 'number', valor: e.duration, min: 0.5, max: 300, step: 0.1 });
  dur.addEventListener('change', () => acc.cambiarEscena(e.id, 'duration', Number(dur.value)));

  const prompt = entrada({ valor: e.visualPrompt, maxLength: 300 });
  prompt.addEventListener('input', () => acc.cambiarEscena(e.id, 'visualPrompt', prompt.value));

  const rej = el('div', 'rejilla-2');
  rej.append(campo('Duración (s)', dur), campo('Qué imagen buscar', prompt));
  caja.append(rej);

  const incluir = entrada({ tipo: 'checkbox' });
  incluir.checked = !e.excluida;
  incluir.addEventListener('change', () => acc.cambiarEscena(e.id, 'excluida', !incluir.checked));
  const lblIncluir = el('label', 'casilla');
  lblIncluir.append(incluir, document.createTextNode('Incluir esta escena en el video'));
  caja.append(lblIncluir);

  const rotOn = entrada({ tipo: 'checkbox' });
  rotOn.checked = Boolean(e.showOnScreenText);
  rotOn.addEventListener('change', () => acc.cambiarEscena(e.id, 'showOnScreenText', rotOn.checked));
  const lblRot = el('label', 'casilla');
  lblRot.append(rotOn, document.createTextNode('Texto destacado sobre la imagen'));
  caja.append(lblRot);
  caja.append(el('p', 'ayuda', 'El rótulo se edita en la herramienta Texto. Los subtítulos llevan la narración completa en todas las escenas.'));

  const acciones = el('div', 'fila');
  acciones.append(
    boton('Regenerar imagen', 'btn-mini', () => acc.regenerar(e.index, { visual: true, voz: false }), { deshabilitado: s.trabajando }),
    boton('Regenerar voz', 'btn-mini', () => acc.regenerar(e.index, { visual: false, voz: true }), { deshabilitado: s.trabajando }),
  );
  caja.append(acciones);

  const noListas = el('div', 'fila');
  const motivo = 'Todavía no se puede guardar esta operación.';
  noListas.append(
    boton('Duplicar', 'btn-mini', null, { proximamente: true, titulo: motivo }),
    boton('Dividir', 'btn-mini', null, { proximamente: true, titulo: motivo }),
    boton('Reordenar', 'btn-mini', null, { proximamente: true, titulo: motivo }),
  );
  caja.append(noListas);

  frag.append(caja);
  return frag;
}

// ====================================================================== GUION

export function panelGuion({ s, acc }) {
  const frag = document.createDocumentFragment();
  const escenas = escenasVisibles(s);
  if (!escenas.length) { frag.append(vacio('Sin guion todavía.')); return frag; }

  const buscar = entrada({ tipo: 'search', valor: s.busquedaGuion || '', placeholder: 'Buscar en el guion…' });
  buscar.addEventListener('input', () => acc.buscarGuion(buscar.value));
  frag.append(campo('Buscar', buscar));

  const q = (s.busquedaGuion || '').trim().toLowerCase();
  const total = escenas.reduce((a, e) => a + (e.excluida ? 0 : e.duration), 0);
  const palabras = escenas.reduce((a, e) => a + String(e.text || '').trim().split(/\s+/).filter(Boolean).length, 0);
  frag.append(el('p', 'ayuda', `${palabras} palabras · ${escenas.length} escenas · dura unos ${reloj(total)}.`));

  const visibles = q ? escenas.filter(e => String(e.text || '').toLowerCase().includes(q)) : escenas;
  if (!visibles.length) { frag.append(vacio(`Ninguna escena contiene "${q}".`)); return frag; }

  for (const e of visibles) {
    const caja = el('div', 'bloque');
    const cab = el('div', 'fila');
    const ir = boton(`Escena ${e.numero}`, 'btn-mini', () => acc.seleccionar(e.index));
    if (e.index === s.escenaSel) ir.setAttribute('aria-current', 'true');
    cab.append(ir, el('span', 'mini', `${reloj(e.start)} · ${e.duration.toFixed(1)} s`));
    if (e.excluida) cab.append(el('span', 'pill', 'excluida'));
    caja.append(cab);

    const t = area(e.text, 3);
    t.addEventListener('input', () => acc.cambiarEscena(e.id, 'text', t.value));
    t.addEventListener('focus', () => acc.seleccionar(e.index));
    caja.append(t);
    frag.append(caja);
  }
  return frag;
}

// ====================================================================== TEXTO

export function panelTexto({ s, acc }) {
  const frag = document.createDocumentFragment();
  const e = escenaActual(s);
  if (!e) { frag.append(vacio('Selecciona una escena.')); return frag; }

  const cfg = s.capacidades?.onScreen || {};
  const resumen = s.derivado?.textoDestacado;

  frag.append(el('p', 'ayuda',
    'El texto destacado es un rótulo corto en unas pocas escenas. Los subtítulos, que llevan '
    + 'toda la narración, se ajustan en la herramienta Subtítulos.'));
  if (resumen) {
    frag.append(el('p', 'mini', `Ahora hay rótulo en ${resumen.conDestacado} de ${resumen.total} escenas.`));
  }

  const caja = el('div', 'bloque');
  caja.append(el('h3', null, `Rótulo de la escena ${e.numero}`));

  const on = entrada({ tipo: 'checkbox' });
  on.checked = Boolean(e.showOnScreenText);
  on.addEventListener('change', () => acc.cambiarEscena(e.id, 'showOnScreenText', on.checked));
  const lbl = el('label', 'casilla');
  lbl.append(on, document.createTextNode('Mostrar texto destacado en esta escena'));
  caja.append(lbl);

  const texto = entrada({ valor: e.onScreenTitle, maxLength: 60 });
  texto.addEventListener('input', () => acc.cambiarEscena(e.id, 'onScreenTitle', texto.value));
  const palabras = String(e.onScreenTitle || '').trim().split(/\s+/).filter(Boolean).length;
  const max = cfg.maxWords ?? 8;
  caja.append(campo(
    `Texto (2–${max} palabras)`, texto,
    palabras > max
      ? `Son ${palabras} palabras: al producir se recortará a ${max}. El subtítulo sigue llevando la narración entera.`
      : `${palabras || 'sin'} ${palabras === 1 ? 'palabra' : 'palabras'}.`,
  ));

  const estilo = e.onScreenStyle || {};
  const rej = el('div', 'rejilla-2');

  const pos = lista((cfg.positions || []).map(p => [p, {
    top: 'Arriba', 'upper-third': 'Tercio superior', center: 'Centro',
    'lower-third': 'Tercio inferior', bottom: 'Abajo',
  }[p] || p]), e.onScreenPosition);
  pos.addEventListener('change', () => acc.cambiarEscena(e.id, 'onScreenPosition', pos.value));

  const tam = lista((cfg.sizes || []).map(t => [t, { small: 'Pequeño', medium: 'Mediano', large: 'Grande', xlarge: 'Enorme' }[t] || t]), estilo.size || 'large');
  tam.addEventListener('change', () => acc.cambiarEscenaEstilo(e, 'size', tam.value));

  const fondo = lista((cfg.backgrounds || []).map(b => [b, { none: 'Sin fondo', outline: 'Contorno', box: 'Caja' }[b] || b]), estilo.background || 'box');
  fondo.addEventListener('change', () => acc.cambiarEscenaEstilo(e, 'background', fondo.value));

  const anim = lista((cfg.animations || []).map(a => [a, { none: 'Sin animación', fade: 'Aparece suave', 'slide-up': 'Sube al entrar', pop: 'Entrada seca' }[a] || a]), e.onScreenAnimation);
  anim.addEventListener('change', () => acc.cambiarEscena(e.id, 'onScreenAnimation', anim.value));

  const color = entrada({ tipo: 'color', valor: estilo.color || '#ffffff' });
  color.addEventListener('change', () => acc.cambiarEscenaEstilo(e, 'color', color.value));

  rej.append(campo('Posición', pos), campo('Tamaño', tam), campo('Fondo', fondo), campo('Entrada', anim), campo('Color', color));
  caja.append(rej);
  caja.append(el('p', 'ayuda', 'La vista previa del centro muestra dónde queda. Nunca se coloca encima de los subtítulos.'));
  frag.append(caja);
  return frag;
}

// =================================================================== RECURSOS

export function panelRecursos({ s, acc }) {
  const frag = document.createDocumentFragment();
  const e = escenaActual(s);
  if (!e) { frag.append(vacio('Selecciona una escena.')); return frag; }

  const r = e.recurso || {};
  const ETIQ = {
    listo: ['ok', 'Listo'],
    fallback: ['aviso', 'Fondo de marca'],
    falta: ['error', 'Falta la imagen'],
    error: ['error', 'El archivo no está'],
  };
  const [tono, etiqueta] = ETIQ[r.estado] || ['', r.estado || '—'];

  const caja = el('div', 'bloque');
  const cab = el('div', 'fila');
  cab.append(el('h3', null, `Recurso de la escena ${e.numero}`));
  const pill = el('span', 'pill', etiqueta);
  pill.dataset.tono = tono;
  cab.append(pill);
  caja.append(cab);

  if (r.url && r.kind === 'image') {
    const img = document.createElement('img');
    img.src = r.url; img.alt = ''; img.style.width = '100%'; img.style.borderRadius = '6px';
    caja.append(img);
  } else if (r.url && r.kind === 'video') {
    const v = document.createElement('video');
    v.src = r.url; v.controls = true; v.preload = 'metadata'; v.style.width = '100%'; v.style.borderRadius = '6px';
    caja.append(v);
  } else {
    caja.append(vacio('Esta escena se renderizará con un fondo plano de marca.'));
  }

  if (r.proveedor) caja.append(el('p', 'mini', `Origen: ${r.proveedor}`));

  const prompt = entrada({ valor: e.visualPrompt, maxLength: 300 });
  prompt.addEventListener('input', () => acc.cambiarEscena(e.id, 'visualPrompt', prompt.value));
  caja.append(campo('Qué buscar', prompt, 'Cambia el texto y vuelve a buscar para obtener otra imagen.'));

  const acciones = el('div', 'fila');
  acciones.append(
    boton('Buscar otra imagen', 'btn-mini', () => acc.regenerar(e.index, { visual: true, voz: false }), { deshabilitado: s.trabajando }),
    boton('Quitar imagen', 'btn-mini', () => acc.cambiarEscena(e.id, 'assetPath', null), { deshabilitado: !r.path }),
  );
  caja.append(acciones);

  // Subir un archivo propio: el endpoint de importación del estudio ya existe
  // y valida el tipo y la autorización, así que se reutiliza tal cual.
  const subir = entrada({ tipo: 'file', accept: 'image/*,video/*' });
  subir.addEventListener('change', () => { if (subir.files[0]) acc.subirRecurso(e, subir.files[0]); });
  caja.append(campo('Usar un archivo mío', subir, 'Se guarda una copia local. Declara que tienes permiso para usarlo.'));

  frag.append(caja);
  return frag;
}

// =============================================================== TRANSICIONES

export function panelTransiciones({ s, acc }) {
  const frag = document.createDocumentFragment();
  const e = escenaActual(s);
  if (!e) { frag.append(vacio('Selecciona una escena.')); return frag; }

  frag.append(el('p', 'ayuda',
    'El montaje aplica un fundido de entrada y salida por clip. Los deslizamientos y '
    + 'barridos no están implementados en el render, así que no se ofrecen: se verían como un fundido.'));

  const caja = el('div', 'bloque');
  caja.append(el('h3', null, `Escena ${e.numero}`));

  const tr = lista(s.capacidades?.transiciones || [{ id: 'none', label: 'Sin transición' }], e.transition);
  tr.addEventListener('change', () => acc.cambiarEscena(e.id, 'transition', tr.value));
  caja.append(campo('Transición', tr));

  const mv = lista(s.capacidades?.movimientos || [{ id: 'none', label: 'Sin movimiento' }], e.kenBurns);
  mv.addEventListener('change', () => acc.cambiarEscena(e.id, 'kenBurns', mv.value));
  caja.append(campo('Movimiento de la imagen', mv, 'Acercar o alejar lentamente sobre una imagen fija.'));

  frag.append(caja);
  return frag;
}

// ====================================================================== AUDIO

export function panelAudio({ s, acc }) {
  const frag = document.createDocumentFragment();
  const p = proyectoVisible(s);
  if (!p) return frag;

  // ---- narración ----
  const voz = el('div', 'bloque');
  voz.append(el('h3', null, 'Narración'));
  const conVoz = s.derivado?.pistas?.narracion || 0;
  voz.append(el('p', 'mini', conVoz
    ? `${conVoz} escenas con voz generada · ${p.voice?.name || 'voz local'}`
    : 'Todavía no hay voz generada.'));

  const gan = entrada({ tipo: 'range', min: 0, max: 2, step: 0.05, valor: p.voice?.gain ?? 1 });
  const ganTexto = el('span', 'mini', `${Math.round((p.voice?.gain ?? 1) * 100)} %`);
  gan.addEventListener('input', () => { ganTexto.textContent = `${Math.round(gan.value * 100)} %`; });
  gan.addEventListener('change', () => acc.cambiar('voice.gain', Number(gan.value)));
  voz.append(campo('Volumen de la narración', gan, 'Se aplica al mezclar el audio: no hace falta regenerar la voz.'));
  voz.append(ganTexto);

  const mudo = entrada({ tipo: 'checkbox' });
  mudo.checked = p.voice?.enabled === false;
  mudo.addEventListener('change', () => acc.cambiar('voice.enabled', !mudo.checked));
  const lblMudo = el('label', 'casilla');
  lblMudo.append(mudo, document.createTextNode('Silenciar la narración en el video'));
  voz.append(lblMudo);
  frag.append(voz);

  // ---- música ----
  const mus = el('div', 'bloque');
  mus.append(el('h3', null, 'Música'));
  if (p.music?.path) {
    mus.append(el('p', 'mini', p.music.path.split('/').pop()));
    const a = document.createElement('audio');
    a.src = `/file?path=${encodeURIComponent(p.music.path)}`;
    a.controls = true; a.preload = 'none'; a.style.width = '100%';
    mus.append(a);

    const volM = entrada({ tipo: 'range', min: 0, max: 1, step: 0.01, valor: p.music.volume ?? 0.12 });
    const volTexto = el('span', 'mini', `${Math.round((p.music.volume ?? 0.12) * 100)} %`);
    volM.addEventListener('input', () => { volTexto.textContent = `${Math.round(volM.value * 100)} %`; });
    volM.addEventListener('change', () => acc.cambiar('music.volume', Number(volM.value)));
    mus.append(campo('Volumen de la música', volM));
    mus.append(volTexto);

    const usar = entrada({ tipo: 'checkbox' });
    usar.checked = Boolean(p.music.enabled);
    usar.addEventListener('change', () => acc.cambiar('music.enabled', usar.checked));
    const lblUsar = el('label', 'casilla');
    lblUsar.append(usar, document.createTextNode('Incluir la música en el video'));
    mus.append(lblUsar);
  } else {
    mus.append(vacio('Este proyecto no tiene música.'));
  }
  const subirM = entrada({ tipo: 'file', accept: 'audio/*' });
  subirM.addEventListener('change', () => { if (subirM.files[0]) acc.subirMusica(subirM.files[0]); });
  mus.append(campo('Usar una pista mía', subirM, 'Se guarda una copia local. Declara que tienes permiso para usarla.'));
  frag.append(mus);

  // ---- efectos ----
  const fx = el('div', 'bloque');
  fx.append(el('h3', null, 'Efectos de sonido'));
  fx.append(el('p', 'ayuda', s.capacidades?.pendiente?.efectos || 'No hay pista de efectos de sonido.'));
  frag.append(fx);

  return frag;
}

// ================================================================= SUBTITULOS

export function panelSubtitulos({ s, acc }) {
  const frag = document.createDocumentFragment();
  const p = proyectoVisible(s);
  if (!p) return frag;

  const cfg = s.capacidades?.captionStyle || {};
  const estilo = p.captions?.style || {};
  const m = s.derivado?.subtitulos?.metrica;
  const cob = s.derivado?.subtitulos?.cobertura;

  const on = entrada({ tipo: 'checkbox' });
  on.checked = p.captions?.enabled !== false;
  on.addEventListener('change', () => acc.cambiar('captions.enabled', on.checked));
  const lbl = el('label', 'casilla');
  lbl.append(on, document.createTextNode('Subtitular todo el video'));
  frag.append(lbl);

  if (p.captions?.enabled === false) {
    frag.append(el('p', 'ayuda', 'Sin subtítulos: no aparecerá ningún texto de narración en el video.'));
    return frag;
  }

  if (cob) {
    const aviso = el('p', cob.ok ? 'mini' : 'aviso aviso-atencion',
      cob.ok
        ? `Cobertura ${cob.porcentaje} %: toda la narración queda subtitulada.`
        : `Cobertura ${cob.porcentaje} %. ${cob.problemas[0] || ''}`);
    frag.append(aviso);
  }

  // ---- presets ----
  const presets = el('div', 'fila');
  for (const pr of cfg.presets || []) {
    const b = boton(pr.label, 'btn-mini', () => acc.aplicarPreset(pr));
    b.title = pr.description || '';
    b.setAttribute('aria-pressed', String(estilo.preset === pr.id));
    if (estilo.preset === pr.id) b.classList.add('btn-principal');
    presets.append(b);
  }
  frag.append(campo('Presets', presets));
  const desc = (cfg.presets || []).find(x => x.id === estilo.preset)?.description;
  if (desc) frag.append(el('p', 'ayuda', desc));

  const rej = el('div', 'rejilla-2');
  const bind = (control, ruta, transformar = v => v) => {
    control.addEventListener('change', () => acc.cambiar(`captions.style.${ruta}`, transformar(control.value)));
    return control;
  };

  rej.append(campo('Tipografía', bind(lista((cfg.fonts || []).map(f => [f.id, f.label]), estilo.fontFamily || 'Arial'), 'fontFamily')));
  rej.append(campo('Tamaño', bind(lista([['0.85', 'Más pequeño'], ['1', 'Normal'], ['1.15', 'Más grande'], ['1.3', 'Muy grande']], String(estilo.fontScale ?? 1)), 'fontScale', Number)));
  rej.append(campo('Color', bind(entrada({ tipo: 'color', valor: estilo.color || '#ffffff' }), 'color')));
  rej.append(campo('Fondo', bind(lista([['outline', 'Contorno oscuro'], ['box', 'Caja semitransparente'], ['none', 'Sin fondo']], estilo.background || 'outline'), 'background')));
  rej.append(campo('Color del fondo', bind(entrada({ tipo: 'color', valor: estilo.backgroundColor || '#000000' }), 'backgroundColor')));
  rej.append(campo('Opacidad del fondo', bind(entrada({ tipo: 'range', min: 0, max: 1, step: 0.05, valor: estilo.backgroundOpacity ?? 0 }), 'backgroundOpacity', Number)));
  rej.append(campo('Contorno', bind(entrada({ tipo: 'range', min: 0, max: 2.5, step: 0.05, valor: estilo.outlineScale ?? 1 }), 'outlineScale', Number)));
  rej.append(campo('Posición', bind(lista([['bottom', 'Abajo (zona segura)'], ['center', 'Centro'], ['top', 'Arriba']], estilo.position || 'bottom'), 'position')));
  rej.append(campo('Alineación', bind(lista([['center', 'Centrado'], ['left', 'Izquierda'], ['right', 'Derecha']], estilo.alignment || 'center'), 'alignment')));
  frag.append(rej);

  const margen = entrada({ tipo: 'range', min: 0, max: 0.4, step: 0.01, valor: estilo.marginVPct ?? (m ? m.marginV / (s.derivado?.dimensiones?.height || 1920) : 0.18) });
  margen.addEventListener('change', () => acc.cambiar('captions.style.marginVPct', Number(margen.value)));
  frag.append(campo('Margen desde el borde', margen, 'Nunca baja de la zona segura del formato, aunque se pida menos.'));

  if (m) {
    frag.append(el('p', 'mini',
      `En ${p.aspectRatio} la letra medirá ${m.fontSize} px, ${m.maxLines} líneas como máximo, `
      + `${m.maxCharsPerLine} caracteres por línea, a ${m.marginV} px del borde.`));
  }

  const zonas = entrada({ tipo: 'checkbox' });
  zonas.checked = s.zonasSeguras;
  zonas.addEventListener('change', () => acc.zonasSeguras(zonas.checked));
  const lblZ = el('label', 'casilla');
  lblZ.append(zonas, document.createTextNode('Ver zonas seguras en la vista previa'));
  frag.append(lblZ);

  return frag;
}

// ====================================================================== MARCA

export function panelMarca({ s, acc }) {
  const frag = document.createDocumentFragment();
  const p = proyectoVisible(s);
  if (!p) return frag;

  const caja = el('div', 'bloque');
  caja.append(el('h3', null, 'Proyecto'));

  const titulo = entrada({ valor: p.title, maxLength: 120 });
  titulo.addEventListener('input', () => acc.cambiar('title', titulo.value));
  caja.append(campo('Nombre', titulo));

  const formato = lista(Object.entries(s.capacidades?.aspects || {}).map(([id, a]) => [id, `${id} · ${a.label}`]), p.aspectRatio);
  formato.addEventListener('change', () => acc.cambiarFormato(formato.value));
  caja.append(campo('Formato', formato));

  const marca = lista((s.capacidades?.brands || []).map(b => [b.id, b.name]), p.brand);
  marca.addEventListener('change', () => acc.cambiar('brand', marca.value));
  caja.append(campo('Marca', marca, 'Define los colores del fondo generado, la tipografía y el logo.'));

  const cta = entrada({ valor: p.cta || '', maxLength: 200 });
  cta.addEventListener('input', () => acc.cambiar('cta', cta.value));
  caja.append(campo('Llamada a la acción del cierre', cta, 'Se dibuja en los últimos segundos del video.'));
  frag.append(caja);

  const logo = el('div', 'bloque');
  logo.append(el('h3', null, 'Logo'));
  if (p.assets?.logo) {
    const img = document.createElement('img');
    img.src = `/file?path=${encodeURIComponent(p.assets.logo)}`;
    img.alt = ''; img.style.maxWidth = '100%'; img.style.borderRadius = '6px';
    logo.append(img);
    logo.append(el('p', 'mini', 'Se superpone en el vídeo final.'));
  } else {
    logo.append(el('p', 'ayuda', 'Este proyecto usa el logo de la marca seleccionada, si la marca tiene uno. Subir un logo propio desde aquí todavía no está disponible.'));
  }
  frag.append(logo);

  const alm = s.capacidades?.almacenamiento;
  if (alm) {
    const caja2 = el('div', 'bloque');
    caja2.append(el('h3', null, 'Dónde se guarda'));
    caja2.append(el('p', 'mini', `${alm.label}: ${alm.proyectos}/${p.id}.json`));
    caja2.append(el('p', 'ayuda', 'Todo se guarda en este equipo. Escritura atómica: un corte a mitad no corrompe el proyecto.'));
    frag.append(caja2);
  }
  return frag;
}

export const PANELES = {
  escenas: { titulo: 'Escenas', render: panelEscenas },
  guion: { titulo: 'Guion', render: panelGuion },
  texto: { titulo: 'Texto destacado', render: panelTexto },
  recursos: { titulo: 'Recursos', render: panelRecursos },
  transiciones: { titulo: 'Transiciones', render: panelTransiciones },
  audio: { titulo: 'Audio', render: panelAudio },
  subtitulos: { titulo: 'Subtítulos', render: panelSubtitulos },
  marca: { titulo: 'Marca y configuración', render: panelMarca },
};
