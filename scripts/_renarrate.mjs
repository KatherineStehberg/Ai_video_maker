import { loadProject, saveProject } from '../src/core/project.js';
import { narrateProject, buildNarrationTrack } from '../src/core/tts.js';
import { syncDurationsToNarration } from '../src/core/scene-planner.js';

const id = process.argv[2];
const p = loadProject(id);
console.log(`proyecto: ${p.title}  language=${p.language}  voz=${p.voice.name}  escenas=${p.scenes.length}`);

const res = await narrateProject(p, {
  force: true,
  onProgress: x => process.stdout.write(`\r  voz ${x.index + 1}/${x.total}   `),
});
console.log('\nprovider:', res.provider, '| voz base:', res.voice, '| errores:', res.errors?.length || 0);
if (res.warnings?.length) console.log('avisos:', res.warnings);

p.scenes.forEach((s, i) => { s.narrationPath = res.narrations[i] || s.narrationPath; });
// La voz real manda sobre la duracion estimada: sin esto la escena se corta.
if (res.durations?.some(Boolean)) p.scenes = syncDurationsToNarration(p.scenes, res.durations);
const track = await buildNarrationTrack(p);
console.log('pista de voz:', track);
saveProject(p);

const voces = new Map();
p.scenes.forEach(s => (s.narrationVoices || []).forEach(v => voces.set(v, (voces.get(v) || 0) + 1)));
console.log('\nvoces por escena:', [...voces].map(([v, n]) => `${v} x${n}`).join(', '));
console.log('escenas sin voz registrada:', p.scenes.filter(s => !s.narrationVoices?.length).length);
