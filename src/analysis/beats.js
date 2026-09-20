// Inferencia de rejilla rítmica a partir de los onsets medidos localmente.
// NO es un seguidor de beats entrenado: no separa percusión, no sigue cambios
// de tempo y no produce probabilidades. Es una rejilla isócrona única ajustada
// por fuerza vectorial y respaldo de onsets; cuando la evidencia no alcanza,
// devuelve tempo null y beats vacíos en lugar de inventar una rejilla.

export const TEMPO_RANGE = { minBpm: 50, maxBpm: 200 };
const MIN_ONSETS = 4;          // menos onsets no permiten distinguir periodo de ruido
const MIN_SPAN_SECONDS = 2.5;  // ventana mínima para que el periodo sea observable
const MIN_SCORE = 0.5;         // umbral sin calibrar; ver README

/** Tolerancia de alineación: 70 ms o 12 % del periodo, lo que sea menor. */
export const toleranceFor = period => Math.min(0.07, period * 0.12);

/**
 * Onset más cercano a `line`, avanzando sobre `times` ascendente sin reiniciar.
 * Devuelve el cursor actualizado: recorrer líneas crecientes cuesta O(líneas + onsets)
 * en vez de O(líneas × onsets), que es inviable en material largo.
 */
function advance(times, line, cursor) {
  while (cursor < times.length - 1 && Math.abs(times[cursor + 1] - line) <= Math.abs(times[cursor] - line)) cursor++;
  return cursor;
}

/**
 * Puntúa una rejilla de periodo `period` contra los onsets (`times` ascendente).
 * - vectorStrength: concentración de fase (1 = todos los onsets caen en la rejilla).
 * - support: fracción de líneas de la rejilla que tienen un onset cerca.
 * El producto penaliza las rejillas de tempo doble/cuádruple, que concentran
 * bien la fase pero dejan la mitad de sus líneas sin ninguna evidencia.
 */
export function scorePeriod(times, period) {
  let cos = 0, sin = 0;
  for (const t of times) { const a = 2 * Math.PI * t / period; cos += Math.cos(a); sin += Math.sin(a); }
  const vectorStrength = Math.hypot(cos, sin) / times.length;
  const phase = Math.atan2(sin, cos) * period / (2 * Math.PI);
  const start = Math.ceil((times[0] - phase) / period), end = Math.floor((times[times.length - 1] - phase) / period);
  const tolerance = toleranceFor(period);
  let supported = 0, lines = 0, cursor = 0;
  for (let k = start; k <= end; k++) {
    const line = phase + k * period; lines++;
    cursor = advance(times, line, cursor);
    if (Math.abs(times[cursor] - line) <= tolerance) supported++;
  }
  const support = lines ? supported / lines : 0;
  return { period, bpm: 60 / period, vectorStrength, support, lines, score: vectorStrength * support, phase };
}

/** Busca el periodo con mejor puntuación en el rango de tempo, con refinado fino. */
export function estimateTempo(onsets, { duration } = {}) {
  const times = onsets.map(o => o.timestamp).sort((a, b) => a - b);
  const span = times.length ? times[times.length - 1] - times[0] : 0;
  if (times.length < MIN_ONSETS || span < MIN_SPAN_SECONDS) {
    return { tempo: null, reason: `Evidencia insuficiente: ${times.length} onsets en ${span.toFixed(2)} s (mínimo ${MIN_ONSETS} onsets y ${MIN_SPAN_SECONDS} s)` };
  }
  const min = 60 / TEMPO_RANGE.maxBpm, max = 60 / TEMPO_RANGE.minBpm;
  let best = null;
  for (let period = min; period <= max; period += 0.002) {
    const candidate = scorePeriod(times, period);
    if (!best || candidate.score > best.score) best = candidate;
  }
  for (let period = Math.max(min, best.period - 0.002); period <= Math.min(max, best.period + 0.002); period += 0.0002) {
    const candidate = scorePeriod(times, period);
    if (candidate.score > best.score) best = candidate;
  }
  if (best.score < MIN_SCORE) {
    return { tempo: null, reason: `Sin rejilla estable: mejor puntuación ${best.score.toFixed(2)} bajo el umbral ${MIN_SCORE} (fuerza ${best.vectorStrength.toFixed(2)}, respaldo ${best.support.toFixed(2)})` };
  }
  return { tempo: {
    bpm: best.bpm, period: best.period, phase: best.phase,
    vectorStrength: best.vectorStrength, support: best.support, score: best.score,
    toleranceSeconds: toleranceFor(best.period), onsetsUsed: times.length, spanSeconds: span,
    searchedBpm: TEMPO_RANGE, method: 'fuerza vectorial × respaldo de rejilla sobre onsets de energía',
    confidence: null,
  }, reason: null, duration };
}

/**
 * Materializa las líneas de la rejilla dentro del material, marcando cuáles tienen onset.
 * `maxBeats` acota el JSON resultante en material largo; si se alcanza, la rejilla
 * queda truncada y `analyzeRhythm` lo deja anotado en lugar de silenciarlo.
 */
export function buildBeats(tempo, onsets, duration, { maxBeats = 20000 } = {}) {
  if (!tempo) return [];
  const times = onsets.map(o => o.timestamp).sort((a, b) => a - b);
  const { period, phase, toleranceSeconds } = tempo;
  const beats = [];
  let cursor = 0;
  for (let k = Math.ceil(-phase / period); beats.length < maxBeats; k++) {
    const timestamp = phase + k * period;
    if (timestamp >= duration) break;
    if (timestamp < 0) continue;
    cursor = times.length ? advance(times, timestamp, cursor) : 0;
    const deviation = times.length ? timestamp - times[cursor] : null;
    beats.push({
      timestamp, beatIndex: beats.length, kind: 'beat',
      reason: 'Línea de la rejilla rítmica inferida',
      evidence: { bpm: tempo.bpm, period, onsetSupported: deviation !== null && Math.abs(deviation) <= toleranceSeconds, deviationSeconds: deviation, toleranceSeconds },
      confidence: null,
    });
  }
  return beats;
}

/** Relación medida entre los cortes visuales y la rejilla; no afirma intención del montaje. */
export function syncPattern(cuts, tempo) {
  const visual = cuts.filter(c => c.kind === 'scene').map(c => c.timestamp).sort((a, b) => a - b);
  if (!tempo) return { status: 'sin-rejilla', reason: 'No se infirió tempo; no hay rejilla contra la cual medir', cuts: visual.length, alignments: [] };
  if (visual.length < 3) return { status: 'datos-insuficientes', reason: `Sólo ${visual.length} corte${visual.length === 1 ? '' : 's'} visual${visual.length === 1 ? '' : 'es'}; se requieren 3 para describir un patrón`, cuts: visual.length, alignments: [] };
  const { period, phase, toleranceSeconds } = tempo;
  const alignments = visual.map(timestamp => {
    const index = Math.round((timestamp - phase) / period);
    const beat = phase + index * period;
    const delta = timestamp - beat;
    return { timestamp, beatIndex: index, beatTimestamp: beat, deltaSeconds: delta, phaseOfBeat: delta / period, onBeat: Math.abs(delta) <= toleranceSeconds };
  });
  const deltas = alignments.map(a => Math.abs(a.deltaSeconds)).sort((a, b) => a - b);
  const onBeat = alignments.filter(a => a.onBeat).length;
  const ratio = onBeat / alignments.length;
  // Distribución de los cortes sobre un compás hipotético de 4 tiempos. Es una
  // observación del reparto, no una afirmación de que el material esté en 4/4.
  const positions = [0, 0, 0, 0];
  for (const a of alignments) positions[((a.beatIndex % 4) + 4) % 4]++;
  return {
    status: ratio >= 0.6 ? 'sincronizado' : ratio >= 0.3 ? 'parcial' : 'no-sincronizado',
    cuts: alignments.length, onBeat, ratio,
    medianAbsDeltaSeconds: deltas[Math.floor(deltas.length / 2)],
    meanSignedDeltaSeconds: alignments.reduce((a, b) => a + b.deltaSeconds, 0) / alignments.length,
    toleranceSeconds, beatPositionsMod4: positions,
    note: 'Reparto mod 4 sólo descriptivo: no se detecta compás ni downbeat.',
    alignments,
  };
}

/**
 * Propone rampas de velocidad que harían caer cada corte visual en la rejilla.
 * Cada propuesta es un cambio de duración calculado, no una edición aplicada:
 * `setptsFactor` es el multiplicador directo para el filtro setpts de FFmpeg.
 */
export function speedRamps(cuts, tempo, duration, { maxSuggestions = 30 } = {}) {
  if (!tempo) return { ramps: [], reason: 'Sin rejilla rítmica: no se proponen rampas' };
  const marks = [0, ...cuts.filter(c => c.kind === 'scene').map(c => c.timestamp), duration]
    .sort((a, b) => a - b).filter((t, i, a) => i === 0 || t - a[i - 1] > 1e-6);
  if (marks.length < 3) return { ramps: [], reason: 'Se requiere al menos un corte visual interior para segmentar' };
  const { period } = tempo;
  const ramps = [];
  for (let i = 0; i + 1 < marks.length && ramps.length < maxSuggestions; i++) {
    const start = marks[i], end = marks[i + 1], current = end - start;
    const beats = Math.round(current / period);
    if (beats < 1) continue;                       // más corto que un beat: cuantizar lo borraría
    const target = beats * period, delta = target - current;
    const speedFactor = current / target;
    if (Math.abs(delta) < 0.04) continue;          // ya alineado dentro de ~1 frame
    if (speedFactor < 0.75 || speedFactor > 1.34) continue; // rampa audible/visible en exceso
    ramps.push({
      start, end, kind: 'speed-ramp',
      currentDuration: current, targetDuration: target, targetBeats: beats,
      speedFactor, setptsFactor: target / current, deltaSeconds: delta,
      direction: delta > 0 ? 'ralentizar' : 'acelerar',
      reason: `Ajustar el segmento a ${beats} beat(s) de ${tempo.bpm.toFixed(2)} BPM`,
      evidence: { bpm: tempo.bpm, period, tempoScore: tempo.score },
      confidence: null,
    });
  }
  return { ramps, reason: ramps.length ? null : 'Todos los segmentos ya caen en la rejilla dentro de la tolerancia, o el ajuste requerido excede los límites' };
}

/** Punto de entrada del módulo: rejilla, sincronía y rampas sobre onsets ya medidos. */
export function analyzeRhythm(onsets, cuts, duration, { maxBeats = 20000 } = {}) {
  const { tempo, reason } = estimateTempo(onsets, { duration });
  const beats = buildBeats(tempo, onsets, duration, { maxBeats });
  const { ramps, reason: rampReason } = speedRamps(cuts, tempo, duration);
  return {
    tempo, tempoReason: reason, beats, beatsTruncated: beats.length >= maxBeats,
    sync: syncPattern(cuts, tempo),
    ramps, rampReason,
    notes: [
      ...(beats.length >= maxBeats ? [`Rejilla truncada en ${maxBeats} beats para acotar el tamaño del análisis; el tempo se calculó sobre todos los onsets.`] : []),
      'Rejilla isócrona inferida de onsets de energía: no separa percusión ni sigue cambios de tempo.',
      'Las rampas son propuestas calculadas sobre la rejilla; no se ha renderizado ni validado ninguna.',
      'Puntuaciones y umbrales sin calibrar: no son probabilidades.',
    ],
  };
}
