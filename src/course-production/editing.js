import fs from 'node:fs';
import { makeProject, loadProject, saveProject, listProjects, projectFile } from '../core/project.js';
import { validatePack } from './queue.js';

// Lookup never rewrites an existing project, including manually edited drafts.
export function findCourseProject(item, entry = {}) {
  if (entry.projectId) {
    const p = loadProject(entry.projectId);
    if (!p) throw new Error('El proyecto registrado no existe; restaura los datos antes de crear otro.');
    return p;
  }
  const matches = listProjects().map(p => loadProject(p.id)).filter(p =>
    p.metadata?.courseSource?.id === item.id ||
    p.studio?.commissionId === item.id ||
    (p.title === item.title && (p.script === item.script || p.scenes.map(s => s.text).join('\n\n') === item.script)));
  if (matches.length > 1) throw new Error('Hay varios proyectos del curso; revisa su asociacion antes de continuar.');
  return matches[0] || null;
}

export function prepareCourseProject(pack, id, entry = {}) {
  validatePack(pack);
  const item = pack.items.find(i => i.id === id);
  if (!item) throw new Error('Curso no encontrado');
  const existing = findCourseProject(item, entry);
  if (existing) return existing;
  const projectId = 'vid_course_' + item.id;
  if (fs.existsSync(projectFile(projectId))) throw new Error('El identificador ya existe; no se sobrescribe el proyecto.');
  const p = makeProject({ id: projectId, title: item.title, brand: 'lc-chile-courses',
    template: 'video-curso', language: item.language, aspectRatio: '16:9',
    script: item.script, scenes: item.scenes.map(s => ({ ...s, assetPath: null, narrationPath: null })),
    voice: { provider: 'sapi', enabled: true }, music: { enabled: false },
    captions: { enabled: true, burnIn: true, style: { preset: 'curso' } },
    metadata: { courseSource: { id: item.id, scriptSha256: item.scriptSha256, sources: item.sources, course: item.course } },
  });
  saveProject(p);
  return p;
}
