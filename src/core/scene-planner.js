import { makeScene } from './project.js';
import { getTemplate } from '../templates/index.js';
import { keywordsFrom, parseScriptOutput } from './script-generator.js';
import { estimateDuration, clamp, splitSentences } from '../lib/util.js';

/**
 * Convierte un guion en escenas con duraciones coherentes.
 * 100% deterministico y offline: no necesita IA.
 */

/**
 * Divide el guion en unidades de escena.
 * Prioridad: lineas "## " > lineas sueltas > frases.
 */
export function splitScript(script, template) {
  const marked = parseScriptOutput(script);
  if (marked.length >= 2) return marked.slice(0, template.maxScenes);

  const sentences = splitSentences(script);
  if (sentences.length <= template.maxScenes) return sentences;

  // Demasiadas frases: agrupa en bloques para no pasarse de maxScenes.
  const perScene = Math.ceil(sentences.length / template.maxScenes);
  const out = [];
  for (let i = 0; i < sentences.length; i += perScene) {
    out.push(sentences.slice(i, i + perScene).join(' '));
  }
  return out;
}

/**
 * Genera escenas a partir del guion del proyecto.
 * Conserva assets/narraciones de escenas existentes cuyo texto no cambio,
 * para no perder trabajo manual al regenerar.
 */
export function planScenes(project, { keepExisting = true } = {}) {
  const template = getTemplate(project.template);
  const chunks = splitScript(project.script || '', template);
  if (!chunks.length) return [];

  const previous = new Map();
  if (keepExisting) {
    for (const s of project.scenes || []) {
      if (s.text?.trim()) previous.set(s.text.trim(), s);
    }
  }

  const [minSec, maxSec] = template.sceneSeconds;

  // Todas las escenas a la vista: una palabra que sale en todas no distingue a
  // ninguna, y eso solo se sabe mirando el guion entero.
  const guion = chunks.map(c => c.trim());
  const scenes = chunks.map((text, i) => {
    const clean = text.trim();
    const prev = previous.get(clean);
    const natural = estimateDuration(clean, template.wpm);
    const duration = clamp(natural, minSec, maxSec);

    return makeScene({
      ...(prev || {}),
      id: prev?.id,
      text: clean,
      duration: prev?.durationLocked ? prev.duration : Number(duration.toFixed(2)),
      visualPrompt: prev?.visualPrompt || keywordsFrom(clean, 3, { contexto: guion.filter((_, j) => j !== i) }),
      assetPath: prev?.assetPath || null,
      narrationPath: prev?.narrationPath || null,
      kenBurns: prev?.kenBurns || template.kenBurns,
      // La ultima escena cierra sin transicion de salida.
      transition: i === chunks.length - 1 ? 'none' : (prev?.transition || template.transition),
      caption: prev?.caption ?? null,
      onScreenTitle: prev?.onScreenTitle || '',
    });
  });

  return scenes;
}

/**
 * Ajusta duraciones para acercarse al objetivo del template.
 * Escala proporcionalmente respetando los minimos/maximos por escena.
 */
export function fitToTarget(scenes, template, targetSeconds = null) {
  if (!scenes.length) return scenes;
  const [minTarget, maxTarget] = template.targetSeconds;
  const total = scenes.reduce((a, s) => a + s.duration, 0);
  const goal = targetSeconds || (total < minTarget ? minTarget : total > maxTarget ? maxTarget : total);
  if (Math.abs(total - goal) < 0.5) return scenes;

  const factor = goal / total;
  const [minSec, maxSec] = template.sceneSeconds;
  return scenes.map((s) => ({
    ...s,
    duration: Number(clamp(s.duration * factor, minSec, maxSec).toFixed(2)),
  }));
}

/**
 * Sincroniza la duracion de cada escena con la duracion real de su narracion.
 * Se llama despues del TTS: el audio manda sobre la estimacion.
 */
export function syncDurationsToNarration(scenes, durations, { padding = 0.45 } = {}) {
  return scenes.map((s, i) => {
    const d = durations[i];
    if (!Number.isFinite(d) || d <= 0) return s;
    return { ...s, duration: Number((d + padding).toFixed(2)) };
  });
}

/** Resumen de la estructura para previsualizar sin renderizar. */
export function outline(project) {
  const template = getTemplate(project.template);
  const scenes = project.scenes || [];
  const total = scenes.reduce((a, s) => a + (s.duration || 0), 0);
  const [minT, maxT] = template.targetSeconds;
  return {
    template: template.name,
    sceneCount: scenes.length,
    totalSeconds: Number(total.toFixed(2)),
    targetSeconds: template.targetSeconds,
    withinTarget: total >= minT && total <= maxT,
    scenesWithAsset: scenes.filter((s) => s.assetPath).length,
    scenesWithNarration: scenes.filter((s) => s.narrationPath).length,
    words: scenes.reduce((a, s) => a + String(s.text || '').split(/\s+/).filter(Boolean).length, 0),
    scenes: scenes.map((s, i) => ({
      n: i + 1,
      id: s.id,
      seconds: s.duration,
      text: String(s.text || '').slice(0, 90),
      hasAsset: Boolean(s.assetPath),
      hasNarration: Boolean(s.narrationPath),
    })),
  };
}
