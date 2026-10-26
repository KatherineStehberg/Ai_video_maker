import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { loadProject, saveProject } from '../src/core/project.js';
import { PATHS, abs } from '../src/lib/paths.js';

// Prepare only: no network, synthesis, render, or queue operations.
const sourceId = process.argv[2];
if (!sourceId) throw new Error('Usage: node scripts/elevenlabs-prepare.mjs <source-project-id>');
const source = loadProject(sourceId);
if (!source) throw new Error('Source project not found');
const sourceFile = path.join(PATHS.projects, sourceId + '.json');
const hash = () => createHash('sha256').update(fs.readFileSync(sourceFile)).digest('hex');
const before = hash();
const copy = structuredClone(source);
copy.id = sourceId + '-eleven-' + randomUUID().slice(0, 8);
copy.title += ' | ElevenLabs voice review';
copy.slug += '-elevenlabs';
copy.voice = { ...copy.voice, provider: 'elevenlabs', name: '', en: '', es: '', enabled: true };
copy.editor = null;
copy.outputPath = null;
copy.outputs = {};
copy.renderLog = [];
copy.status = 'draft';
copy.error = null;
copy.metadata = { ...copy.metadata, courseRenderProof: null, sourceProjectId: sourceId,
  voiceReview: { status: 'awaiting-key-and-voice', approved: false, sample: null } };
copy.captions = { ...copy.captions, file: null };
const roots = new Map();
for (const scene of copy.scenes) {
  if (scene.assetProvider === 'lc-course-animations' && scene.assetPath) {
    const root = path.dirname(path.dirname(abs(scene.assetPath)));
    if (!roots.has(root)) {
      const dest = path.join(PATHS.assetsImages, copy.id, 'compositions-' + roots.size);
      fs.cpSync(root, dest, { recursive: true, errorOnExist: true, force: false });
      roots.set(root, dest);
    }
    scene.assetPath = path.relative(PATHS.root, path.join(roots.get(root), path.relative(root, abs(scene.assetPath)))).split(path.sep).join('/');
  }
  for (const key of ['narrationPath', 'narrationKey', 'narrationText', 'captionTimings', 'captionTimingText']) scene[key] = null;
  scene.narrationVoices = [];
  scene.narrationLangs = [];
  scene.durationLocked = false;
}
saveProject(copy);
const reopened = loadProject(copy.id);
assert.equal(reopened.script, source.script);
assert.deepEqual(reopened.scenes.map(s => s.text), source.scenes.map(s => s.text));
assert.ok(reopened.scenes.every(s => fs.existsSync(abs(s.assetPath))));
assert.equal(hash(), before);
console.log(JSON.stringify({ id: copy.id, sourceSHA256: before, sourceUnchanged: true,
  scenes: copy.scenes.length, compositions: copy.scenes.filter(s => s.assetProvider === 'lc-course-animations').length,
  project: 'http://127.0.0.1:4321/project-editor.html?id=' + copy.id,
  sample: null, rendered: false }, null, 2));
