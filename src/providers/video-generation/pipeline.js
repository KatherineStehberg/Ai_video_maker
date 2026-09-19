import fs from 'node:fs';
import { makeProject, makeScene, saveProject } from '../../core/project.js';
import { runPipeline } from '../../core/pipeline.js';
import { draftScript, escenasAGuion } from '../../generation/script.js';
import { abs } from '../../lib/paths.js';
import { ASPECTS } from '../../config.js';

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
  if (spec.duration <= 20) return 'reel-promocional';
  if (spec.duration >= 45) return 'short-educativo';
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
    const project = makeProject({
      title: borrador.tema || String(spec.prompt).slice(0, 60),
      brand: 'personal',
      template,
      aspectRatio,
      exportFormats: [aspectRatio],
      brief: spec.prompt,
      audience: spec.audience || '',
      script: escenasAGuion(escenas),
      voice: { provider: 'auto', enabled: true },
      music: { enabled: Boolean(spec.musicPath), path: spec.musicPath || null, volume: 0.12 },
      captions: { enabled: true, burnIn: true },
    });
    project.scenes = aEscenasProyecto(escenas, template);
    saveProject(project);

    // 3. Producción. Se omiten 'script' y 'scenes': ya están decididas arriba.
    const etapas = { assets: 'Buscando visuales', narration: 'Generando la voz', subtitles: 'Creando subtítulos', render: 'Montando el video' };
    const informe = await runPipeline(project, {
      steps: ['assets', 'narration', 'subtitles', 'render'],
      onProgress: p => onProgress(15 + Math.round(p.pct * 0.8), etapas[p.step] || p.message),
    });

    const salida = project.outputPath || Object.values(project.outputs || {})[0];
    if (!salida || !fs.existsSync(abs(salida))) throw new Error('El montaje terminó sin producir un MP4.');

    // 4. Procedencia de cada pieza, para que la interfaz no tenga que adivinar.
    const visualSources = [...new Set(project.scenes.map(s => s.assetProvider || 'placeholder'))];
    const narracion = informe.steps?.narration?.provider || 'none';
    const notes = [
      `Guion: ${borrador.source === 'llm' ? `redactado por el modelo ${borrador.provider}` : borrador.source === 'editado' ? 'editado por ti' : 'plantilla local, sin IA'}.`,
      `Visuales: ${visualSources.join(', ')}.`,
      narracion === 'none' ? 'Sin voz: no había motor TTS disponible.' : `Voz local: ${narracion}.`,
      'Subtítulos sincronizados con la narración y quemados en el video.',
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
      },
      script: { source: borrador.source, tema: borrador.tema ?? null, escenas },
      notes,
    };
  },
};
