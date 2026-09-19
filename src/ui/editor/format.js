/**
 * Derivaciones puras para la vista: resúmenes, textos de advertencia y el
 * modelo de la timeline. Sin DOM, para poder testearlas en Node.
 */
import { formatBytes } from './state.js';

/** Límites de velocidad admitidos por el backend (filtro atempo). */
export const SPEED_LIMITS = { min: 0.5, max: 2.0 };

export const seconds = v => Number.isFinite(v) ? `${v.toFixed(3)} s` : '—';
export const frame = e => e?.frame === null || e?.frame === undefined ? '—' : `${e.frameExact ? '' : '~'}${e.frame}`;

/** Ficha del archivo: lo que el usuario necesita ver antes de analizar. */
export function fileSummary(file, metadata) {
  const rows = [
    ['Nombre', file?.name || '—'],
    ['Tamaño', file ? formatBytes(file.size) : '—'],
  ];
  if (!metadata) return rows;
  const audio = metadata.audio || [];
  rows.push(
    ['Duración', seconds(metadata.duration)],
    ['FPS', `${metadata.fps?.toFixed(3) ?? '—'} (nominal ${metadata.nominalFps?.toFixed(3) ?? '—'}, ${String(metadata.frameRateMode || '').toUpperCase() || '—'})`],
    ['Resolución', metadata.width && metadata.height ? `${metadata.width} × ${metadata.height}` : '—'],
    ['Códec', metadata.codec || '—'],
    ['Audio', audio.length
      ? `${audio.length} pista${audio.length > 1 ? 's' : ''} · ${audio[0].codec}, ${audio[0].channels} canal(es), ${audio[0].sampleRate} Hz`
      : 'Sin pista de audio'],
  );
  return rows;
}

/** Resumen del análisis rítmico, sin rellenar huecos cuando no hay evidencia. */
export function rhythmSummary(local) {
  if (!local) return { tempo: '—', sync: '—', hasTempo: false };
  const t = local.tempo;
  return {
    hasTempo: Boolean(t),
    tempo: t
      ? `${t.bpm.toFixed(2)} BPM · periodo ${t.period.toFixed(4)} s · ${local.beats?.length ?? 0} beats · puntuación ${t.score.toFixed(2)} (sin calibrar)`
      : `Sin rejilla rítmica. ${local.tempoReason || ''}`.trim(),
    sync: local.sync?.status === 'sincronizado' || local.sync?.status === 'parcial' || local.sync?.status === 'no-sincronizado'
      ? `${local.sync.status} · ${local.sync.onBeat}/${local.sync.cuts} cortes dentro de ${(local.sync.toleranceSeconds * 1000).toFixed(0)} ms de un beat (${(local.sync.ratio * 100).toFixed(0)} %)`
      : `Sin describir: ${local.sync?.reason || 'sin datos'}`,
  };
}

/**
 * Cifras principales en lenguaje llano, para la tarjeta de resumen.
 * Lo técnico (fuerza vectorial, puntuaciones) vive en "Detalle técnico".
 */
export function summaryCards(analysis, proposal) {
  if (!analysis?.metadata) return [];
  const local = analysis.local || {};
  const cards = [
    { valor: `${analysis.metadata.duration.toFixed(1)} s`, etiqueta: 'Duración original',
      detalle: `${analysis.metadata.width}×${analysis.metadata.height} · ${analysis.metadata.fps.toFixed(0)} fps` },
    { valor: String((local.scenes || []).length), etiqueta: 'Cortes detectados',
      detalle: (local.onsets || []).length ? `${local.onsets.length} sonidos destacados` : 'Sin sonidos destacados' },
    local.tempo
      ? { valor: `${local.tempo.bpm.toFixed(0)} BPM`, etiqueta: 'Ritmo de la música', detalle: `${(local.beats || []).length} beats detectados` }
      : { valor: 'Sin ritmo', etiqueta: 'Ritmo de la música', detalle: 'No se detectó un pulso estable' },
  ];
  if (proposal) {
    cards.push({ valor: `${proposal.segments.length}`, etiqueta: 'Trozos del montaje',
      detalle: `Durará unos ${proposal.estimatedDuration.toFixed(1)} s` });
    cards.push({ valor: proposal.format, etiqueta: 'Formato de salida',
      detalle: `${proposal.dimensions.width}×${proposal.dimensions.height}` });
  }
  return cards;
}

/** Frase corta sobre el estado de la propuesta, sin jerga. */
export function proposalHeadline(proposal) {
  if (!proposal) return 'Aún no hay propuesta.';
  const aprobada = !proposal.approvalRequired || proposal.approval?.status === 'aprobada';
  if (proposal.export) return 'Exportado y listo para descargar.';
  if (aprobada) return 'Aprobada: ya puedes exportar.';
  return 'Pendiente de tu aprobación.';
}

export const SYNC_STATUS_TEXT = {
  'datos-insuficientes': 'Datos insuficientes: no se infirió rejilla rítmica, los segmentos conservan su velocidad original.',
  propuesto: 'Propuesto: las rampas están calculadas, pero todavía no se ha renderizado ni medido nada.',
  validado: 'Validado: la duración medida con ffprobe en el archivo exportado coincide con la estimada.',
};

/**
 * Advertencias a mostrar. Nunca se inventan: se pasan tal cual las del backend
 * y sólo se añade el aviso de atempo cuando el propio backend dice que el audio
 * fue estirado. No se afirma que los beats originales se conserven.
 */
export function collectWarnings(proposal, exportResult) {
  const list = [...(proposal?.warnings || [])];
  const stretched = exportResult?.export?.audio?.timeStretched ?? (proposal?.audioMode === 'stretch' && proposal?.segments?.some(s => Math.abs(s.speed - 1) > 1e-6));
  if (stretched) {
    list.unshift('Advertencia: para conservar la sincronía audiovisual, el audio puede haber sido ajustado mediante atempo. El tempo musical puede variar respecto al original.');
  }
  for (const w of exportResult?.export?.warnings || []) list.push(w);
  return [...new Set(list)];
}

/**
 * Modelo de la timeline en coordenadas 0..1 sobre la duración del ORIGINAL.
 * Los segmentos se dibujan en su posición de origen; su velocidad se indica
 * aparte, porque la línea de salida tiene otra escala.
 */
export function timelineModel(analysis, proposal) {
  const duration = analysis?.metadata?.duration;
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const at = t => Math.min(1, Math.max(0, t / duration));
  const local = analysis.local || {};
  return {
    duration,
    cuts: (local.scenes || []).map(s => ({ at: at(s.timestamp), timestamp: s.timestamp, frame: s.frame, frameExact: s.frameExact })),
    beats: (local.beats || []).map(b => ({ at: at(b.timestamp), timestamp: b.timestamp, supported: b.evidence?.onsetSupported === true })),
    onsets: (local.onsets || []).map(o => ({ at: at(o.timestamp), timestamp: o.timestamp })),
    segments: (proposal?.segments || []).map((s, i) => ({
      index: i, at: at(s.sourceStart), width: at(s.sourceEnd) - at(s.sourceStart),
      sourceStart: s.sourceStart, sourceEnd: s.sourceEnd, speed: s.speed,
      setptsFactor: s.setptsFactor, reason: s.reason,
      kind: Math.abs(s.speed - 1) < 1e-6 ? 'normal' : s.speed > 1 ? 'acelera' : 'ralentiza',
    })),
  };
}

/** Texto compacto de una rampa para la tabla. */
export function rampRow(r) {
  return {
    segmento: `${r.start.toFixed(3)} – ${r.end.toFixed(3)} s`,
    frames: `${r.startFrame} → ${r.endFrame}`,
    duracion: `${r.currentDuration.toFixed(3)} s → ${r.targetDuration.toFixed(3)} s`,
    factor: `${(1 / r.setptsFactor).toFixed(4)}× · setpts ${r.setptsFactor.toFixed(4)}`,
    motivo: r.reason,
  };
}
