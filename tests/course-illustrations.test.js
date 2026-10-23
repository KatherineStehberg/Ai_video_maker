import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PATHS } from '../src/lib/paths.js';
import { listAssets, resolveSafeAsset } from '../src/core/asset-manager.js';
import { resolveCourseIllustration, provideCourseVisual } from '../src/course-production/visuals.js';
import { loadPack } from '../src/course-production/index.js';

test('seven Remote Work lessons resolve portable, verified illustrations in both libraries', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PATHS.assetsImages, 'lc-chile-courses/remote-work/manifest.json')));
  const lessons = loadPack().items.filter(i => i.course.courseId === '56397');
  assert.equal(lessons.length, 7);
  assert.equal(manifest.assets.length, 7);
  const libraries = ['lc-chile', 'lc-chile-courses'].map(listAssets);
  for (const item of lessons) {
    const scene = { id: 'opening' };
    const project = { brand: 'lc-chile-courses', title: item.title, scenes: [scene, {id: 'practice'}] };
    const result = await provideCourseVisual({ project, scene, width: 1920, height: 1080 });
    const entry = manifest.assets.find(a => a.moduleId === item.id);
    assert.equal(result.path, entry.assetPath);
    const file = resolveSafeAsset(result.path);
    assert.ok(file);
    assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), entry.sha256);
    for (const library of libraries) assert.ok(library.some(a => a.path === result.path));
    assert.equal(resolveCourseIllustration({project, scene: project.scenes[1]}), null);
  }
});

test('other brands, unknown lessons and unrelated scenes retain existing visual flow', () => {
  const scene = {id: 'opening'};
  for (const project of [
    {brand: 'lc-chile', title: 'AI & Productivity', scenes: [scene]},
    {brand: 'lc-chile-courses', title: 'Unmapped lesson', scenes: [scene]},
    {brand: 'lc-chile-courses', title: 'AI & Productivity', scenes: []},
  ]) assert.equal(resolveCourseIllustration({project, scene}), null);
});
