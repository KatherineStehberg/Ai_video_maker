/**
 * Esquema y validación de la propuesta de edición.
 *
 * TRANSFORMACIÓN DEL TIEMPO (contrato único de todo el módulo)
 * -----------------------------------------------------------
 * Un segmento toma del original el intervalo [sourceStart, sourceEnd) de
 * duración  D = sourceEnd - sourceStart  y lo emite con duración
 *
 *     D_out = D * setptsFactor
 *     speed = D / D_out = 1 / setptsFactor
 *
 * setptsFactor > 1 alarga (ralentiza), < 1 acorta (acelera).
 * En FFmpeg se aplica como:
 *     vídeo: trim=start=S:end=E, setpts=(PTS-STARTPTS)*setptsFactor
 *     audio: atrim=start=S:end=E, asetpts=PTS-STARTPTS, atempo=speed
 * `atempo` sólo acepta factores en [0.5, 2.0]; fuera de ese rango habría que
 * encadenar filtros, así que la validación rechaza velocidades fuera de ahí.
 *
 * La línea de salida es contigua: start_i = suma de D_out de los segmentos
 * anteriores, y la duración estimada total es la suma de todos los D_out.
 * Es una predicción aritmética exacta sobre la línea temporal; el archivo
 * codificado difiere en fracciones de frame por cuantización (ver EXPORT).
 */

export const SPEED_LIMITS = { min: 0.5, max: 2.0 };   // límites de atempo
export const EPSILON = 1e-6;
export const SYNC_STATUS = ['datos-insuficientes', 'propuesto', 'validado'];
export const SYNC_MODES = ['beats', 'cuts'];
export const AUDIO_MODES = ['stretch', 'none'];

/** Duración de salida de un segmento, según el contrato de arriba. */
export const outputDuration = s => (s.sourceEnd - s.sourceStart) * s.setptsFactor;

/** Duración estimada total: suma aritmética, sin consultar el archivo. */
export const estimateDuration = segments => segments.reduce((total, s) => total + outputDuration(s), 0);

/** Redondeo estable para que el JSON sea reproducible entre ejecuciones. */
export const round6 = v => Number(v.toFixed(6));

/**
 * Recalcula la línea de salida contigua tras editar o eliminar segmentos.
 * `sourceStart`/`sourceEnd` y `setptsFactor` mandan; `start`/`end` se derivan.
 */
export function relayout(segments) {
  let cursor = 0;
  return segments.map(s => {
    const start = round6(cursor);
    cursor += outputDuration(s);
    return { ...s, start, end: round6(cursor) };
  });
}

/**
 * Valida una propuesta completa. Lanza con un mensaje accionable en el primer
 * problema: ordenación, solapamiento, límites, coherencia speed/setptsFactor y
 * contigüidad de la línea de salida.
 */
export function validateProposal(proposal, { duration = null } = {}) {
  if (!proposal || typeof proposal !== 'object') throw new Error('Propuesta ausente o inválida');
  if (!SYNC_STATUS.includes(proposal.syncStatus)) throw new Error(`syncStatus debe ser uno de: ${SYNC_STATUS.join(', ')}`);
  const segments = proposal.segments;
  if (!Array.isArray(segments) || !segments.length) throw new Error('La propuesta debe tener al menos un segmento');

  let previousEnd = null, outputCursor = 0;
  segments.forEach((s, i) => {
    const label = `Segmento ${i + 1}`;
    for (const key of ['start', 'end', 'sourceStart', 'sourceEnd', 'speed', 'setptsFactor']) {
      if (!Number.isFinite(s[key])) throw new Error(`${label}: ${key} debe ser un número finito`);
    }
    if (s.sourceStart < -EPSILON) throw new Error(`${label}: sourceStart no puede ser negativo`);
    if (s.sourceEnd - s.sourceStart <= EPSILON) throw new Error(`${label}: sourceEnd debe ser mayor que sourceStart`);
    if (duration !== null && s.sourceEnd > duration + EPSILON) {
      throw new Error(`${label}: sourceEnd ${s.sourceEnd.toFixed(3)} s excede la duración del original (${duration.toFixed(3)} s)`);
    }
    // Ordenación y solapamiento se comprueban sobre la línea del ORIGINAL.
    if (previousEnd !== null && s.sourceStart < previousEnd - EPSILON) {
      throw new Error(`${label}: se solapa con el anterior (empieza en ${s.sourceStart.toFixed(3)} s, el previo termina en ${previousEnd.toFixed(3)} s)`);
    }
    previousEnd = s.sourceEnd;

    if (s.speed < SPEED_LIMITS.min - EPSILON || s.speed > SPEED_LIMITS.max + EPSILON) {
      throw new Error(`${label}: velocidad ${s.speed.toFixed(3)}× fuera del rango admitido ${SPEED_LIMITS.min}–${SPEED_LIMITS.max} (límite del filtro atempo)`);
    }
    if (Math.abs(s.speed * s.setptsFactor - 1) > 1e-6) {
      throw new Error(`${label}: speed (${s.speed}) y setptsFactor (${s.setptsFactor}) son incoherentes; debe cumplirse speed = 1 / setptsFactor`);
    }
    // Contigüidad de la línea de salida.
    if (Math.abs(s.start - outputCursor) > 1e-6) {
      throw new Error(`${label}: start ${s.start.toFixed(6)} s no continúa la salida (se esperaba ${outputCursor.toFixed(6)} s)`);
    }
    outputCursor += outputDuration(s);
    if (Math.abs(s.end - outputCursor) > 1e-6) {
      throw new Error(`${label}: end ${s.end.toFixed(6)} s no coincide con la duración transformada (se esperaba ${outputCursor.toFixed(6)} s)`);
    }
  });
  return { segments: segments.length, estimatedDuration: outputCursor };
}

/** Comprueba que un formato esté soportado por el exportador. */
export function assertFormat(format, aspects) {
  if (!aspects[format]) throw new Error(`Formato no soportado: ${format}. Disponibles: ${Object.keys(aspects).join(', ')}`);
  return aspects[format];
}
