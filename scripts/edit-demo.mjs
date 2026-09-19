/**
 * Demostración reproducible de extremo a extremo, sólo local:
 *   fixture corto -> análisis -> propuesta -> aprobación -> exportación -> ffprobe
 *
 * No necesita clave Gemini, no llama a ningún servicio externo y no sobrescribe
 * nada del usuario. Ejecuta:  node scripts/edit-demo.mjs
 */
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from '../src/server.js';
import { ffmpegRun, resolveFfmpeg, run } from '../src/lib/ffmpeg.js';

process.env.GEMINI_API_KEY = '';   // la demostración es íntegramente local

const dir = path.resolve('.tmp/edit-demo');
const hash = async f => { const h = createHash('sha256'); for await (const b of createReadStream(f)) h.update(b); return h.digest('hex'); };
const show = (title, value) => console.log(`\n=== ${title} ===\n` + (typeof value === 'string' ? value : JSON.stringify(value, null, 2)));

await fs.mkdir(dir, { recursive: true });
const fixture = path.join(dir, 'demo-source.mp4');

// 6 s a 30 FPS: tres planos (1.65 s / 1.35 s / 3 s) y clics cada 0.5 s = 120 BPM.
// Los dos primeros cortes caen FUERA de la rejilla a propósito, para que haya rampas.
await ffmpegRun(['-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=30:d=1.65',
  '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=30:d=1.35',
  '-f', 'lavfi', '-i', 'color=c=green:s=640x360:r=30:d=3',
  '-f', 'lavfi', '-i', 'aevalsrc=if(lt(mod(t\\,0.5)\\,0.03)\\,0.8*sin(2*PI*1000*t)\\,0):s=16000:d=6',
  '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]', '-map', '[v]', '-map', '3:a',
  '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', fixture]);
const sourceHash = await hash(fixture);
console.log(`Fixture: ${fixture}\nSHA-256 del original: ${sourceHash}`);

const server = createServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

try {
  // 1. Análisis local del MP4.
  const up = await fetch(base + '/api/analysis', { method: 'POST', headers: { 'x-analysis-upload': '1' }, body: createReadStream(fixture), duplex: 'half' });
  const { id: videoJobId } = await up.json();
  let job;
  for (let i = 0; i < 600; i++) {
    job = await (await fetch(base + `/api/analysis/${videoJobId}`)).json();
    if (job.status !== 'running') break;
    await new Promise(r => setTimeout(r, 100));
  }
  if (job.status !== 'complete') throw new Error(`Análisis en estado ${job.status}: ${job.error}`);
  show('1. Análisis', {
    metadata: { duration: job.metadata.duration, fps: job.metadata.fps, frameRateMode: job.metadata.frameRateMode, resolution: `${job.metadata.width}x${job.metadata.height}`, codec: job.metadata.codec },
    cortes: job.local.scenes.map(s => ({ timestamp: s.timestamp, frame: s.frame })),
    tempo: job.local.tempo && { bpm: job.local.tempo.bpm, period: job.local.tempo.period, score: job.local.tempo.score },
    beats: job.local.beats.length, rampasSugeridas: job.local.ramps.length,
  });

  // 2. Propuesta de edición.
  const request = { videoJobId, format: '9:16', targetDuration: null, syncMode: 'beats', enableSpeedRamps: true, approvalRequired: true };
  show('2. POST /api/video-edits (request)', request);
  const proposal = await (await post('/api/video-edits', request)).json();
  show('2. POST /api/video-edits (response, recortada)', {
    id: proposal.id, format: proposal.format, dimensions: proposal.dimensions,
    syncStatus: proposal.syncStatus, approval: proposal.approval, audioMode: proposal.audioMode,
    segments: proposal.segments, ramps: proposal.ramps.length,
    estimatedDuration: proposal.estimatedDuration, warnings: proposal.warnings,
  });

  // 3. Exportar sin aprobar: debe rechazarse.
  const denied = await post(`/api/video-edits/${proposal.id}/export`, {});
  show('3. Exportación sin aprobación', { status: denied.status, body: await denied.json() });

  // 4. Aprobación humana explícita.
  const approved = await (await post(`/api/video-edits/${proposal.id}/approve`, { confirm: true, by: 'demo' })).json();
  show('4. Aprobación', approved.approval);

  // 5. Exportación real.
  const exported = await (await post(`/api/video-edits/${proposal.id}/export`, { fit: 'pad' })).json();
  show('5. POST /api/video-edits/:id/export (response)', exported);

  // 6. ffprobe independiente sobre el archivo resultante.
  const target = path.resolve(exported.export.file);
  const { ffprobe } = await resolveFfmpeg();
  const probed = await run(ffprobe, ['-v', 'error', '-show_entries',
    'format=duration,format_name:stream=codec_name,width,height,avg_frame_rate,nb_frames,channels',
    '-of', 'json', target]);
  show('6. ffprobe del MP4 exportado', probed.stdout.trim());

  // 7. Reproducibilidad: decodificar entero y comprobar que el original no cambió.
  await ffmpegRun(['-v', 'error', '-i', target, '-f', 'null', '-']);
  const after = await hash(fixture);
  show('7. Integridad', {
    archivoExportado: exported.export.file,
    decodificacionCompleta: 'OK (ffmpeg -f null sin errores)',
    originalSHA256Antes: sourceHash, originalSHA256Despues: after,
    originalIntacto: sourceHash === after,
    duracionEstimada: exported.export.duration.estimated,
    duracionMedida: exported.export.duration.measured,
    deltaSegundos: exported.export.duration.deltaSeconds,
    syncStatus: exported.syncStatus,
  });
  if (sourceHash !== after) throw new Error('El original cambió: fallo grave');
  await fs.writeFile(path.join(dir, 'demo-result.json'), JSON.stringify({ request, proposal, exported, ffprobe: JSON.parse(probed.stdout), sourceHash, sourceUnchanged: sourceHash === after }, null, 2));
  console.log(`\nResultado completo: ${path.join(dir, 'demo-result.json')}`);
} finally {
  await new Promise(r => server.close(r));
}
