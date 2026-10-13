// Prueba local independiente: un clip animado debe conservar movimiento al exportar.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = path.resolve('.tmp', 'motion-smoke');
process.env.AIVM_PROJECTS_DIR = path.join(root, 'projects');
process.env.AIVM_OUTPUT_DIR = path.join(root, 'output');
process.env.COURSE_PRODUCTION_ENABLED = '0';
const { makeProject, saveProject, loadProject } = await import('../src/core/project.js');
const { renderProject } = await import('../src/core/renderer.js');
const { loadBrand } = await import('../src/core/brands.js');
const { ffmpegRun, resolveFfmpeg, run } = await import('../src/lib/ffmpeg.js');
fs.mkdirSync(root, { recursive: true });
const clip = path.join(root, `source-${Date.now()}.mp4`);
await ffmpegRun(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip]);
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const original = hash(clip);
const p = makeProject({ title: 'Motion smoke', brand: 'personal', aspectRatio: '16:9',
  voice: { enabled: false }, captions: { enabled: false, burnIn: false },
  scenes: [{ text: '', duration: 3, assetPath: clip, kenBurns: 'none', transition: 'none' }] });
saveProject(p);
assert.equal(loadProject(p.id).scenes[0].assetPath, clip);
const out = await renderProject(p, loadBrand('personal'), { aspectRatio: '16:9', subtitlesPath: null });
const { ffprobe } = await resolveFfmpeg();
const meta = JSON.parse((await run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', out.absolute])).stdout);
assert.ok(meta.streams.some(s => s.codec_type === 'video'));
assert.ok(Math.abs(Number(meta.format.duration) - 3) < 0.2);
const frames = [];
for (const t of [0.5, 2]) {
  const frame = path.join(root, `${p.id}-${t}.rgb`);
  await ffmpegRun(['-ss', String(t), '-i', out.absolute, '-frames:v', '1', '-vf', 'scale=64:36,format=rgb24', '-f', 'rawvideo', frame]);
  frames.push(fs.readFileSync(frame));
}
const delta = frames[0].reduce((sum, value, i) => sum + Math.abs(value - frames[1][i]), 0) / frames[0].length;
assert.ok(delta > 5, `el clip parece congelado: diferencia media ${delta}`);
assert.equal(hash(clip), original, 'el original cambió');
const report = { ok: true, mp4: out.absolute, duration: Number(meta.format.duration), frameDifference: delta, sourceUnchanged: true };
fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
