import '../src/config.js';
import { randomUUID } from 'node:crypto';
import { loadProject, makeProject, saveProject } from '../src/core/project.js';
import { previewVoice } from '../src/core/tts.js';

const [sourceId, voice] = process.argv.slice(2);
if (!sourceId || !voice) throw new Error('Uso: node scripts/elevenlabs-preview.mjs <idProyectoOriginal> <idVoz>');
const original = loadProject(sourceId);
if (!original) throw new Error('No se encontró el proyecto local. Este script necesita ejecutarse en el computador que contiene el curso.');
const text = String(original.scenes?.[0]?.text || '').slice(0, 400);
if (!text) throw new Error('La primera escena no tiene narración.');
// Generate the explicitly requested sample before creating a copy; failures leave no draft behind.
const sample = await previewVoice(text, { provider: 'elevenlabs', voice, model: original.voice?.model, rate: original.voice?.rate });
const copy = makeProject({ ...structuredClone(original), id: `${sourceId}-eleven-${randomUUID().slice(0,8)}`,
  title: `${original.title} · ElevenLabs (revisión de voz)`,
  voice: { ...original.voice, provider: 'elevenlabs', name: voice, enabled: true, en: '', es: '' },
  editor: null, outputPath: null, outputs: {}, renderLog: [], status: 'draft', error: null,
});
// Do not inherit an old export/proof as verification of this new voice.
copy.metadata = { ...copy.metadata, courseRenderProof: null, sourceProjectId: sourceId };
copy.captions = { ...copy.captions, file: null };
for (const scene of copy.scenes) { scene.narrationKey = null; scene.captionTimings = null; scene.captionTimingText = null; }
saveProject(copy);
const base = `http://127.0.0.1:${process.env.PORT || 4321}`;
console.log(JSON.stringify({ project: `${base}/project-editor.html?id=${encodeURIComponent(copy.id)}`,
  sample: `${base}/file?path=${encodeURIComponent(sample)}`, rendered: false, sourceUnchanged: true }, null, 2));
