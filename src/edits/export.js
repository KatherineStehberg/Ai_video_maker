import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
// Este módulo NO importa ni usa el cliente de Gemini: la exportación es
// íntegramente local y no envía el material a ningún servicio externo.
import { PATHS, ensureDir, rel } from '../lib/paths.js';
import { ffmpegRun } from '../lib/ffmpeg.js';
import { probe } from '../analysis/local.js';
import { ASPECTS } from '../config.js';
import { SPEED_LIMITS, validateProposal, assertFormat, estimateDuration } from './schema.js';

const num = v => Number(v.toFixed(6));

/**
 * Construye el filter_complex. Cada segmento se recorta y se reescala en el
 * tiempo según el contrato documentado en schema.js; después se concatenan y
 * se ajusta el resultado al formato de salida.
 *
 * `fit`: 'pad' (por defecto) encaja el fotograma completo y rellena con barras,
 * sin descartar nada de lo medido; 'crop' llena el encuadre recortando bordes.
 */
export function buildFilterGraph(proposal, metadata, { fit = 'pad' } = {}) {
  const { width, height } = proposal.dimensions;
  const withAudio = proposal.audioMode === 'stretch';
  const videoIn = `0:${metadata.videoStream}`;
  const audioIn = withAudio ? `0:${metadata.audio[0].index}` : null;
  const parts = [], labels = [];

  proposal.segments.forEach((s, i) => {
    if (s.speed < SPEED_LIMITS.min - 1e-9 || s.speed > SPEED_LIMITS.max + 1e-9) {
      throw new Error(`Segmento ${i + 1}: velocidad ${s.speed}× fuera del rango de atempo ${SPEED_LIMITS.min}–${SPEED_LIMITS.max}`);
    }
    parts.push(`[${videoIn}]trim=start=${num(s.sourceStart)}:end=${num(s.sourceEnd)},setpts=(PTS-STARTPTS)*${num(s.setptsFactor)}[v${i}]`);
    labels.push(`[v${i}]`);
    if (withAudio) {
      parts.push(`[${audioIn}]atrim=start=${num(s.sourceStart)}:end=${num(s.sourceEnd)},asetpts=PTS-STARTPTS,atempo=${num(s.speed)}[a${i}]`);
      labels.push(`[a${i}]`);
    }
  });

  const n = proposal.segments.length;
  parts.push(`${labels.join('')}concat=n=${n}:v=1:a=${withAudio ? 1 : 0}[vc]${withAudio ? '[ac]' : ''}`);

  const geometry = fit === 'crop'
    ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
    : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
  parts.push(`[vc]${geometry},setsar=1,fps=${proposal.outputFps},format=yuv420p[vout]`);

  return { filter: parts.join(';'), withAudio };
}

/**
 * Exporta la propuesta a un MP4 nuevo. El original se abre en sólo lectura y
 * nunca se sobrescribe: la salida vive en output/video-edits/<id>/.
 */
export async function exportEdit(proposal, { fit = 'pad', onProgress } = {}) {
  if (proposal.approvalRequired && proposal.approval?.status !== 'aprobada') {
    throw new Error('La propuesta requiere aprobación humana explícita antes de exportar');
  }
  assertFormat(proposal.format, ASPECTS);

  const source = path.resolve(PATHS.root, proposal.sourceVideo);
  if (!fs.existsSync(source)) throw new Error('No se encuentra el video original de la propuesta');
  const metadata = await probe(source);
  validateProposal(proposal, { duration: metadata.duration });

  proposal.outputFps = Number.isFinite(metadata.fps) && metadata.fps > 0
    ? Math.min(120, Math.max(1, Math.round(metadata.fps))) : 30;

  const dir = ensureDir(path.join(PATHS.output, 'video-edits', proposal.id));
  const safeFormat = proposal.format.replace(':', 'x');       // '9:16' no es un nombre válido en Windows
  const target = path.join(dir, `${proposal.id}_${safeFormat}.mp4`);
  const { filter, withAudio } = buildFilterGraph(proposal, metadata, { fit });

  const args = ['-i', source, '-filter_complex', filter, '-map', '[vout]'];
  if (withAudio) args.push('-map', '[ac]', '-c:a', 'aac', '-b:a', '192k');
  else args.push('-an');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', target);

  const began = Date.now();
  await ffmpegRun(args, { onProgress });

  // Verificación real del resultado: se mide el archivo, no se asume.
  const measured = await probe(target);
  const estimated = estimateDuration(proposal.segments);
  const deltaSeconds = measured.duration - estimated;
  const frameTolerance = 2 / proposal.outputFps;
  const withinTolerance = Math.abs(deltaSeconds) <= Math.max(0.1, frameTolerance);

  const report = {
    file: rel(target), directory: rel(dir), bytes: fs.statSync(target).size,
    exportedAt: new Date().toISOString(), elapsedMs: Date.now() - began, fit,
    requested: { format: proposal.format, width: proposal.dimensions.width, height: proposal.dimensions.height, fps: proposal.outputFps },
    measured: { duration: measured.duration, fps: measured.fps, width: measured.width, height: measured.height, codec: measured.codec, frameRateMode: measured.frameRateMode, audioTracks: measured.audio.length },
    duration: { estimated, measured: measured.duration, deltaSeconds, withinTolerance, toleranceSeconds: Math.max(0.1, frameTolerance) },
    audio: { mode: proposal.audioMode, timeStretched: proposal.segments.some(s => Math.abs(s.speed - 1) > 1e-6) },
    sourceUntouched: true,
    warnings: [],
  };
  if (!withinTolerance) {
    report.warnings.push(`La duración medida (${measured.duration.toFixed(3)} s) se aparta ${deltaSeconds.toFixed(3)} s de la estimada (${estimated.toFixed(3)} s). No se declara la sincronía validada.`);
  }
  if (measured.width !== proposal.dimensions.width || measured.height !== proposal.dimensions.height) {
    report.warnings.push(`Resolución medida ${measured.width}×${measured.height} distinta de la solicitada ${proposal.dimensions.width}×${proposal.dimensions.height}.`);
  }

  proposal.export = report;
  // 'validado' sólo si la medición del archivo confirma la predicción aritmética.
  if (withinTolerance && proposal.syncStatus === 'propuesto') proposal.syncStatus = 'validado';

  await fsp.writeFile(path.join(dir, 'metadata.json'), JSON.stringify({
    editId: proposal.id, videoJobId: proposal.videoJobId, sourceVideo: proposal.sourceVideo,
    format: proposal.format, syncStatus: proposal.syncStatus, approval: proposal.approval,
    timeTransform: proposal.timeTransform,
    segments: proposal.segments, ramps: proposal.ramps, analysis: proposal.analysis,
    export: report, warnings: proposal.warnings,
  }, null, 2), 'utf8');

  return report;
}
