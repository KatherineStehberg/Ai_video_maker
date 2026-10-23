/**
 * EDITOR VISUAL · orquestador
 *
 * Une estado, API y vistas. Aqui NO hay reglas de negocio: los tamanos de
 * subtitulo, los tiempos de escena y que se puede o no se puede hacer los
 * decide el backend y viajan en `derivado` y `capacidades`.
 *
 *   state.js     que hay editado y sin guardar (sin DOM)
 *   api.js       todo lo que habla con el backend
 *   panels.js    un panel por herramienta
 *   preview.js   composicion de la vista previa
 *   timeline.js  pistas, regla y cabezal
 *   main.js      este archivo: solo coordina
 */

import { api, sondear, ApiError } from './api.js';
import {
  estadoInicial, cambiar, cambiarEscena, deshacer, rehacer, puedeDeshacer, puedeRehacer,
  haycambios, cuerpoGuardado, confirmarGuardado, proyectoVisible, escenasVisibles,
  escenaActual, escenaEn, reloj,
} from './state.js';
import { PANELES } from './panels.js';
import { crearPreview } from './preview.js';
import { crearTimeline, zoomQueEncaja } from './timeline.js';
import { crearAudio, avisoAudio } from './audio.js';

const $ = id => document.getElementById(id);

let s = estadoInicial();
let sondeo = null;
let reloj_ = null;

const preview = crearPreview({
  marco: $('marco'), img: $('marco-img'), video: $('marco-video'), vacioEl: $('marco-vacio'),
  rotulo: $('rotulo'), subtitulo: $('subtitulo'),
  zonaArriba: $('zona-arriba'), zonaAbajo: $('zona-abajo'),
});

const audio = crearAudio({ voz: $('audio-voz'), musica: $('audio-musica'), video: $('marco-video') });
// Acceso de diagnostico: permite comprobar desde las herramientas del
// navegador (y desde las pruebas) si de verdad sale sonido. No cambia nada.
window.__audioEditor = audio;

const timeline = crearTimeline({
  nombres: $('tl-nombres'), pistas: $('tl-pistas'), regla: $('tl-regla'),
  cabezal: $('tl-cabezal'), scroll: $('tl-scroll'), lienzo: $('tl-lienzo'),
  onSeleccionar: i => acc.seleccionar(i),
  onMover: t => { pausar(); s = { ...s, tiempo: t }; sincronizarEscenaConTiempo(); pintar(); },
});

// ------------------------------------------------------------- ACCIONES

const acc = {
  cambiar(camino, valor) { s = cambiar(s, camino, valor); pintar(); },

  cambiarEscena(id, campo, valor) { s = cambiarEscena(s, id, campo, valor); pintar(); },

  /** Estilo del rótulo: se manda el objeto entero porque el backend lo normaliza. */
  cambiarEscenaEstilo(escena, campo, valor) {
    s = cambiarEscena(s, escena.id, 'onScreenStyle', { ...(escena.onScreenStyle || {}), [campo]: valor });
    pintar();
  },

  seleccionar(index) {
    const escenas = escenasVisibles(s);
    const e = escenas[index];
    if (!e) return;
    // Seleccionar una escena mueve el cabezal a su comienzo: preview, panel y
    // línea de tiempo quedan mirando lo mismo.
    pausar();
    s = { ...s, escenaSel: index, tiempo: e.start };
    pintar();
    timeline.seguir(s);
  },

  herramienta(nombre) { s = { ...s, herramienta: nombre }; scrollPanel = 0; pintar(); },

  zonasSeguras(valor) { s = { ...s, zonasSeguras: valor }; $('zonas-seguras').checked = valor; pintar(); },

  buscarGuion(q) { s = { ...s, busquedaGuion: q }; pintarPanel(); },

  /**
   * El formato cambia la métrica de subtítulos y las zonas seguras, y ese
   * cálculo vive en el backend. Así que se guarda y se recarga: de otro modo
   * la vista previa mostraría el encuadre nuevo con las medidas del anterior.
   */
  async cambiarFormato(id) {
    s = cambiar(s, 'aspectRatio', id);
    pintar();
    if (await guardar()) { await recargar(); }
  },

  aplicarPreset(preset) {
    // Cambiar de preset REEMPLAZA el estilo: es lo que se espera de un preset.
    s = cambiar(s, 'captions.style', { preset: preset.id, ...(preset.style || {}) });
    pintar();
  },

  async regenerar(index, opciones) {
    if (s.trabajando) return;
    if (haycambios(s)) {
      const seguir = confirm('Hay cambios sin guardar. Se guardarán antes de regenerar. ¿Continuar?');
      if (!seguir) return;
      const ok = await guardar();
      if (!ok) return;
    }
    try {
      s = { ...s, trabajando: true, error: null };
      pintar();
      await api.regenerar(s.id, { index, ...opciones });
      await seguirTrabajo('Regenerando…');
    } catch (e) { fallo(e); }
  },

  // ----------------------------------------------------------- BIBLIOTECA
  // Lo que se escribe en un buscador se guarda sin repintar: repintar el panel
  // a cada tecla borraria el campo mientras se escribe.
  fijarConsulta(tipo, texto) {
    s = { ...s, biblioteca: { ...s.biblioteca, [tipo]: { ...(s.biblioteca?.[tipo] || {}), consulta: texto } } };
  },

  async buscarImagenes(consulta, pagina = 1) {
    const q = String(consulta || '').trim();
    const previa = s.biblioteca?.imagenes || {};
    fijarBiblioteca('imagenes', { consulta: q, estado: 'buscando', motivo: null, ...(pagina === 1 ? { resultados: [], seleccion: null } : {}) });
    try {
      const visible = proyectoVisible(s);
      const r = await api.buscarImagenes(q, visible?.aspectRatio || '9:16', pagina, visible?.language || 'es');
      const resultados = pagina > 1 ? [...(previa.resultados || []), ...r.resultados] : r.resultados;
      fijarBiblioteca('imagenes', { estado: 'listo', resultados, pagina, total: r.total || resultados.length, motivo: r.motivo || null, disponible: r.disponible });
    } catch (e) {
      fijarBiblioteca('imagenes', { estado: 'error', motivo: 'No se pudo buscar ahora. Prueba de nuevo en un momento.' });
      console.error(e);
    }
  },

  previsualizarImagen(foto) { fijarBiblioteca('imagenes', { seleccion: foto }); },

  /**
   * Usa una imagen del banco en la escena. El backend la descarga a la cache
   * local con su ficha de autor y licencia; aqui solo se apunta la escena a
   * ese archivo. Queda como «Cambios sin guardar» hasta pulsar Guardar.
   */
  async usarImagen(escena, foto) {
    fijarBiblioteca('imagenes', { estado: 'importando' });
    try {
      const r = await api.importarImagen(foto.id, s.biblioteca?.imagenes?.consulta || '');
      s = { ...s, creditos: { ...(s.creditos || {}), [r.path]: r.credito } };
      s = cambiarEscena(s, escena.id, 'assetPath', r.path);
      fijarBiblioteca('imagenes', { estado: 'listo', seleccion: null });
      mensaje('Imagen elegida. Pulsa «Guardar cambios» para conservarla.');
    } catch (e) {
      fijarBiblioteca('imagenes', { estado: 'listo', motivo: e.message });
    }
  },

  async abrirMusica() {
    const b = s.biblioteca?.musica || {};
    if (b.abierta) { fijarBiblioteca('musica', { abierta: false }); return; }
    fijarBiblioteca('musica', { abierta: true });
    await acc.buscarMusica(b.consulta || '', b.maxDuracion || '');
  },

  async buscarMusica(consulta = '', maxDuracion = '') {
    fijarBiblioteca('musica', { consulta, maxDuracion, estado: 'buscando', motivo: null });
    try {
      const r = await api.musica(consulta, maxDuracion);
      fijarBiblioteca('musica', { estado: 'listo', pistas: r.pistas, rechazadas: r.rechazadas, motivo: r.motivo });
    } catch (e) {
      fijarBiblioteca('musica', { estado: 'error', motivo: 'No se pudo leer la biblioteca de música.' });
      console.error(e);
    }
  },

  usarMusica(pista) {
    s = cambiar(s, 'music', {
      path: pista.path, enabled: true,
      volume: proyectoVisible(s)?.music?.volume ?? 0.12,
      // Solo para verla ya en pantalla; el backend la reescribe desde la ficha.
      credit: { titulo: pista.titulo, licencia: pista.licencia, fuente: pista.fuente, atribucion: pista.atribucion, requiereAtribucion: pista.requiereAtribucion },
    });
    fijarBiblioteca('musica', { abierta: false });
    mensaje('Música elegida. Pulsa «Guardar cambios» para conservarla.');
  },

  async abrirEfectos() {
    const b = s.biblioteca?.efectos || {};
    if (b.abierta) { fijarBiblioteca('efectos', { abierta: false }); return; }
    fijarBiblioteca('efectos', { abierta: true });
    await acc.buscarEfectos(b.consulta || '', b.categoria || '');
  },

  async buscarEfectos(consulta = '', categoria = '') {
    fijarBiblioteca('efectos', { consulta, categoria, estado: 'buscando', motivo: null });
    try {
      const r = await api.efectos(consulta, categoria);
      fijarBiblioteca('efectos', { estado: 'listo', efectos: r.efectos, categorias: r.categorias, rechazadas: r.rechazadas, motivo: r.motivo });
    } catch (e) {
      fijarBiblioteca('efectos', { estado: 'error', motivo: 'No se pudo leer la biblioteca de efectos.' });
      console.error(e);
    }
  },

  /**
   * Anade un efecto ANCLADO a la escena seleccionada y al segundo 0 de esa
   * escena. Nada se anade solo: esto solo ocurre al pulsar «Usar».
   */
  usarEfecto(efecto) {
    const p = proyectoVisible(s);
    const escena = escenaActual(s);
    const lista = [...(p?.sfx || [])];
    lista.push({
      id: `fx_${Date.now().toString(36)}`,
      path: efecto.path,
      sceneId: escena?.id || null,
      start: 0,
      volume: efecto.volumenSugerido ?? 0.6,
      duration: null,
      enabled: true,
      titulo: efecto.titulo,
      credit: { titulo: efecto.titulo, licencia: efecto.licencia, fuente: efecto.fuente },
    });
    s = cambiar(s, 'sfx', lista);
    fijarBiblioteca('efectos', { abierta: false });
    mensaje(escena
      ? `Efecto añadido a la escena ${escena.numero}. Pulsa «Guardar cambios» para conservarlo.`
      : 'Efecto añadido. Pulsa «Guardar cambios» para conservarlo.');
  },

  cambiarEfecto(id, campo, valor) {
    const p = proyectoVisible(s);
    s = cambiar(s, 'sfx', (p?.sfx || []).map(e => (e.id === id ? { ...e, [campo]: valor } : e)));
  },

  quitarEfecto(id) {
    const p = proyectoVisible(s);
    s = cambiar(s, 'sfx', (p?.sfx || []).filter(e => e.id !== id));
    mensaje('Efecto quitado. Recuerda guardar.');
  },

  /** Pestana activa del panel de audio. Solo vista: no toca el proyecto. */
  pestanaAudio(id) {
    s = { ...s, pestanaAudio: id };
    pintar();
  },

  async subirRecurso(escena, archivo) {
    try {
      const manifiesto = await importar(archivo, 'own');
      acc.cambiarEscena(escena.id, 'assetPath', manifiesto.path);
      mensaje('Imagen sustituida. Recuerda guardar.');
    } catch (e) { fallo(e); }
  },

  async subirMusica(archivo) {
    try {
      const manifiesto = await importar(archivo, 'music');
      s = cambiar(s, 'music', { path: manifiesto.path, enabled: true });
      pintar();
      mensaje('Música añadida. Recuerda guardar.');
    } catch (e) { fallo(e); }
  },
};

/** Cambia el estado de un buscador de la biblioteca y repinta el panel. */
function fijarBiblioteca(tipo, cambios) {
  s = { ...s, biblioteca: { ...s.biblioteca, [tipo]: { ...(s.biblioteca?.[tipo] || {}), ...cambios } } };
  pintar();
}

/**
 * Importa un archivo propio reutilizando el endpoint del estudio, que ya valida
 * el tipo, el tamaño y la autorización. No se duplica esa lógica aquí.
 */
function importar(archivo, kind) {
  return new Promise((resolve, reject) => {
    const q = new URLSearchParams({ name: archivo.name, kind, reference: `local:${archivo.name}` });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/studio/import?${q}`);
    xhr.setRequestHeader('x-studio-request', '1');
    xhr.setRequestHeader('x-resource-authorized', 'yes');
    xhr.onerror = () => reject(new Error('No se pudo subir el archivo.'));
    xhr.onload = () => {
      try {
        const r = JSON.parse(xhr.responseText);
        if (xhr.status !== 201) throw new Error(r.error || `Error ${xhr.status}`);
        resolve(r);
      } catch (e) { reject(e); }
    };
    xhr.send(archivo);
  });
}

// ------------------------------------------------------------- GUARDADO

async function guardar() {
  if (!haycambios(s) || s.guardando) return true;
  s = { ...s, guardando: true };
  pintarEstado();
  try {
    const cambioMusica = Boolean(s.parche?.music);
    const r = await api.guardar(s.id, cuerpoGuardado(s));
    s = confirmarGuardado(s, r);
    // La forma de onda de la musica se lee del archivo: si la pista cambio,
    // hay que pedirla de nuevo. La de la voz no cambia al guardar.
    if (cambioMusica) await cargarOndas({ soloMusica: true });
    pintar();
    return true;
  } catch (e) {
    s = { ...s, guardando: false };
    fallo(e);
    return false;
  }
}

async function exportar() {
  if (s.trabajando) return;
  if (haycambios(s)) {
    const ok = await guardar();
    if (!ok) return;
  }
  try {
    s = { ...s, trabajando: true, error: null };
    pintar();
    await api.exportar(s.id);
    await seguirTrabajo('Exportando el MP4…');
  } catch (e) { fallo(e); }
}

/** Sigue un trabajo largo hasta que termina y refresca el proyecto. */
async function seguirTrabajo(etiqueta) {
  mensaje(etiqueta);
  sondeo?.parar();
  sondeo = sondear(s.id, {
    onTick: r => {
      if (r?.job) mensaje(`${etiqueta} ${r.job.progress || 0} % · ${r.job.message || ''}`);
      if (r?.derivado) { s = { ...s, derivado: r.derivado }; pintarTimeline(); }
    },
  });
  const fin = await sondeo.done;
  s = { ...s, trabajando: false };
  if (fin?.job?.status === 'failed') { fallo(new Error(fin.job.error || 'La operación falló.')); return; }
  await recargar();
  mensaje('Listo.');
}

async function recargar() {
  const r = await api.proyecto(s.id);
  s = { ...s, proyecto: r.proyecto, derivado: r.derivado };
  await cargarOndas();
  pintar();
}

async function cargarOndas({ soloMusica = false } = {}) {
  const [narracion, musica] = await Promise.all([
    soloMusica ? Promise.resolve(undefined) : api.onda(s.id, 'narracion').catch(() => null),
    api.onda(s.id, 'musica').catch(() => null),
  ]);
  timeline.ondas(soloMusica ? { musica } : { narracion, musica });
}

// ------------------------------------------------------------ REPRODUCTOR

function sincronizarEscenaConTiempo() {
  const escenas = escenasVisibles(s);
  const i = escenaEn(escenas, s.tiempo);
  if (i >= 0 && i !== s.escenaSel) s = { ...s, escenaSel: i };
}

function reproducir() {
  if (s.reproduciendo) return;
  const total = s.derivado?.duracion || 0;
  if (s.tiempo >= total) s = { ...s, tiempo: 0 };
  s = { ...s, reproduciendo: true };
  $('play').textContent = '❚❚';
  $('play').setAttribute('aria-label', 'Pausar');

  // EL SONIDO ARRANCA AQUI, con el gesto de pulsar Play. Antes esta funcion
  // solo movia un reloj: ni la voz ni el MP4 se reproducian nunca, y por eso
  // la vista previa era muda.
  const modo = s.fuentePreview === 'mp4' && s.derivado?.salida?.url ? 'mp4' : 'aproximada';
  audio.empezar({ modo, escenas: escenasVisibles(s), t: s.tiempo });

  let anterior = performance.now();
  let escenaPintada = s.escenaSel;
  reloj_ = setInterval(() => {
    const ahora = performance.now();
    const dt = (ahora - anterior) / 1000;
    anterior = ahora;
    // Con el MP4 manda el propio video: su tiempo es el de verdad. En la
    // vista aproximada manda el reloj y la voz se ajusta a el.
    // En la vista aproximada, mientras la voz suena, manda la voz.
    const tv = modo === 'mp4' ? audio.tiempoVideo() : null;
    const provisional = tv ?? (s.tiempo + dt);
    const ta = modo === 'mp4' ? null : audio.sincronizar({ escenas: escenasVisibles(s), t: provisional });
    const t = ta ?? provisional;
    if (t >= total) { pausar(); s = { ...s, tiempo: total }; pintar(); return; }
    s = { ...s, tiempo: t };
    sincronizarEscenaConTiempo();
    // Durante la reproduccion solo se repinta lo que se mueve. Reconstruir el
    // panel y las 1 000 piezas de la linea de tiempo diez veces por segundo
    // bloqueaba la pagina en proyectos largos.
    preview.pintar(s);
    pintarReproductor();
    timeline.moverCabezal(s);
    timeline.seguir(s);
    // Cambio de escena mientras suena: solo se mueve el resaltado. Reconstruir
    // el panel y la linea de tiempo de un proyecto de 279 escenas bloqueaba la
    // pagina casi un segundo en cada cambio. El panel completo se repinta al
    // pausar (ver el boton Play).
    if (s.escenaSel !== escenaPintada) { escenaPintada = s.escenaSel; marcarSeleccion(s.escenaSel); }
  }, 100);
}

/** Marca la escena en curso en la lista y en la linea de tiempo, sin redibujar. */
function marcarSeleccion(index) {
  for (const n of document.querySelectorAll('.escena-item[aria-current="true"], .tl-clip[aria-current="true"]')) {
    n.removeAttribute('aria-current');
  }
  for (const n of document.querySelectorAll(`.escena-item[data-index="${index}"], .tl-clip[data-index="${index}"]`)) {
    n.setAttribute('aria-current', 'true');
  }
}

function pausar() {
  if (reloj_) { clearInterval(reloj_); reloj_ = null; }
  audio.parar();
  if (s.reproduciendo) s = { ...s, reproduciendo: false };
  $('play').textContent = '▶';
  $('play').setAttribute('aria-label', 'Reproducir');
}

// ---------------------------------------------------------------- PINTAR

function mensaje(texto) { $('panel-pista').textContent = texto || ''; }

function fallo(e) {
  s = { ...s, error: e.message, trabajando: false };
  pintarError();
  if (!(e instanceof ApiError)) console.error(e);
}

function pintarError() {
  const caja = $('error');
  caja.hidden = !s.error;
  caja.textContent = s.error || '';
}

function pintarEstado() {
  const chip = $('estado-guardado');
  const sucio = haycambios(s);
  if (s.guardando) { chip.textContent = 'Guardando…'; chip.dataset.tono = 'guardando'; }
  else if (sucio) { chip.textContent = 'Cambios sin guardar'; chip.dataset.tono = 'sucio'; }
  else { chip.textContent = 'Guardado'; chip.dataset.tono = 'guardado'; }

  $('guardar').disabled = !sucio || s.guardando || s.trabajando;
  $('exportar').disabled = s.trabajando;
  $('deshacer').disabled = !puedeDeshacer(s);
  $('rehacer').disabled = !puedeRehacer(s);
}

const CONTROLES = 'input, textarea, select';

/** Posicion del cursor, si el control la tiene. `number` y `range` no. */
function cursorDe(n) {
  try { return { inicio: n.selectionStart, fin: n.selectionEnd }; } catch { return null; }
}

/**
 * Repintar el panel reconstruye sus nodos, y con ellos se va el foco.
 *
 * Al escribir una letra en «Qué imagen buscar», el input desaparecia a mitad de
 * pulsacion: el teclado se quedaba sin campo y la vista saltaba a otro sitio.
 * Aqui se anota QUE control estaba enfocado y donde tenia el cursor, para
 * devolverlo despues. El control se identifica por su posicion entre los de su
 * mismo tipo, que es estable mientras el panel no cambie de forma.
 */
function capturarFoco(cuerpo) {
  const a = document.activeElement;
  if (!a || !cuerpo.contains(a) || !a.matches(CONTROLES)) return null;
  const mismos = [...cuerpo.querySelectorAll(CONTROLES)].filter(n => n.tagName === a.tagName && n.type === a.type);
  return { tag: a.tagName, tipo: a.type, n: mismos.indexOf(a), cursor: cursorDe(a) };
}

function restaurarFoco(cuerpo, f) {
  if (!f || f.n < 0) return;
  const mismos = [...cuerpo.querySelectorAll(CONTROLES)].filter(n => n.tagName === f.tag && n.type === f.tipo);
  const n = mismos[f.n];
  if (!n) return;
  // `preventScroll`: devolver el foco no debe mover la vista por su cuenta; del
  // scroll se encarga la linea de arriba, que lo restaura tal y como estaba.
  n.focus({ preventScroll: true });
  if (f.cursor && typeof n.setSelectionRange === 'function') {
    try { n.setSelectionRange(f.cursor.inicio, f.cursor.fin); } catch { /* este control no tiene cursor */ }
  }
}

/**
 * Posicion de scroll del panel QUERIDA POR LA USUARIA.
 *
 * No se lee del DOM en cada repintado: el propio repintado la recorta (el panel
 * pasa un instante por un alto menor), y tomar ese valor recortado como nuevo
 * punto de partida hacia que el panel se fuera subiendo solo, letra a letra,
 * hasta el principio. Solo se actualiza cuando desplaza la usuaria.
 */
let scrollPanel = 0;
let repintando = false;

$('panel-cuerpo').addEventListener('scroll', () => {
  if (!repintando) scrollPanel = $('panel-cuerpo').scrollTop;
}, { passive: true });

function pintarPanel() {
  const def = PANELES[s.herramienta] || PANELES.escenas;
  $('panel-titulo').textContent = def.titulo;
  const cuerpo = $('panel-cuerpo');
  // Se conservan el scroll y el foco: repintar al teclear no debe saltar ni
  // dejar al teclado sin campo donde escribir.
  const foco = capturarFoco(cuerpo);
  repintando = true;
  cuerpo.replaceChildren(def.render({ s, acc }));
  // Leer `scrollHeight` OBLIGA al navegador a calcular las alturas del panel
  // recien creado. Sin esta lectura, la asignacion de abajo se compara con el
  // alto anterior (o con ninguno) y el navegador RECORTA la posicion; como la
  // siguiente pulsacion parte de la posicion ya recortada, el panel se iba
  // subiendo solo hasta arriba al escribir. Eso es lo que hacia que el campo
  // «Qué imagen buscar» pareciera saltar de sitio letra a letra.
  cuerpo.scrollTop = scrollPanel;
  restaurarFoco(cuerpo, foco);
  // El alto definitivo del panel no se conoce hasta el siguiente fotograma
  // (las miniaturas todavia no estan colocadas). Si en ese momento es mas corto
  // que la posicion pedida, el navegador la RECORTA. Se vuelve a aplicar
  // entonces, y los saltos que provoca el propio repintado no se toman por
  // desplazamientos de la usuaria: por eso `repintando`.
  requestAnimationFrame(() => {
    cuerpo.scrollTop = scrollPanel;
    repintando = false;
  });

  for (const b of $('herramientas').querySelectorAll('.herr')) {
    b.setAttribute('aria-current', String(b.dataset.herr === s.herramienta));
  }
}

function pintarTimeline() { timeline.pintar(s); }

function pintarReproductor() {
  const total = s.derivado?.duracion || 0;
  $('tiempo').textContent = `${reloj(s.tiempo)} / ${reloj(total)}`;
  const barra = $('barra');
  if (document.activeElement !== barra) {
    barra.value = String(total ? Math.round((s.tiempo / total) * 1000) : 0);
  }
  const alDia = s.derivado?.salida?.alDia;
  const chip = $('fuente-preview');
  if (s.fuentePreview === 'mp4') {
    chip.textContent = alDia ? 'MP4 exportado (definitivo)' : 'MP4 anterior a los cambios';
    chip.dataset.tono = alDia ? 'ok' : 'aviso';
  } else {
    chip.textContent = 'Vista previa aproximada';
    chip.dataset.tono = 'aviso';
  }
  // Aviso de audio: sin voz, voz silenciada o al 0 %. Se ve junto al Play
  // para que un silencio nunca parezca un fallo del reproductor.
  const aviso = avisoAudio(proyectoVisible(s), s.derivado);
  const chipAudio = $('aviso-audio');
  chipAudio.hidden = !aviso;
  if (aviso) { chipAudio.textContent = aviso.texto; chipAudio.title = aviso.detalle; chipAudio.dataset.tono = aviso.tono; }
  audio.configurar({ proyecto: proyectoVisible(s), derivado: s.derivado });

  const hayMp4 = Boolean(s.derivado?.salida?.url);
  $('ver-mp4').hidden = !hayMp4;
  $('ver-mp4').textContent = s.fuentePreview === 'mp4' ? 'Ver vista previa' : 'Ver MP4 exportado';
}

function pintarCabecera() {
  const p = proyectoVisible(s);
  if (!p) return;
  if (document.activeElement !== $('titulo')) $('titulo').value = p.title || '';

  const cont = $('formatos');
  if (cont.dataset.formato !== p.aspectRatio || !cont.children.length) {
    cont.dataset.formato = p.aspectRatio;
    cont.replaceChildren(...Object.keys(s.capacidades?.aspects || {}).map(id => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = id;
      b.setAttribute('aria-pressed', String(id === p.aspectRatio));
      b.addEventListener('click', () => acc.cambiarFormato(id));
      return b;
    }));
  }
}

function pintar() {
  pintarCabecera();
  pintarEstado();
  pintarError();
  pintarPanel();
  preview.pintar(s);
  pintarTimeline();
  pintarReproductor();
  $('tl-info').textContent = s.derivado
    ? `${escenasVisibles(s).length} escenas · ${reloj(s.derivado.duracion)}`
    : '';
}

// ------------------------------------------------------------- ARRANQUE

$('herramientas').addEventListener('click', ev => {
  const b = ev.target.closest('.herr');
  if (b) acc.herramienta(b.dataset.herr);
});

$('titulo').addEventListener('input', () => acc.cambiar('title', $('titulo').value));
$('zonas-seguras').addEventListener('change', () => acc.zonasSeguras($('zonas-seguras').checked));
$('guardar').addEventListener('click', () => guardar());
$('exportar').addEventListener('click', () => exportar());
$('deshacer').addEventListener('click', () => { s = deshacer(s); pintar(); });
$('rehacer').addEventListener('click', () => { s = rehacer(s); pintar(); });

$('play').addEventListener('click', () => (s.reproduciendo ? (pausar(), pintar()) : reproducir()));
$('barra').addEventListener('input', () => {
  pausar();
  const total = s.derivado?.duracion || 0;
  s = { ...s, tiempo: (Number($('barra').value) / 1000) * total };
  sincronizarEscenaConTiempo();
  pintar();
});
$('volumen-escucha').addEventListener('input', () => audio.volumenEscucha($('volumen-escucha').value));

$('ver-mp4').addEventListener('click', () => {
  pausar();
  s = { ...s, fuentePreview: s.fuentePreview === 'mp4' ? 'aproximada' : 'mp4' };
  pintar();
});

$('zoom-mas').addEventListener('click', () => { s = { ...s, zoom: Math.min(20, s.zoom * 1.6) }; $('zoom-nivel').textContent = `${s.zoom.toFixed(1)}×`; pintarTimeline(); });
$('zoom-menos').addEventListener('click', () => { s = { ...s, zoom: Math.max(0.1, s.zoom / 1.6) }; $('zoom-nivel').textContent = `${s.zoom.toFixed(1)}×`; pintarTimeline(); });

document.addEventListener('keydown', ev => {
  const escribiendo = /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName);
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); guardar(); return; }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') {
    ev.preventDefault();
    s = ev.shiftKey ? rehacer(s) : deshacer(s);
    pintar();
    return;
  }
  if (ev.code === 'Space' && !escribiendo) { ev.preventDefault(); s.reproduciendo ? (pausar(), pintar()) : reproducir(); }
});

// Aviso antes de perder cambios. El navegador enseña su propio texto; lo que
// importa es que no se cierre en silencio con trabajo sin guardar.
window.addEventListener('beforeunload', ev => {
  if (haycambios(s)) { ev.preventDefault(); ev.returnValue = ''; }
});
$('volver').addEventListener('click', ev => {
  if (haycambios(s) && !confirm('Hay cambios sin guardar. ¿Salir de todos modos?')) ev.preventDefault();
});

window.addEventListener('resize', () => pintarTimeline());

(async function arrancar() {
  const id = new URLSearchParams(location.search).get('id');
  if (!id) {
    $('cargando').textContent = 'Falta el proyecto. Abre el editor desde «Mis proyectos».';
    return;
  }
  try {
    const [config, datos] = await Promise.all([api.config(), api.proyecto(id)]);
    // Zoom inicial: que el proyecto entero quepa de una vez. En un video de
    // media hora, el zoom 1 daria una linea de 67 000 px y no se veria nada.
    const zoom = zoomQueEncaja(datos.derivado.duracion, $('tl-scroll').clientWidth);
    s = { ...s, id, capacidades: config, proyecto: datos.proyecto, derivado: datos.derivado, zoom };
    $('zoom-nivel').textContent = `${zoom.toFixed(2)}×`;
    document.title = `${datos.proyecto.title} · Editor`;
    await cargarOndas();
    $('cargando').hidden = true;
    pintar();
    // Un trabajo que quedó corriendo (exportación, regeneración) se retoma.
    if (datos.derivado.job?.status === 'running') {
      s = { ...s, trabajando: true };
      seguirTrabajo('Operación en curso…');
    }
  } catch (e) {
    $('cargando').textContent = `No se pudo abrir el proyecto: ${e.message}`;
  }
}());
