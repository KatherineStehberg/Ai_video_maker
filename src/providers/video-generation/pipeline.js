import fs from 'node:fs';
import path from 'node:path';
import { makeProject, makeScene, saveProject, loadProject } from '../../core/project.js';
import { runPipeline } from '../../core/pipeline.js';
import { buildNarrationTrack } from '../../core/tts.js';
import { draftScript, escenasAGuion } from '../../generation/script.js';
import { contarPalabras, WPM_POR_DEFECTO, formatearDuracion } from '../../generation/segmenter.js';
import { vozDisponible } from '../../generation/voice.js';
import { abs } from '../../lib/paths.js';
import { ffmpegRun, probeDuration } from '../../lib/ffmpeg.js';
import { ASPECTS } from '../../config.js';

/** Tolerancia aceptada entre la duración pedida y la real. */
export const TOLERANCIA_SEGUNDOS = 1;

/** Límites de `atempo` que aún suenan naturales en voz hablada. */
const TEMPO_MIN = 0.7, TEMPO_MAX = 1.6;

/**
 * Ajusta la duración real del video a la pedida, DESPUÉS de sintetizar la voz.
 *
 * El guion se redacta con un presupuesto de palabras, pero la duración real la
 * decide el motor de voz, que nunca coincide exactamente. Aquí se mide el audio
 * generado y se corrige su velocidad con `atempo`, que cambia el tempo sin
 * alterar el tono. No se corta ninguna palabra ni ningún subtítulo: sólo se
 * habla algo más rápido o más lento.
 *
 * Si el desfase excede lo que `atempo` puede corregir sin que la voz suene
 * antinatural, se corrige lo posible y se informa del resto.
 */
export async function ajustarDuracion(project, objetivo, { onProgress = () => {} } = {}) {
  const escenas = project.scenes || [];
  const conVoz = escenas.filter(s => s.narrationPath);
  if (!conVoz.length) {
    // Sin narración la duración la fijan las escenas: se escala directamente.
    const total = escenas.reduce((a, s) => a + s.duration, 0);
    if (!total) return { ajustado: false, motivo: 'proyecto sin duración' };
    const k = objetivo / total;
    for (const s of escenas) s.duration = Number((s.duration * k).toFixed(2));
    return { ajustado: true, metodo: 'escalado-visual', factor: k, estimada: objetivo };
  }

  const duraciones = [];
  for (const s of escenas) {
    duraciones.push(s.narrationPath ? (await probeDuration(abs(s.narrationPath))) || 0 : 0);
  }
  const sumaAudio = duraciones.reduce((a, b) => a + b, 0);
  if (sumaAudio <= 0) return { ajustado: false, motivo: 'no se pudo medir la narración' };

  // Un respiro por escena, proporcional a lo corto que sea el video.
  const respiro = Math.min(0.35, (objetivo * 0.12) / escenas.length);
  const disponible = objetivo - respiro * escenas.length;
  if (disponible <= 0) return { ajustado: false, motivo: 'objetivo demasiado corto para el número de escenas' };

  const k = disponible / sumaAudio;              // cuánto debe durar el audio
  const tempoIdeal = 1 / k;                      // atempo necesario
  const tempo = Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, tempoIdeal));
  const limitado = Math.abs(tempo - tempoIdeal) > 1e-6;

  if (Math.abs(tempoIdeal - 1) < 0.02) {
    return { ajustado: false, motivo: 'ya estaba dentro de la tolerancia', estimada: sumaAudio + respiro * escenas.length };
  }

  onProgress(`Ajustando el ritmo de la voz (×${tempo.toFixed(2)}) para durar ${objetivo} s`);
  let nuevaSuma = 0;
  for (const [i, s] of escenas.entries()) {
    if (!s.narrationPath || !duraciones[i]) { nuevaSuma += 0; continue; }
    const origen = abs(s.narrationPath);
    const temporal = path.join(path.dirname(origen), `tempo_${path.basename(origen)}`);
    await ffmpegRun(['-i', origen, '-filter:a', `atempo=${tempo.toFixed(4)}`, '-c:a', 'pcm_s16le', temporal]);
    fs.renameSync(temporal, origen);
    const medida = (await probeDuration(origen)) || duraciones[i] / tempo;
    s.duration = Number((medida + respiro).toFixed(2));
    nuevaSuma += s.duration;
  }

  // La pista completa se reconstruye: los WAV por escena han cambiado.
  await buildNarrationTrack(project);
  saveProject(project);

  return {
    ajustado: true, metodo: 'atempo', factor: tempo, limitado,
    estimada: Number(nuevaSuma.toFixed(2)),
    aviso: limitado
      ? `El guion no cabía en ${objetivo} s hablando a una velocidad natural: se ajustó al límite (×${tempo.toFixed(2)}) y durará unos ${nuevaSuma.toFixed(1)} s. Acorta el guion para ajustarlo del todo.`
      : null,
  };
}

/**
 * PROVEEDOR "pipeline" — video real a partir del prompt, montado en local.
 *
 * NO es un modelo de texto-a-video. Reutiliza el pipeline que ya existe en el
 * repositorio: guion → escenas → visuales → voz → subtítulos → render FFmpeg.
 * El resultado muestra el texto del guion en pantalla, se narra con la voz
 * local y lleva subtítulos sincronizados, así que su contenido SÍ corresponde
 * al prompt, aunque las imágenes de fondo sean generadas o de banco.
 *
 * Coste: cero con la configuración por defecto (voz local SAPI/Piper, fondos
 * generados con FFmpeg). Sube sólo si se activan proveedores externos, y en
 * ese caso el trabajo lo declara en `visualSources`.
 */

/**
 * Template adecuado según lo que se pide.
 *
 * Cuando hay un GUION propio, su extensión manda sobre cualquier otra señal:
 * un guion de 1 400 palabras es una clase, no un reel, y necesita escenas
 * largas y ritmo pausado aunque nadie haya pedido una duración.
 */
export function elegirTemplate(spec) {
  const palabras = contarPalabras(spec.script || '');
  if (palabras > 0) {
    const segundos = (palabras / (Number(spec.wpm) || WPM_POR_DEFECTO)) * 60;
    if (segundos >= 300) return 'video-curso';         // 5 min o más: clase
    if (segundos >= 60) return 'video-explicativo';    // 1-5 min: explicativo
    if (segundos >= 25) return 'short-educativo';
    return 'reel-promocional';
  }

  // Sin guion propio manda la duración objetivo, como hasta ahora.
  const d = Number(spec.duration) || 60;
  if (d <= 20) return 'reel-promocional';
  if (d >= 300) return 'video-curso';
  if (d >= 90) return 'video-explicativo';
  if (d >= 45) return 'short-educativo';
  return /promo|vende|oferta|producto|servicio|clase|curso/i.test(spec.prompt || '')
    ? 'reel-promocional' : 'short-educativo';
}

/** Convierte las escenas del borrador en escenas del proyecto. */
const aEscenasProyecto = (escenas, template) => escenas.map((e, i) => makeScene({
  text: e.text,
  onScreenTitle: e.onScreenTitle || '',
  visualPrompt: e.visualPrompt || '',
  duration: e.duration,
  kenBurns: e.kenBurns || 'auto',
  transition: i === escenas.length - 1 ? 'none' : 'fade',
}));

export const pipelineProvider = {
  id: 'pipeline',
  label: 'Montaje local (guion + voz + imágenes + FFmpeg)',
  mock: false,
  configured: () => true,
  requires: [],

  /**
   * @param {object} spec  { prompt, duration, format, style, audience, platform, music, escenas? }
   * @param {object} opts  { workDir, onProgress }
   */
  async generate(spec, { onProgress = () => {} } = {}) {
    const templateId = spec.templateId || elegirTemplate(spec);

    // 0. REANUDACIÓN: si viene un proyecto anterior, se retoma tal cual. Sus
    //    WAV de voz y sus clips MP4 siguen en disco, y tanto el TTS como el
    //    render comprueban una huella antes de rehacer nada, así que lo ya
    //    terminado se salta solo. Esto es lo que evita empezar de cero.
    const previo = spec.resumeProjectId ? loadProject(spec.resumeProjectId) : null;

    // 1. Guion: se reutiliza el borrador ya revisado por la usuaria si viene;
    //    si no, se redacta ahora (LLM si hay, plantilla local si no).
    onProgress(5, 'Preparando el guion', { estado: 'preparando-guion' });
    const borrador = previo
      ? { escenas: previo.scenes.map(s => ({ role: 'point', text: s.text, onScreenTitle: s.onScreenTitle, visualPrompt: s.visualPrompt, duration: s.duration })),
        source: spec.scriptSource || 'reanudado', tema: previo.title, templateId }
      : Array.isArray(spec.escenas) && spec.escenas.length
        ? { escenas: spec.escenas, source: spec.scriptSource || 'editado', templateId }
        : await draftScript(spec, { templateId });

    const template = templateId;
    const escenas = borrador.escenas;
    const totales = escenas.length;

    // 2. Proyecto con el guion y las escenas ya resueltas: el pipeline no
    //    vuelve a inventarlas, sólo produce a partir de ellas.
    onProgress(12, `Preparando ${totales} escenas`, { estado: 'creando-escenas', hechas: 0, totales });
    const aspectRatio = ASPECTS[spec.format] ? spec.format : '9:16';

    // Voz: se busca una española entre las instaladas. Si no hay, se avisa y
    // se narra igualmente, pero nunca en silencio sobre el problema.
    const voz = await vozDisponible();
    const vozPedida = spec.voice || null;
    const musica = spec.musicTrack || null;
    const subtitulos = spec.subtitles || { enabled: true, burnIn: true };

    const project = previo || makeProject({
      title: spec.title || borrador.tema || String(spec.prompt || '').slice(0, 60) || 'Video',
      // La marca es configuración del proyecto, no una constante del código.
      brand: spec.brandId || 'personal',
      template,
      aspectRatio,
      exportFormats: [aspectRatio],
      brief: spec.prompt || '',
      audience: spec.audience || '',
      script: escenasAGuion(escenas),
      voice: vozPedida?.enabled === false
        ? { provider: 'none', name: '', enabled: false }
        : { provider: vozPedida?.provider && vozPedida.provider !== 'auto' ? vozPedida.provider : (voz.provider === 'none' ? 'none' : 'auto'),
          name: vozPedida?.name || voz.nombre || '',
          rate: vozPedida?.rate ?? 0,
          enabled: voz.provider !== 'none' },
      music: musica?.path
        ? { enabled: musica.enabled !== false, path: musica.path, volume: musica.volume ?? 0.12 }
        : { enabled: Boolean(spec.musicPath), path: spec.musicPath || null, volume: 0.12 },
      captions: { enabled: subtitulos.enabled !== false, burnIn: subtitulos.burnIn !== false },
      // Logo del proyecto: si no se indica, se usa el de la marca. Nunca hay
      // un logo concreto incrustado en el código.
      assets: spec.logo?.path ? { logo: spec.logo.path } : {},
    });
    if (!previo) project.scenes = aEscenasProyecto(escenas, template);
    saveProject(project);
    // Se publica el id ANTES de producir nada pesado: si algo falla después,
    // ya hay por dónde reanudar.
    onProgress(13, `Proyecto ${project.id} preparado`, { estado: 'creando-escenas', hechas: totales, totales, projectId: project.id });

    // 3. Producción en dos fases: primero visuales y voz, luego se AJUSTA la
    //    duración al objetivo, y sólo entonces se generan subtítulos y render.
    //    El orden importa: los subtítulos se calculan sobre el audio final.
    const etapas = { assets: 'Buscando visuales', narration: 'Generando la voz', subtitles: 'Creando subtítulos', render: 'Montando el video' };
    // Traducción de la etapa interna del pipeline al estado que ve la usuaria.
    const ESTADO = {
      assets: 'buscando-visuales', narration: 'generando-voz',
      subtitles: 'creando-subtitulos', scene: 'renderizando-segmentos',
      encode: 'concatenando', concat: 'concatenando',
      audio: 'concatenando', compose: 'concatenando',
    };

    /**
     * Pasos que ocurren UNA VEZ POR ESCENA. Sólo en ellos tiene sentido un
     * contador parcial; en los demás todas las escenas ya están hechas.
     */
    const POR_ESCENA = new Set(['assets', 'narration', 'scene']);

    /**
     * Progreso real: las escenas hechas salen del propio pipeline, no de un
     * reloj.
     *
     * Una etapa emite varias veces, y no todas traen índice de escena: la
     * primera llamada anuncia el comienzo, y algunas intermedias (construir la
     * pista de voz, mezclar el audio) son de proyecto, no de escena. Por eso se
     * guarda la marca más alta alcanzada en cada etapa: el contador nunca
     * retrocede, y nunca afirma más escenas de las que se han contado.
     */
    const maximos = new Map();
    const reportar = (base, span) => p => {
      // `render` sin índice es la pasada final de composición, no el montaje
      // de escenas: llamarlo «renderizando segmentos» haría retroceder la
      // etapa mostrada después de haber dicho «concatenando».
      const estado = ESTADO[p.step] || (p.step === 'render' ? 'concatenando' : null);
      const contadas = Number.isInteger(p.index)
        ? p.index + 1
        // Sin índice: en una etapa por escena es que acaba de empezar; en una
        // de proyecto, que ya no queda ninguna escena pendiente.
        : (POR_ESCENA.has(p.step) ? 0 : totales);
      const hechas = Math.max(maximos.get(estado) ?? 0, contadas);
      if (estado) maximos.set(estado, hechas);

      onProgress(base + Math.round(p.pct * span), etapas[p.step] || p.message, {
        estado,
        hechas,
        totales: p.total || totales,
        detalle: p.message || null,
        projectId: project.id,
      });
    };

    // En modo automático no se fuerza ninguna duración: manda el guion.
    const objetivo = spec.duration === null || spec.duration === undefined || spec.duration === 'auto'
      ? null : Number(spec.duration) || null;

    const informeA = await runPipeline(project, {
      steps: ['assets', 'narration'],
      onProgress: reportar(15, 0.45),
    });

    const ajuste = objetivo
      ? await ajustarDuracion(project, objetivo, { onProgress: msg => onProgress(58, msg, { estado: 'generando-voz', hechas: totales, totales, projectId: project.id }) })
      : { ajustado: false, motivo: 'sin duración objetivo' };

    const informeB = await runPipeline(project, {
      steps: ['subtitles', 'render'],
      onProgress: reportar(62, 0.35),
    });

    const informe = {
      steps: { ...informeA.steps, ...informeB.steps },
      warnings: [...(informeA.warnings || []), ...(informeB.warnings || [])],
    };

    const salida = project.outputPath || Object.values(project.outputs || {})[0];
    if (!salida || !fs.existsSync(abs(salida))) throw new Error('El montaje terminó sin producir un MP4.');

    // 4. Procedencia de cada pieza, para que la interfaz no tenga que adivinar.
    const visualSources = [...new Set(project.scenes.map(s => s.assetProvider || 'placeholder'))];
    const narracion = informe.steps?.narration?.provider || 'none';
    const duracionReal = (await probeDuration(abs(salida))) || null;
    const duracionPrevista = Number(project.scenes.reduce((a, s) => a + (Number(s.duration) || 0), 0).toFixed(2));
    const desfase = objetivo && duracionReal ? Number((duracionReal - objetivo).toFixed(2)) : null;

    const notes = [
      `Guion: ${borrador.source === 'llm' ? `redactado por el modelo ${borrador.provider}` : borrador.source === 'editado' ? 'editado por ti' : 'plantilla local, sin IA'}.`,
      `Visuales: ${visualSources.join(', ')}.`,
      narracion === 'none'
        ? 'Sin voz: no había motor TTS disponible.'
        : `Voz: ${voz.nombre || narracion} (${voz.etiqueta}).`,
      ...(voz.aviso ? [voz.aviso] : []),
      'Subtítulos sincronizados con la narración y quemados en el video.',
      // Prevista vs real, siempre: la prevista sale del guion, la real de ffprobe.
      `Duración prevista ${formatearDuracion(duracionPrevista)}${duracionReal ? `, real ${formatearDuracion(duracionReal)}` : ' (no medida)'}.`,
      ...(objetivo && duracionReal
        ? [`Duración pedida ${objetivo} s, real ${duracionReal.toFixed(2)} s (desfase ${desfase >= 0 ? '+' : ''}${desfase} s).`]
        : []),
      ...(ajuste.aviso ? [ajuste.aviso] : []),
      ...(informe.warnings || []),
    ];

    return {
      file: abs(salida),
      provider: 'pipeline',
      mock: false,
      model: `pipeline:${template}`,
      spec: {
        escenas: escenas.length,
        template,
        guion: borrador.source,
        visualSources,
        narracion,
        subtitulos: Boolean(informe.steps?.subtitles?.file),
        projectId: project.id,
        voz: { nombre: voz.nombre, provider: voz.provider, esEspanol: voz.esEspanol, etiqueta: voz.etiqueta },
        duracion: {
          pedida: objetivo, prevista: duracionPrevista, real: duracionReal, desfase,
          dentroDeTolerancia: desfase === null ? null : Math.abs(desfase) <= TOLERANCIA_SEGUNDOS,
        },
        palabras: contarPalabras(project.scenes.map(s => s.text).join(' ')),
        brand: project.brand,
        reanudado: Boolean(previo),
        ajuste,
      },
      script: { source: borrador.source, tema: borrador.tema ?? null, escenas },
      notes,
    };
  },
};
