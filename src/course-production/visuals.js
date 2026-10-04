import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ensureDir, rel } from '../lib/paths.js';
import { ffmpegRun } from '../lib/ffmpeg.js';

const wrap = (text, limit) => {
  const lines = [''];
  for (const word of text.split(/\s+/)) {
    if (lines.at(-1).length + word.length > limit) lines.push('');
    lines[lines.length - 1] += (lines.at(-1) ? ' ' : '') + word;
  }
  return lines.join('\n');
};

/** Original offline teaching illustrations. Narration remains the full source. */
export async function provideCourseVisual({ project, scene, width, height }) {
  const dir = ensureDir(path.join(PATHS.assetsImages, '_courses', project.id));
  const output = path.join(dir, `${scene.id}.png`);
  const filters = [];
  const sx = width / 1920, sy = height / 1080;
  const box = (x,y,w,h,color='0x003366',thickness='fill') => filters.push(
    `drawbox=x=${Math.round(x*sx)}:y=${Math.round(y*sy)}:w=${Math.round(w*sx)}:h=${Math.round(h*sy)}:color=${color}:t=${thickness}`);
  let count = 0;
  const text = (value,x,y,size,color='0x003366',limit=65) => {
    const file = path.join(dir, `${scene.id}-${count++}.txt`);
    fs.writeFileSync(file, wrap(value,limit));
    // Relative paths avoid drive-letter and shell interpolation problems.
    filters.push(`drawtext=textfile='${rel(file).replaceAll('\\','/')}':expansion=none:fontcolor=${color}:fontsize=${Math.round(size*sx)}:x=${Math.round(x*sx)}:y=${Math.round(y*sy)}:line_spacing=${Math.round(10*sy)}`);
  };
  const number = project.scenes.findIndex(s => s.id === scene.id) + 1;
  box(90,240,490,400,'0x003366',8);
  box(105,255,460,365,'0xf2f6fa');
  box(320,640,30,60);
  box(230,700,210,10);
  // Conversation cards inside a monitor: information moving between colleagues.
  box(135,300,355,100,'white'); box(135,300,8,100);
  box(185,440,355,100,'0x003366');
  for (let i=0;i<3;i++) { box(165,325+i*20,270-i*35,5); box(215,465+i*20,270-i*35,5,'white'); }
  text(`LANGUAGE CENTER CHILE | ${String(number).padStart(2,'0')}`,90,175,24);
  // Whole source sentences serve as examples, never as replacement narration.
  const sentences = (scene.text.match(/[^.!?]+[.!?]+/g) || [scene.text])
    .map(s=>s.trim()).filter(s=>s.length<=215).slice(0,3);
  for (let i=0;i<sentences.length;i++) {
    const y=260+i*175;
    box(655,y,1170,155,'0xf2f6fa'); box(655,y,7,155);
    text(String(i+1),680,y+25,30);
    text(sentences[i],735,y+23,30,'0x003366',66);
  }
  text(scene.onScreenTitle || 'English in practice',110,765,32,'0x003366',85);
  await ffmpegRun(['-f','lavfi','-i',`color=c=white:s=${width}x${height}:d=1`,
    '-vf',filters.join(','),'-frames:v','1',output],{cwd:PATHS.root});
  return { path:rel(output), provider:'course-local', credit:{ fuente:'Original local teaching illustration', licencia:'Project-owned', autor:'AI Video Maker' } };
}
