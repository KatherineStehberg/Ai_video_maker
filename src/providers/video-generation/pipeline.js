import fs from 'node:fs';
import path from 'node:path';
import { makeProject, makeScene, saveProject } from '../../core/project.js';
import { runPipeline } from '../../core/pipeline.js';
import { buildNarrationTrack } from '../../core/tts.js';
import { draftScript, escenasAGuion } from '../../generation/script.js';
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

/** Template adecuado según lo que se pide: duración manda sobre el resto. */
export function elegirTemplate(spec) {
  const d = Number(spec.duration) || 60;
  if (d <= 20) return 'reel-promocional';
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

    // 1. Guion: se reutiliza el borrador ya revisado por la usuaria si viene;
    //    si no, se redacta ahora (LLM si hay, plantilla local si no).
    onProgress(5, 'Redactando el guion');
    const borrador = Array.isArray(spec.escenas) && spec.escenas.length
      ? { escenas: spec.escenas, source: spec.scriptSource || 'editado', templateId }
      : await draftScript(spec, { templateId });

    const template = templateId;
    const escenas = borrador.escenas;

    // 2. Proyecto con el guion y las escenas ya resueltas: el pipeline no
    //    vuelve a inventarlas, sólo produce a partir de ellas.
    onProgress(12, `Preparando ${escenas.length} escenas`);
    const aspectRatio = ASPECTS[spec.format] ? spec.format : '9:16';

    // Voz: se busca una española entre las instaladas. Si no hay, se avisa y
    // se narra igualmente, pero nunca en silencio sobre el problema.
    const voz = await vozDisponible();
    const project = makeProject({
      title: borrador.tema || String(spec.prompt).slice(0, 60),
      brand: 'personal',
      template,
      aspectRatio,
      exportFormats: [aspectRatio],
      brief: spec.prompt,
      audience: spec.audience || '',
      script: escenasAGuion(escenas),
      voice: { provider: voz.provider === 'none' ? 'none' : 'auto', name: voz.nombre || '', enabled: voz.provider !== 'none' },
      music: { enabled: Boolean(spec.musicPath), path: spec.musicPath || null, volume: 0.12 },
      captions: { enabled: true, burnIn: true },
    });
    project.scenes = aEscenasProyecto(escenas, template);
    saveProject(project);

    // 3. Producción en dos fases: primero visuales y voz, luego se AJUSTA la
    //    duración al objetivo, y sólo entonces se generan subtítulos y render.
    //    El orden importa: los subtítulos se calculan sobre el audio final.
    const etapas = { assets: 'Buscando visuales', narration: 'Generando la voz', subtitles: 'Creando subtítulos', render: 'Montando el video' };
    // En modo automático no se fuerza ninguna duración: manda el guion.
    const objetivo = spec.duration === null || spec.duration === 'auto' ? null : Number(spec.duration) || null;

    const informeA = await runPipeline(project, {
      steps: ['assets', 'narration'],
      onProgress: p => onProgress(15 + Math.round(p.pct * 0.45), etapas[p.step] || p.message),
    });

    const ajuste = objetivo
      ? await ajustarDuracion(project, objetivo, { onProgress: msg => onProgress(58, msg) })
      : { ajustado: false, motivo: 'sin duración objetivo' };

    const informeB = await runPipeline(project, {
      steps: ['subtitles', 'render'],
      onProgress: p => onProgress(62 + Math.round(p.pct * 0.35), etapas[p.step] || p.message),
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
    const desfase = objetivo && duracionReal ? Number((duracionReal - objetivo).toFixed(2)) : null;

    const notes = [
      `Guion: ${borrador.source === 'llm' ? `redactado por el modelo ${borrador.provider}` : borrador.source === 'editado' ? 'editado por ti' : 'plantilla local, sin IA'}.`,
      `Visuales: ${visualSources.join(', ')}.`,
      narracion === 'none'
        ? 'Sin voz: no había motor TTS disponible.'
        : `Voz: ${voz.nombre || narracion} (${voz.etiqueta}).`,
      ...(voz.aviso ? [voz.aviso] : []),
      'Subtítulos sincronizados con la narración y quemados en el video.',
      ...(duracionReal ? [`Duración pedida ${objetivo} s, real ${duracionReal.toFixed(2)} s (desfase ${desfase >= 0 ? '+' : ''}${desfase} s).`] : []),
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
        duracion: { pedida: objetivo, real: duracionReal, desfase, dentroDeTolerancia: desfase === null ? null : Math.abs(desfase) <= TOLERANCIA_SEGUNDOS },
        ajuste,
      },
      script: { source: borrador.source, tema: borrador.tema ?? null, escenas },
      notes,
    };
  },
};
