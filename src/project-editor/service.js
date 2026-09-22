/**
 * SERVICIO DEL EDITOR VISUAL
 *
 * Es una capa DELGADA sobre lo que ya existe: `core/project.js` guarda,
 * `core/pipeline.js` produce, `core/renderer.js` monta y `core/subtitles.js`
 * subtitula. Aqui no se reimplementa ninguna de esas cosas.
 *
 * Lo que si aporta:
 *   1. DATOS DERIVADOS que la interfaz necesita y el JSON no trae: el segundo
 *      en que empieza cada escena, el estado de su recurso visual, si tiene voz
 *      o rotulo, y las pistas de la linea de tiempo.
 *   2. UNA SOLA PUERTA para guardar, que ademas invalida lo que deja de ser
 *      valido al editar (la aprobacion del guion y el MP4 anterior).
 *   3. Operaciones largas (regenerar una escena, exportar) como trabajos en
 *      segundo plano, con el mismo patron que el estudio.
 *
 * FUNCIONA CON CUALQUIER PROYECTO. Los creados desde el Estudio traen bloque
 * `studio`; los creados desde un prompt, no. El editor abre los dos.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeProject, makeScene, validateProject, totalDuration, STATUS } from '../core/project.js';
import { runPipeline } from '../core/pipeline.js';
import { buildExportPackage } from '../core/export.js';
import { loadBrand, listBrands } from '../core/brands.js';
import { listTemplates } from '../templates/index.js';
import { ASPECTS } from '../config.js';
import { abs, rel, workDir } from '../lib/paths.js';
import { assetKind, resolveSafeAsset } from '../core/asset-manager.js';
import { buildCues, verifyCaptionCoverage } from '../core/subtitles.js';
import { captionStyleOptions, normalizeCaptionStyle, captionMetrics } from '../core/captions-style.js';
import {
  normalizeOnScreenStyle, POSICIONES_DESTACADO, ANIMACIONES_DESTACADO,
  TAMANOS_DESTACADO, FONDOS_DESTACADO, PALABRAS_DESTACADO, resumenDestacados,
} from '../core/on-screen-text.js';
import { listAllVoices } from '../providers/tts/index.js';
import { LANGUAGES } from '../core/lang.js';
import { getStorage } from './storage.js';
import { peaks } from './waveform.js';
import { creditoDeImagen, creditoDeMusica, imagenesDisponibles } from './media-library.js';
import { logger } from '../lib/logger.js';

const log = logger('editor');

/**
 * TRANSICIONES REALES.
 *
 * El modelo admite cinco valores historicos, pero el renderer solo distingue
 * dos comportamientos: sin transicion, o un fundido de entrada y salida por
 * clip. `slideleft` y `wipeleft` se guardarian pero se verian como un fundido,
 * asi que NO se ofrecen: seria prometer un efecto que no existe.
 */
export const TRANSICIONES_REALES = [
  { id: 'none', label: 'Sin transición' },
  { id: 'fade', label: 'Fundido' },
];

/** Efectos de movimiento sobre imagen fija que el renderer implementa. */
export const MOVIMIENTOS_REALES = [
  { id: 'none', label: 'Sin movimiento' },
  { id: 'in', label: 'Acercar' },
  { id: 'out', label: 'Alejar' },
  { id: 'auto', label: 'Alternar automáticamente' },
];

const activos = new Map();

const idValido = id => typeof id === 'string' && /^vid_[a-zA-Z0-9_-]+$/.test(id);

/** Bloque de estado propio del editor, creado la primera vez que hace falta. */
function bloqueEditor(p) {
  if (!p.editor) {
    p.editor = {
      version: 1,
      revision: 1,
      // Revision que produjo el MP4 actual. Si no coincide con `revision`, lo
      // exportado es anterior a los cambios y hay que volver a exportar.
      exportedRevision: p.outputPath ? 1 : null,
      savedAt: p.updatedAt || null,
      job: null,
    };
  }
  return p.editor;
}

export async function cargarProyecto(id) {
  if (!idValido(id)) throw new Error('Identificador de proyecto inválido');
  const p = await getStorage().load(id);
  if (!p) throw new Error('Proyecto no encontrado');
  bloqueEditor(p);
  // Un trabajo marcado como en curso sin proceso detras es un reinicio del
  // servidor: se declara interrumpido en vez de dejarlo girando para siempre.
  if (p.editor.job?.status === 'running' && !activos.has(id)) {
    p.editor.job = { ...p.editor.job, status: 'interrupted', error: 'El servidor se reinició durante la operación.' };
  }
  return p;
}

/** Estado del recurso visual de una escena, mirando el disco de verdad. */
function estadoRecurso(scene) {
  if (!scene.assetPath) {
    return { estado: 'falta', etiqueta: 'Sin imagen', kind: null, url: null, path: null };
  }
  const file = resolveSafeAsset(scene.assetPath);
  if (!file || !fs.existsSync(file)) {
    return { estado: 'error', etiqueta: 'El archivo ya no está', kind: null, url: null, path: scene.assetPath };
  }
  const kind = assetKind(file);
  const proveedor = scene.assetProvider || null;
  // `placeholder` es el fondo de marca generado con FFmpeg: sirve, pero no es
  // una imagen del tema. Se declara como tal para que se pueda reemplazar.
  const esFallback = proveedor === 'placeholder' || proveedor === 'local';
  return {
    estado: esFallback ? 'fallback' : 'listo',
    etiqueta: esFallback ? 'Fondo de marca (sustituible)' : 'Listo',
    kind,
    proveedor,
    // Autor, licencia y origen cuando la imagen viene de un banco.
    credito: scene.assetCredit || null,
    path: scene.assetPath,
    url: `/file?path=${encodeURIComponent(scene.assetPath)}`,
  };
}

/**
 * Todo lo que la interfaz necesita para dibujarse, calculado en el backend.
 *
 * Se calcula aqui y no en el navegador para que el editor y el render partan
 * exactamente de los mismos numeros (tiempos de escena, metrica de subtitulos,
 * cobertura). Si cada uno los calculase por su cuenta acabarian discrepando.
 */
export function derivar(p) {
  const dims = ASPECTS[p.aspectRatio] || ASPECTS['9:16'];
  const metrica = captionMetrics(dims.width, dims.height, p.captions?.style || {});
  const subsActivos = p.captions?.enabled !== false;

  // Una escena excluida NO ocupa tiempo: el render, los subtitulos y la pista
  // de voz la saltan, y la linea de tiempo tiene que decir lo mismo. Antes su
  // duracion se sumaba igual, y a partir de ella la vista previa y el audio
  // quedaban desplazados respecto al MP4.
  let t = 0;
  const escenas = (p.scenes || []).map((s, i) => {
    const start = t;
    const dur = Number(s.duration) || 0;
    if (!s.excluida) t += dur;
    const recurso = estadoRecurso(s);
    const vozArchivo = s.narrationPath && fs.existsSync(abs(s.narrationPath)) ? s.narrationPath : null;
    const cues = subsActivos ? buildCues({ ...p, scenes: [s] }, { width: dims.width, height: dims.height }) : [];
    return {
      index: i,
      id: s.id,
      numero: i + 1,
      start: Number(start.toFixed(3)),
      end: Number((start + (s.excluida ? 0 : dur)).toFixed(3)),
      duration: Number(dur.toFixed(3)),
      text: s.text || '',
      caption: s.caption,
      visualPrompt: s.visualPrompt || '',
      transition: s.transition || 'none',
      kenBurns: s.kenBurns || 'none',
      excluida: Boolean(s.excluida),
      recurso,
      // Indicadores de la tarjeta de escena.
      tieneNarracion: Boolean(vozArchivo),
      // Voz de ESTA escena, para que la vista previa la reproduzca. Se usa el
      // WAV por escena y no la pista montada (narration.wav) porque esta solo
      // se rehace al exportar: tras excluir o reordenar, quedaria desfasada.
      narracion: vozArchivo ? { url: `/file?path=${encodeURIComponent(vozArchivo)}`, path: vozArchivo } : null,
      tieneSubtitulos: cues.length > 0,
      cues: cues.length,
      tieneTextoDestacado: Boolean(s.showOnScreenText && String(s.onScreenTitle || '').trim()),
      faltaRecurso: recurso.estado === 'falta' || recurso.estado === 'error',
      // Texto destacado, completo, para el panel Texto.
      showOnScreenText: Boolean(s.showOnScreenText),
      onScreenTitle: s.onScreenTitle || '',
      onScreenPosition: s.onScreenPosition || 'upper-third',
      onScreenStyle: normalizeOnScreenStyle(s.onScreenStyle),
      onScreenAnimation: s.onScreenAnimation || 'fade',
      onScreenTextManual: Boolean(s.onScreenTextManual),
    };
  });

  const cobertura = subsActivos ? verifyCaptionCoverage(p, { width: dims.width, height: dims.height }) : null;
  const destacados = resumenDestacados(p.scenes || []);
  const validacion = validateProject(p);

  // Pistas de la linea de tiempo. Solo se declara la que tiene contenido real.
  const narracionTrack = escenas.filter(e => e.tieneNarracion);
  // La pista de musica se muestra si hay una elegida, aunque este silenciada:
  // asi se ve que existe y en que estado esta. Que suene lo decide `activa`.
  const musica = Boolean(p.music?.path && fs.existsSync(abs(p.music.path)));

  const salida = p.outputs?.[p.aspectRatio] || p.outputPath || null;
  const salidaExiste = Boolean(salida && fs.existsSync(abs(salida)));
  const ed = bloqueEditor(p);

  return {
    duracion: Number(totalDuration(p).toFixed(3)),
    dimensiones: dims,
    escenas,
    subtitulos: {
      activos: subsActivos,
      burnIn: p.captions?.burnIn !== false,
      metrica: {
        fontSize: metrica.fontSize,
        marginV: metrica.marginV,
        marginH: metrica.marginH,
        maxCharsPerLine: metrica.maxCharsPerLine,
        maxLines: metrica.maxLines,
        outlineWidth: metrica.outlineWidth,
        safeBottom: metrica.safeBottom,
        safeTop: metrica.safeTop,
        blockHeight: metrica.blockHeight,
      },
      cobertura: cobertura ? {
        ok: cobertura.ok,
        porcentaje: Number((cobertura.cobertura * 100).toFixed(1)),
        problemas: cobertura.problemas,
        cuesRapidos: cobertura.cuesRapidos.length,
      } : null,
      archivo: p.captions?.file || null,
    },
    textoDestacado: destacados,
    audio: resumenAudio(p, escenas, musica),
    pistas: {
      textoDestacado: escenas.filter(e => e.tieneTextoDestacado).length,
      subtitulos: escenas.reduce((a, e) => a + e.cues, 0),
      narracion: narracionTrack.length,
      visual: escenas.filter(e => !e.faltaRecurso).length,
      musica: musica ? 1 : 0,
    },
    salida: salidaExiste ? {
      path: salida,
      url: `/file?path=${encodeURIComponent(salida)}`,
      // El MP4 es de esta revision o de una anterior. Es lo que separa
      // «vista previa aproximada» de «render definitivo».
      alDia: ed.exportedRevision === ed.revision,
      bytes: fs.statSync(abs(salida)).size,
    } : null,
    validacion: { ok: validacion.ok, errores: validacion.errors, avisos: validacion.warnings },
    revision: ed.revision,
    exportedRevision: ed.exportedRevision,
    job: ed.job,
  };
}

/**
 * Que va a sonar, y si no suena nada, por que.
 *
 * Es lo que la interfaz ensena junto al reproductor. Distingue cuatro casos
 * que desde fuera se oyen igual (silencio) pero tienen arreglo distinto: no se
 * ha generado voz, la voz esta silenciada, el volumen esta a 0, o hay voz.
 */
export function resumenAudio(p, escenas, hayMusica) {
  const activas = escenas.filter(e => !e.excluida);
  const conVoz = activas.filter(e => e.narracion).length;
  const vozActiva = p.voice?.enabled !== false;
  const ganancia = Number(p.voice?.gain ?? 1);
  const musica = hayMusica
    ? { url: `/file?path=${encodeURIComponent(p.music.path)}`, volumen: Number(p.music.volume ?? 0.12), activa: Boolean(p.music.enabled),
      titulo: p.music.credit?.titulo || path.basename(p.music.path), credito: p.music.credit || null }
    : null;

  let aviso = null;
  if (!conVoz && !musica) aviso = 'Este proyecto no tiene audio: ni narración generada ni música.';
  else if (conVoz && !vozActiva) aviso = 'La narración está silenciada: el video se exportará sin voz.';
  else if (conVoz && vozActiva && ganancia <= 0) aviso = 'El volumen de la narración está al 0 %: se exportará en silencio.';
  else if (conVoz < activas.length && conVoz > 0) aviso = `Hay ${activas.length - conVoz} escenas sin voz generada: en ellas no sonará nada.`;

  return {
    narracion: { escenasConVoz: conVoz, escenas: activas.length, activa: vozActiva, ganancia },
    musica,
    // En el MP4 habra pista de audio si suena algo: voz activa con archivo,
    // o musica activa. Es la misma regla que aplica el renderer.
    exportaraAudio: Boolean((vozActiva && conVoz) || musica?.activa),
    aviso,
  };
}

/** Vista completa que consume el editor. */
export async function vistaEditor(id) {
  const p = await cargarProyecto(id);
  return { proyecto: publico(p), derivado: derivar(p) };
}

/** El proyecto sin rutas absolutas ni nada que no deba viajar al navegador. */
export function publico(p) {
  return {
    id: p.id,
    title: p.title,
    language: p.language,
    brand: p.brand,
    template: p.template,
    language: p.language,
    aspectRatio: p.aspectRatio,
    exportFormats: p.exportFormats,
    status: p.status,
    captions: p.captions,
    voice: { provider: p.voice?.provider, name: p.voice?.name, enabled: p.voice?.enabled !== false, gain: p.voice?.gain ?? 1 },
    music: { enabled: Boolean(p.music?.enabled), path: p.music?.path || null, volume: p.music?.volume ?? 0.12, credit: p.music?.credit || null },
    assets: { logo: p.assets?.logo || null },
    cta: p.cta || '',
    outputs: p.outputs || {},
    editor: p.editor,
    // `studio` solo se anuncia como bandera: el editor no lo usa, pero saber si
    // existe explica por que un proyecto pide aprobacion de guion y otro no.
    tieneEstudio: Boolean(p.studio),
    updatedAt: p.updatedAt,
    createdAt: p.createdAt,
  };
}

/** Proyectos que el editor puede abrir, con lo justo para la lista. */
export async function listar() {
  const items = await getStorage().list();
  return items.map(p => ({
    ...p,
    url: `/project-editor.html?id=${encodeURIComponent(p.id)}`,
  }));
}

/** Opciones reales que la interfaz puede ofrecer. Nada inventado. */
export async function capacidades() {
  return {
    aspects: ASPECTS,
    brands: listBrands(),
    templates: listTemplates(),
    languages: LANGUAGES,
    voices: await listAllVoices(),
    captionStyle: captionStyleOptions(),
    onScreen: {
      positions: POSICIONES_DESTACADO,
      animations: ANIMACIONES_DESTACADO,
      sizes: TAMANOS_DESTACADO,
      backgrounds: FONDOS_DESTACADO,
      maxWords: PALABRAS_DESTACADO.max,
    },
    transiciones: TRANSICIONES_REALES,
    movimientos: MOVIMIENTOS_REALES,
    almacenamiento: getStorage().describe?.() ?? { id: getStorage().id },
    // Solo un booleano: si hay banco de imagenes. Nunca la clave ni su largo.
    biblioteca: { imagenes: imagenesDisponibles(), proveedorImagenes: 'Pexels', musica: 'local' },
    // Lo que TODAVIA no existe, declarado para que la interfaz lo deshabilite
    // en vez de fingirlo.
    pendiente: {
      publicar: 'No hay ninguna integración de publicación conectada.',
      arrastrarClips: 'Mover un clip en la línea de tiempo todavía no se puede guardar.',
      dividirEscena: 'Dividir una escena todavía no se puede guardar.',
      efectos: 'No hay pista de efectos de sonido.',
    },
  };
}

/**
 * Numero acotado. Un valor vacio (`''`, `null`, espacios) NO es 0: es «no
 * me han dado nada» y se queda el valor por defecto. `Number('')` vale 0, y
 * sin esta comprobacion un control de volumen vacio silenciaba la voz.
 */
const num = (v, min, max, porDefecto) => {
  if (v === null || v === undefined || (typeof v === 'string' && !v.trim())) return porDefecto;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : porDefecto;
};

/**
 * Guarda los cambios del editor.
 *
 * Es la UNICA puerta de escritura, y por eso aqui se invalida lo que una
 * edicion deja obsoleto:
 *   - la aprobacion del guion del estudio, si la habia;
 *   - el MP4 exportado, que pasa a ser de una revision anterior.
 * Nada de eso se borra: se marca, y la interfaz lo dice.
 */
export async function guardar(id, patch = {}) {
  const p = await cargarProyecto(id);
  if (activos.has(id)) throw new Error('Hay una operación en curso sobre este proyecto; espera a que termine.');

  const ed = bloqueEditor(p);
  if (patch.revision !== undefined && Number(patch.revision) !== ed.revision) {
    throw new Error('El proyecto cambió en otra pestaña. Recarga antes de guardar.');
  }

  if (patch.title !== undefined) {
    const t = String(patch.title).trim().slice(0, 120);
    if (!t) throw new Error('El proyecto necesita un nombre.');
    p.title = t;
  }
  if (patch.aspectRatio !== undefined) {
    if (!ASPECTS[patch.aspectRatio]) throw new Error(`Formato no admitido: ${patch.aspectRatio}`);
    p.aspectRatio = patch.aspectRatio;
    p.exportFormats = [patch.aspectRatio];
  }
  if (patch.brand !== undefined) {
    if (!listBrands().some(b => b.id === patch.brand)) throw new Error('Marca no encontrada.');
    p.brand = patch.brand;
  }
  if (patch.cta !== undefined) p.cta = String(patch.cta).slice(0, 200);

  // ---- SUBTITULOS ----
  if (patch.captions) {
    const c = patch.captions;
    p.captions = {
      ...p.captions,
      ...(c.enabled !== undefined ? { enabled: Boolean(c.enabled), burnIn: Boolean(c.enabled) && c.burnIn !== false } : {}),
      ...(c.style !== undefined ? { style: normalizeCaptionStyle(c.style, p.captions?.style) } : {}),
      ...(c.maxCharsPerLine !== undefined
        ? { maxCharsPerLine: c.maxCharsPerLine === null ? null : num(c.maxCharsPerLine, 10, 80, null) }
        : {}),
    };
  }

  // ---- AUDIO ----
  if (patch.voice) {
    p.voice = {
      ...p.voice,
      ...(patch.voice.enabled !== undefined ? { enabled: Boolean(patch.voice.enabled) } : {}),
      // Ganancia de MEZCLA, no de sintesis: se aplica al montar el audio, asi
      // que cambia el volumen sin tener que regenerar la voz.
      ...(patch.voice.gain !== undefined ? { gain: num(patch.voice.gain, 0, 2, 1) } : {}),
    };
  }
  if (patch.music) {
    const m = patch.music;
    // Solo musica con licencia declarada (biblioteca) o archivo propio con la
    // declaracion de autorizacion. `creditoDeMusica` lanza en cualquier otro
    // caso, incluida una ruta fuera de las carpetas permitidas.
    const credito = m.path ? creditoDeMusica(m.path) : null;
    p.music = {
      ...p.music,
      ...(m.path !== undefined ? { path: m.path || null, enabled: Boolean(m.path) && m.enabled !== false, credit: credito } : {}),
      ...(m.enabled !== undefined && m.path === undefined ? { enabled: Boolean(m.enabled) && Boolean(p.music?.path) } : {}),
      ...(m.volume !== undefined ? { volume: num(m.volume, 0, 1, 0.12) } : {}),
    };
  }

  // ---- ESCENAS ----
  if (patch.scenes) {
    if (!Array.isArray(patch.scenes)) throw new Error('`scenes` debe ser una lista.');
    const previas = new Map(p.scenes.map(s => [s.id, s]));
    for (const cambio of patch.scenes) {
      const vieja = previas.get(cambio.id);
      if (!vieja) throw new Error(`La escena ${cambio.id} no existe en este proyecto.`);

      if (cambio.text !== undefined) {
        const texto = String(cambio.text).trim();
        if (!texto) throw new Error(`La escena ${vieja.id} se quedaría sin narración.`);
        vieja.text = texto.slice(0, 4000);
      }
      if (cambio.caption !== undefined) vieja.caption = cambio.caption === null ? null : String(cambio.caption).slice(0, 4000);
      if (cambio.visualPrompt !== undefined) vieja.visualPrompt = String(cambio.visualPrompt).slice(0, 300);
      if (cambio.duration !== undefined) vieja.duration = num(cambio.duration, 0.5, 300, vieja.duration);
      if (cambio.excluida !== undefined) vieja.excluida = Boolean(cambio.excluida);
      if (cambio.transition !== undefined) {
        if (!TRANSICIONES_REALES.some(x => x.id === cambio.transition)) throw new Error('Transición no soportada.');
        vieja.transition = cambio.transition;
      }
      if (cambio.kenBurns !== undefined) {
        if (!MOVIMIENTOS_REALES.some(x => x.id === cambio.kenBurns)) throw new Error('Movimiento no soportado.');
        vieja.kenBurns = cambio.kenBurns;
      }
      if (cambio.assetPath !== undefined) {
        if (cambio.assetPath) {
          const file = resolveSafeAsset(cambio.assetPath);
          if (!file || !fs.existsSync(file)) throw new Error('El recurso indicado no existe.');
          vieja.assetPath = cambio.assetPath;
          // El credito se lee de la ficha que hay junto al archivo en disco:
          // si viniera del navegador, cualquiera podria atribuir una foto a
          // quien quisiera.
          const credito = creditoDeImagen(cambio.assetPath);
          vieja.assetCredit = credito;
          vieja.assetProvider = credito?.proveedor || 'manual';
        } else {
          vieja.assetPath = null;
          vieja.assetProvider = null;
          vieja.assetCredit = null;
        }
      }
      // Texto destacado: los cinco campos.
      if (cambio.onScreenTitle !== undefined) {
        const nuevo = String(cambio.onScreenTitle).slice(0, 100);
        if (nuevo !== vieja.onScreenTitle) vieja.onScreenTextManual = true;
        vieja.onScreenTitle = nuevo;
      }
      if (cambio.showOnScreenText !== undefined) vieja.showOnScreenText = Boolean(cambio.showOnScreenText);
      if (cambio.onScreenPosition !== undefined) {
        if (!POSICIONES_DESTACADO.includes(cambio.onScreenPosition)) throw new Error('Posición de rótulo no soportada.');
        vieja.onScreenPosition = cambio.onScreenPosition;
      }
      if (cambio.onScreenAnimation !== undefined) {
        if (!ANIMACIONES_DESTACADO.includes(cambio.onScreenAnimation)) throw new Error('Animación de rótulo no soportada.');
        vieja.onScreenAnimation = cambio.onScreenAnimation;
      }
      if (cambio.onScreenStyle !== undefined) vieja.onScreenStyle = normalizeOnScreenStyle(cambio.onScreenStyle, vieja.onScreenStyle);
    }
    // `makeScene` vuelve a normalizar (rotulo acortado, valores validos).
    p.scenes = p.scenes.map(s => makeScene(s));
  }

  // Editar invalida la aprobacion previa y deja el MP4 anterior como viejo.
  if (p.studio && p.studio.approvedScriptHash) p.studio.approvedScriptHash = null;
  ed.revision += 1;
  ed.savedAt = new Date().toISOString();
  if (p.status === STATUS.COMPLETED) p.status = STATUS.DRAFT;

  await getStorage().save(p);
  return { proyecto: publico(p), derivado: derivar(p) };
}

// ------------------------------------------------------------- TRABAJOS

async function enSegundoPlano(p, accion, tarea) {
  const ed = bloqueEditor(p);
  ed.job = { id: randomUUID(), accion, status: 'running', progress: 0, message: 'Empezando', startedAt: new Date().toISOString() };
  activos.set(p.id, true);
  await getStorage().save(p);

  const progreso = e => {
    ed.job.progress = Math.round(e.pct || 0);
    ed.job.message = e.message || e.step || '';
    getStorage().save(p);
  };

  void (async () => {
    try {
      await tarea(progreso);
      ed.job.status = 'complete';
      ed.job.progress = 100;
      ed.job.message = 'Listo';
    } catch (e) {
      log.error(`${accion} fallo:`, e.message);
      ed.job.status = 'failed';
      ed.job.error = e.message;
    } finally {
      ed.job.finishedAt = new Date().toISOString();
      activos.delete(p.id);
      await getStorage().save(p);
    }
  })();

  return { proyecto: publico(p), derivado: derivar(p) };
}

/**
 * Regenera UNA escena: su imagen, su voz o las dos.
 *
 * El ahorro no es magia: al soltar `assetPath`/`narrationPath` de esa escena,
 * el buscador de imagenes y el TTS la ven pendiente y las demas siguen
 * cacheadas. Volver a montar el video es lo unico que cuesta lo mismo.
 */
export async function regenerarEscena(id, index, { visual = true, voz = true, montar = false } = {}) {
  const p = await cargarProyecto(id);
  if (activos.has(id)) throw new Error('Hay una operación en curso sobre este proyecto.');
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= p.scenes.length) {
    throw new Error(`La escena ${index} no existe: el proyecto tiene ${p.scenes.length}.`);
  }
  const escena = p.scenes[i];
  if (visual) { escena.assetPath = null; escena.assetProvider = null; }
  if (voz) { escena.narrationPath = null; escena.narrationKey = null; }

  const pasos = [];
  if (visual) pasos.push('assets');
  if (voz) pasos.push('narration');
  if (montar) pasos.push('subtitles', 'render');
  if (!pasos.length) throw new Error('No se pidió regenerar nada.');

  return enSegundoPlano(p, `regenerar-escena-${i + 1}`, async (progreso) => {
    await runPipeline(p, { steps: pasos, onProgress: progreso });
    const ed = bloqueEditor(p);
    ed.revision += 1;
    if (montar) ed.exportedRevision = ed.revision;
  });
}

/** Exporta el MP4 del formato actual, con todo lo que hay guardado. */
export async function exportar(id) {
  const p = await cargarProyecto(id);
  if (activos.has(id)) throw new Error('Hay una operación en curso sobre este proyecto.');
  const validacion = validateProject(p);
  if (!validacion.ok) throw new Error(`No se puede exportar: ${validacion.errors.join('; ')}`);

  return enSegundoPlano(p, 'exportar', async (progreso) => {
    await runPipeline(p, {
      steps: ['assets', 'narration', 'subtitles', 'render', 'metadata'],
      onProgress: progreso,
    });
    const ed = bloqueEditor(p);
    // El MP4 recien hecho corresponde a la revision guardada: deja de estar
    // «pendiente de exportar».
    ed.exportedRevision = ed.revision;
    try { p.studio && (p.studio.export = buildExportPackage(p)); } catch { /* el paquete es opcional */ }
  });
}

export async function estadoTrabajo(id) {
  const p = await cargarProyecto(id);
  return { job: bloqueEditor(p).job, derivado: derivar(p) };
}

/**
 * Picos reales de una pista de audio, para dibujar la forma de onda.
 * Devuelve null si el archivo no existe: la interfaz muestra entonces un
 * bloque liso en vez de inventarse una onda.
 */
export async function ondaDe(id, pista, muestras) {
  const p = await cargarProyecto(id);
  let file = null;
  if (pista === 'narracion') {
    const track = path.join(workDir(p.id), 'narration.wav');
    file = fs.existsSync(track) ? track : null;
  } else if (pista === 'musica') {
    file = p.music?.path && fs.existsSync(abs(p.music.path)) ? abs(p.music.path) : null;
  } else {
    throw new Error('Pista desconocida. Usa `narracion` o `musica`.');
  }
  if (!file) return { pista, disponible: false, motivo: 'No hay archivo de audio para esta pista.', picos: [] };
  return peaks(file, { muestras });
}

export { activos as _activos };
