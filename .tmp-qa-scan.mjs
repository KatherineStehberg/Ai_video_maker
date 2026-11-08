import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';
process.chdir('C:/Users/Usuario/Documents/AI_Video_Maker');
const { listProjects } = await import('file:///C:/Users/Usuario/Documents/AI_Video_Maker/src/core/project.js');
const { ASPECTS } = await import('file:///C:/Users/Usuario/Documents/AI_Video_Maker/src/config.js');

function probe(f) {
  const r = spawnSync(ffprobe.path, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', f], { encoding: 'utf8' });
  return JSON.parse(r.stdout || '{}');
}
function vol(f) {
  const r = spawnSync(ffmpegPath, ['-i', f, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /mean_volume: (-?[\d.]+)/.exec(r.stderr); return m ? Number(m[1]) : null;
}
function black(f, dur) {
  const r = spawnSync(ffmpegPath, ['-i', f, '-an', '-vf', 'blackdetect=d=0.5:pix_th=0.1', '-f', 'null', '-'], { encoding: 'utf8' });
  let t = 0; for (const m of r.stderr.matchAll(/black_duration:([\d.]+)/g)) t += Number(m[1]);
  return dur ? t / dur : 0;
}
for (const p of listProjects()) {
  const outs = Object.entries(p.outputs || {}).filter(([, v]) => v);
  if (!outs.length) { console.log(JSON.stringify({ id: p.id, title: p.title, problema: ['sin exportar'] })); continue; }
  for (const [fmt, rel] of outs) {
    const f = path.resolve(rel);
    const problemas = [];
    if (!fs.existsSync(f)) { console.log(JSON.stringify({ id: p.id, fmt, problema: ['archivo no existe ' + rel] })); continue; }
    const pr = probe(f);
    const v = pr.streams?.find(s => s.codec_type === 'video');
    const a = pr.streams?.find(s => s.codec_type === 'audio');
    const dur = Number(pr.format?.duration) || 0;
    const exp = ASPECTS[fmt];
    if (!v) problemas.push('sin video');
    else if (exp && (v.width !== exp.width || v.height !== exp.height)) problemas.push(`resolución ${v.width}x${v.height} ≠ ${exp.width}x${exp.height}`);
    if (dur < 2) problemas.push(`dura ${dur}s`);
    if (p.duration && Math.abs(dur - p.duration) > Math.max(2, p.duration * 0.1)) problemas.push(`dura ${dur.toFixed(1)}s, proyecto ${p.duration}s`);
    let mv = null;
    if (!a) problemas.push('sin audio'); else { mv = vol(f); if (mv === null || mv < -40) problemas.push(`audio casi mudo ${mv} dB`); }
    const neg = black(f, dur);
    if (neg > 0.3) problemas.push(`${Math.round(neg * 100)}% negro`);
    console.log(JSON.stringify({ id: p.id, title: p.title.slice(0, 40), fmt, dur: +dur.toFixed(1), mv, problema: problemas }));
  }
}
