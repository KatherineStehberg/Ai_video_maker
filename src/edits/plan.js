import { randomUUID } from 'node:crypto';
import { SPEED_LIMITS, SYNC_MODES, estimateDuration, outputDuration, validateProposal, assertFormat } from './schema.js';
import { ASPECTS } from '../config.js';

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const round = (v, digits = 6) => Number(v.toFixed(digits));

/**
 * Construye una propuesta de edición a partir de un análisis ya calculado.
 * No vuelve a analizar, no toca FFmpeg y no llama a ningún servicio externo:
 * es aritmética sobre los cortes, la rejilla y las rampas ya medidas.
 */
export function planEdit(job, options = {}) {
  const { format = '9:16', targetDuration = null, syncMode = 'beats', enableSpeedRamps = true, approvalRequired = true } = options;

  if (!job || job.status !== 'complete') throw new Error('El análisis de origen debe existir y estar completo');
  if (!SYNC_MODES.includes(syncMode)) throw new Error(`syncMode debe ser uno de: ${SYNC_MODES.join(', ')}`);
  if (targetDuration !== null && (!Number.isFinite(targetDuration) || targetDuration <= 0)) throw new Error('targetDuration debe ser null o un número positivo de segundos');
  if (typeof approvalRequired !== 'boolean') throw new Error('approvalRequired debe ser booleano');
  const aspect = assertFormat(format, ASPECTS);

  const metadata = job.metadata, local = job.local || {}, duration = metadata.duration;
  const warnings = [];
  const tempo = local.tempo || null;

  // 1) Fronteras = cortes visuales medidos, más principio y fin del material.
  const boundaries = [0, ...(local.scenes || []).map(s => s.timestamp), duration]
    .filter(t => Number.isFinite(t) && t >= 0 && t <= duration)
    .sort((a, b) => a - b)
    .filter((t, i, a) => i === 0 || t - a[i - 1] > 1e-3);   // descarta fronteras casi idénticas

  if (boundaries.length < 2) throw new Error('El análisis no aporta fronteras utilizables para segmentar');

  // 2) Un segmento por hueco entre fronteras, a velocidad original.
  const segments = [];
  for (let i = 0; i + 1 < boundaries.length; i++) {
    segments.push({ sourceStart: boundaries[i], sourceEnd: boundaries[i + 1], speed: 1, setptsFactor: 1, reason: 'corte-detectado' });
  }

  // 3) Rampas: se reutilizan las ya calculadas contra la rejilla rítmica.
  const useBeats = syncMode === 'beats' && enableSpeedRamps;
  const applied = [];
  if (useBeats && tempo) {
    for (const ramp of local.ramps || []) {
      const segment = segments.find(s => Math.abs(s.sourceStart - ramp.start) < 1e-6 && Math.abs(s.sourceEnd - ramp.end) < 1e-6);
      if (!segment) continue;   // la rampa no corresponde a un segmento de esta propuesta
      segment.setptsFactor = ramp.setptsFactor;
      segment.speed = 1 / ramp.setptsFactor;
      segment.reason = 'beat-aligned';
      applied.push({ ...ramp, appliedTo: segments.indexOf(segment) });
    }
  } else if (syncMode === 'beats' && !tempo) {
    warnings.push(`Sin rejilla rítmica, no se alinea a beats: ${local.tempoReason || 'tempo no inferido'}. Los segmentos conservan su velocidad original.`);
  } else if (syncMode === 'beats' && !enableSpeedRamps) {
    warnings.push('enableSpeedRamps=false: se respetan los cortes pero no se alinea ninguna duración a la rejilla.');
  }

  // 4) targetDuration: factor uniforme sobre lo ya propuesto. Es una operación
  //    distinta de la alineación a beats y puede deshacerla; se avisa siempre.
  if (targetDuration !== null) {
    const natural = estimateDuration(segments);
    const wanted = targetDuration / natural;
    if (applied.length) warnings.push('targetDuration reescala todos los segmentos de forma uniforme y desplaza la alineación a beats conseguida por las rampas.');
    let clamped = false;
    for (const s of segments) {
      const desired = s.setptsFactor * wanted;
      const speed = clamp(1 / desired, SPEED_LIMITS.min, SPEED_LIMITS.max);
      if (Math.abs(speed - 1 / desired) > 1e-9) clamped = true;
      s.speed = speed; s.setptsFactor = 1 / speed;
      s.reason = s.reason === 'beat-aligned' ? 'beat-aligned+duracion-objetivo' : 'duracion-objetivo';
    }
    if (clamped) {
      warnings.push(`No se alcanza targetDuration ${targetDuration} s dentro del rango de velocidad ${SPEED_LIMITS.min}–${SPEED_LIMITS.max}×: la duración estimada alcanzable es ${estimateDuration(segments).toFixed(3)} s.`);
    }
  }

  // 5) Línea de salida contigua y redondeo estable para que el JSON sea reproducible.
  //    setptsFactor es el valor canónico (es quien fija la duración de salida) y
  //    speed se deriva de él, para que speed = 1/setptsFactor se cumpla de forma
  //    exacta y no sólo dentro de una tolerancia.
  let cursor = 0;
  for (const s of segments) {
    s.sourceStart = round(s.sourceStart); s.sourceEnd = round(s.sourceEnd);
    s.setptsFactor = round(s.setptsFactor); s.speed = 1 / s.setptsFactor;
    s.start = round(cursor); cursor += outputDuration(s); s.end = round(cursor);
  }

  // 6) Audio y advertencias honestas sobre lo que la exportación puede y no puede conservar.
  const hasAudio = (metadata.audio || []).length > 0;
  const ramped = segments.some(s => Math.abs(s.speed - 1) > 1e-6);
  const audioMode = !hasAudio ? 'none' : 'stretch';
  if (!hasAudio) warnings.push('El original no tiene pista de audio: la exportación será un MP4 sin audio.');
  if (hasAudio && ramped) {
    warnings.push('El audio se estira con atempo para seguir al vídeo: se conserva la sincronía audiovisual dentro de cada segmento, pero la MÚSICA CAMBIA DE TEMPO y los beats del resultado ya no caen donde los midió el análisis del original.');
    warnings.push('atempo hace time-stretch sin corregir formantes; en voz puede introducir artefactos audibles.');
  }
  if (metadata.frameRateMode !== 'cfr') {
    warnings.push(`El original es ${metadata.frameRateMode.toUpperCase()}: los cortes se expresan en segundos y los frames son aproximados; la exportación fuerza CFR y puede desplazar un corte hasta un frame.`);
  }

  const syncStatus = syncMode === 'beats' && !tempo ? 'datos-insuficientes' : 'propuesto';
  const proposal = {
    id: randomUUID(),
    videoJobId: job.id,
    sourceVideo: `data/analyses/${job.id}/original`,
    createdAt: new Date().toISOString(),
    format,
    dimensions: { width: aspect.width, height: aspect.height },
    syncMode, enableSpeedRamps, targetDuration,
    syncStatus,
    approvalRequired,
    approval: { status: approvalRequired ? 'pendiente' : 'no-requerida', at: null, by: null },
    segments,
    ramps: applied,
    estimatedDuration: round(cursor),
    audioMode,
    sourceDuration: duration,
    // Se copia sólo lo medido, para que la propuesta sea autocontenida y auditable.
    analysis: {
      fps: metadata.fps, frameRateMode: metadata.frameRateMode,
      width: metadata.width, height: metadata.height,
      cuts: (local.scenes || []).map(s => ({ timestamp: s.timestamp, frame: s.frame })),
      beats: (local.beats || []).map(b => ({ timestamp: b.timestamp, frame: b.frame })),
      tempo: tempo ? { bpm: tempo.bpm, period: tempo.period, score: tempo.score } : null,
      sync: local.sync ? { status: local.sync.status, ratio: local.sync.ratio ?? null } : null,
    },
    warnings,
    export: null,
    timeTransform: 'D_out = (sourceEnd - sourceStart) * setptsFactor;  speed = 1 / setptsFactor;  vídeo: setpts=PTS*setptsFactor;  audio: atempo=speed',
  };
  validateProposal(proposal, { duration });
  return proposal;
}
