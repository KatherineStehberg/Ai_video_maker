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

  herramienta(nombre) { s = { ...s, herramienta: nombre }; pintar(); },

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
    const r = await api.guardar(s.id, cuerpoGuardado(s));
    s = confirmarGuardado(s, r);
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

async function cargarOndas() {
  const [narracion, musica] = await Promise.all([
    api.onda(s.id, 'narracion').catch(() => null),
    api.onda(s.id, 'musica').catch(() => null),
  ]);
  timeline.ondas({ narracion, musica });
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
    if (s.escenaSel !== escenaPintada) { escenaPintada = s.escenaSel; pintarPanel(); timeline.pintar(s); }
  }, 100);
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

function pintarPanel() {
  const def = PANELES[s.herramienta] || PANELES.escenas;
  $('panel-titulo').textContent = def.titulo;
  const cuerpo = $('panel-cuerpo');
  // Se conserva la posición del scroll: repintar al teclear no debe saltar.
  const scroll = cuerpo.scrollTop;
  cuerpo.replaceChildren(def.render({ s, acc }));
  cuerpo.scrollTop = scroll;

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
