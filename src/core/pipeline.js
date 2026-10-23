import fs from 'node:fs';
import path from 'node:path';
import { STATUS, saveProject, validateProject, logToProject } from './project.js';
import { loadBrand } from './brands.js';
import { getTemplate } from '../templates/index.js';
import { generateScript, suggestVisualPrompts } from './script-generator.js';
import { planScenes, fitToTarget, syncDurationsToNarration } from './scene-planner.js';
import { ensureSceneAssets, missingAssets } from './asset-manager.js';
import { narrateProject, buildNarrationTrack } from './tts.js';
import { generateSubtitles } from './subtitles.js';
import { renderProject } from './renderer.js';
import { buildMetadata } from '../providers/publish/index.js';
import { workDir, abs, rel } from '../lib/paths.js';
import { logger } from '../lib/logger.js';

const log = logger('pipeline');

/**
 * Pipeline completo:
 *   guion -> escenas -> assets -> TTS -> subtitulos -> render -> export -> metadatos
 *
 * Cada etapa es opcional e idempotente. El pipeline NUNCA requiere IA:
 * sin LLM el guion viene del usuario, sin TTS el video sale en silencio.
 */

export const STEPS = ['script', 'scenes', 'assets', 'narration', 'subtitles', 'render', 'metadata'];

/**
 * Traduce el paso que informa el renderer al paso que publica el pipeline.
 *
 * Se conservan `scene`, `concat`, `audio` y `encode` porque describen lo que
 * está pasando de verdad y alimentan el contador de escenas de la interfaz.
 *
 * `done` es la excepción: el renderer lo emite al terminar CADA formato, y
 * `STEP_TO_STATUS` de core/jobs.js lo traduce a COMPLETED. Dejarlo pasar
 * marcaría el trabajo como terminado tras el primer formato, con los demás
 * formatos y los metadatos todavía pendientes.
 */
export const pasoDeRender = paso => (paso === 'done' ? 'render' : (paso || 'render'));

export async function runPipeline(project, {
  steps = STEPS,
  onProgress = () => {},
  formats = null,
  stopOnMissingAssets = false,
  force = {},
} = {}) {
  const brand = loadBrand(project.brand);
  const template = getTemplate(project.template);
  const want = new Set(steps);
  const report = { steps: {}, warnings: [], errors: [] };

  const emit = (step, pct, message, extra = {}) =>
    onProgress({ step, pct, message, projectId: project.id, ...extra });

  try {
    // ---------- 1. GUION ----------
    if (want.has('script')) {
      project.status = STATUS.SCRIPTING;
      saveProject(project);
      emit('script', 5, 'Generando guion');
      const res = await generateScript(project, brand, {});
      project.script = res.script;
      report.steps.script = { source: res.source, provider: res.providerId || null, error: res.error };
      if (res.source === 'skeleton') {
        report.warnings.push('Sin LLM: se genero un esqueleto de guion. Editalo antes de renderizar.');
      }
      logToProject(project, `Guion (${res.source})`);
      saveProject(project);
    }

    // ---------- 2. ESCENAS ----------
    if (want.has('scenes')) {
      emit('scenes', 15, 'Dividiendo en escenas');
      let scenes = planScenes(project, { keepExisting: true });
      scenes = fitToTarget(scenes, template);
      project.scenes = scenes;
      report.steps.scenes = { count: scenes.length };
      logToProject(project, `${scenes.length} escenas`);
      saveProject(project);

      // Prompts visuales: usa LLM si hay, si no deriva palabras clave.
      if (scenes.some((s) => !s.visualPrompt)) {
        const prompts = await suggestVisualPrompts(project, {});
        project.scenes.forEach((s, i) => { s.visualPrompt = s.visualPrompt || prompts[i] || ''; });
        saveProject(project);
      }
    }

    if (!project.scenes?.length) {
      throw new Error('No hay escenas. Escribe un guion o define escenas manualmente.');
    }

    // ---------- 3. ASSETS ----------
    if (want.has('assets')) {
      project.status = STATUS.ASSETS_PENDING;
      saveProject(project);
      emit('assets', 25, 'Resolviendo visuales');
      const res = await ensureSceneAssets(project, brand, {
        // `index` y `total` viajan hasta arriba: son el progreso REAL que
        // muestra la interfaz («escena 34 de 105»), no un porcentaje inventado.
        onProgress: (p) => emit('assets', 25 + Math.round((p.index / p.total) * 10), `Visual ${p.index + 1}/${p.total}`, { index: p.index, total: p.total }),
        force: force.assets,
      });
      report.steps.assets = { resolved: res.filter((r) => r.path).length, total: res.length };
      const missing = missingAssets(project);
      if (missing.length && stopOnMissingAssets) {
        project.status = STATUS.HUMAN_REVIEW_REQUIRED;
        report.warnings.push(`${missing.length} escenas sin visual: requiere intervencion humana`);
        saveProject(project);
        return { ...report, stopped: 'assets_pending', project };
      }
      saveProject(project);
    }

    // ---------- 4. NARRACION ----------
    if (want.has('narration')) {
      emit('narration', 38, 'Generando narracion');
      const res = await narrateProject(project, {
        force: force.narration,
        onProgress: (p) => emit('narration', 38 + Math.round((p.index / p.total) * 12), `Voz ${p.index + 1}/${p.total}`, { index: p.index, total: p.total }),
      });
      report.steps.narration = { provider: res.provider, errors: res.errors?.length || 0, voice: res.voice || null, voices: res.voices || null };
      // Desajuste entre idioma declarado y voz elegida: ya corregido, pero visible.
      if (res.warnings?.length) report.warnings.push(...res.warnings);
      if(project.studio && project.voice?.enabled && (res.provider==='none' || res.errors?.length)) {
        throw new Error('La narración solicitada no se pudo completar. Configura la voz o elige explícitamente sin narración.');
      }

      if (res.provider === 'none') {
        report.warnings.push('Sin motor TTS disponible: el video se renderiza en silencio.');
      } else {
        project.scenes.forEach((s, i) => { s.narrationPath = res.narrations[i] || s.narrationPath; });
        // El audio real manda sobre la estimacion de duracion.
        if (res.durations?.some(Boolean)) {
          project.scenes = syncDurationsToNarration(project.scenes, res.durations);
        }
        saveProject(project);
        emit('narration', 52, 'Construyendo pista de voz');
        const track = await buildNarrationTrack(project);
        report.steps.narration.track = track;
      }
      saveProject(project);
    }

    // ---------- 5. SUBTITULOS ----------
    let subs = null;
    if (want.has('subtitles')) {
      emit('subtitles', 56, 'Creando subtitulos');
      subs = await generateSubtitles(project, {});
      project.captions = { ...project.captions, file: subs };
      report.steps.subtitles = { file: subs };
      saveProject(project);
    } else if (project.captions?.file && fs.existsSync(abs(project.captions.file))) {
      subs = project.captions.file;
    }

    // ---------- 6. RENDER ----------
    if (want.has('render')) {
      const validation = validateProject(project);
      report.warnings.push(...validation.warnings);
      if (!validation.ok) {
        project.status = STATUS.FAILED;
        project.error = validation.errors.join('; ');
        saveProject(project);
        throw new Error(`Proyecto invalido: ${validation.errors.join('; ')}`);
      }

      project.status = STATUS.RENDERING;
      project.error = null;
      saveProject(project);

      const targets = formats?.length
        ? formats
        : (project.exportFormats?.length ? project.exportFormats : [project.aspectRatio]);

      const outputs = { ...(project.outputs || {}) };
      for (let i = 0; i < targets.length; i++) {
        const fmt = targets[i];
        const base = 60 + Math.round((i / targets.length) * 35);
        const span = Math.round(35 / targets.length);
        const res = await renderProject(project, brand, {
          aspectRatio: fmt,
          subtitlesPath: subs,
          onProgress: (p) => emit(pasoDeRender(p.step),
            base + Math.round((p.pct / 100) * span), p.message || `Render ${fmt}`,
            { format: fmt, index: p.index, total: p.total }),
        });
        outputs[fmt] = res.file;
        logToProject(project, `Render ${fmt} -> ${res.file} (${(res.bytes / 1e6).toFixed(1)} MB)`);
      }
      project.outputs = outputs;
      project.outputPath = outputs[project.aspectRatio] || Object.values(outputs)[0] || null;
      report.steps.render = { outputs };
      saveProject(project);
    }

    // ---------- 7. METADATOS ----------
    if (want.has('metadata')) {
      emit('metadata', 97, 'Generando metadatos de publicacion');
      project.metadata = buildMetadata(project, brand);
      const metaFile = path.join(workDir(project.id), 'metadata.json');
      fs.writeFileSync(metaFile, JSON.stringify(project.metadata, null, 2), 'utf8');
      report.steps.metadata = { file: rel(metaFile), platforms: Object.keys(project.metadata) };
      saveProject(project);
    }

    project.status = want.has('render') ? STATUS.COMPLETED : STATUS.DRAFT;
    project.error = null;
    saveProject(project);
    emit('done', 100, 'Completado');
    return { ...report, project };
  } catch (e) {
    log.error('Pipeline fallo:', e.message);
    project.status = STATUS.FAILED;
    project.error = e.message;
    logToProject(project, `ERROR: ${e.message}`);
    saveProject(project);
    report.errors.push(e.message);
    throw Object.assign(e, { report });
  }
}

/** Atajo: render only, para reabrir un proyecto y volver a renderizarlo. */
export async function rerender(project, opts = {}) {
  return runPipeline(project, {
    ...opts,
    steps: ['subtitles', 'render', 'metadata'],
  });
}
