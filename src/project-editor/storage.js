/**
 * CAPA DE ALMACENAMIENTO DEL EDITOR
 *
 * El editor NO habla con el disco directamente: pasa por aqui. Es una interfaz
 * deliberadamente pequena para que manana se pueda poner Supabase (o cualquier
 * otra cosa) debajo sin tocar ni el editor ni el resto del pipeline.
 *
 * HOY el almacenamiento real es el MISMO de siempre:
 *
 *   data/projects/<id>.json   proyecto completo (escenas, subtitulos, audio…)
 *   output/drafts/<id>/       intermedios: voz por escena, clips, .srt, .ass
 *   output/final/             los MP4 entregados
 *   data/studio-imports/      recursos importados por la usuaria
 *
 * La escritura del JSON ya es atomica (`saveProject` escribe a `.tmp` y
 * renombra), asi que un corte a mitad de guardado no deja un proyecto corrupto.
 *
 * QUE HARIA FALTA PARA CAMBIAR DE BACKEND
 * ---------------------------------------
 * Implementar otro objeto con estos mismos cinco metodos y pasarlo a
 * `setStorage()`. Nada mas del editor conoce rutas de disco.
 *
 * Lo que NO resuelve esta capa todavia, y habra que decidir al conectar
 * Supabase: los binarios (imagenes, WAV, MP4) siguen siendo rutas locales
 * dentro del proyecto. Subirlos a un bucket es un trabajo aparte, no un
 * detalle de esta interfaz.
 */

import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../lib/paths.js';
import {
  loadProject, saveProject, listProjects, deleteProject, projectFile,
} from '../core/project.js';

/**
 * Almacenamiento local: el que usa el producto hoy.
 *
 * Cada metodo es sincrono por dentro pero se declara `async`: un backend
 * remoto lo sera de verdad, y asi el editor ya esta escrito para esperar.
 */
export const localStorageAdapter = {
  id: 'local-json',
  label: 'Archivos JSON en este equipo',

  /** Describe donde vive todo, para poder mostrarlo en la interfaz. */
  describe() {
    return {
      id: this.id,
      label: this.label,
      proyectos: path.relative(PATHS.root, PATHS.projects).split(path.sep).join('/'),
      intermedios: path.relative(PATHS.root, PATHS.drafts).split(path.sep).join('/'),
      salidas: path.relative(PATHS.root, PATHS.final).split(path.sep).join('/'),
      atomico: true,
      remoto: false,
    };
  },

  async list() {
    return listProjects();
  },

  async load(id) {
    return loadProject(id);
  },

  async save(project) {
    saveProject(project);
    return project;
  },

  async remove(id) {
    return deleteProject(id);
  },

  /** Fecha de ultima escritura en disco, para detectar ediciones externas. */
  async modifiedAt(id) {
    const file = projectFile(id);
    try { return fs.statSync(file).mtimeMs; } catch { return null; }
  },
};

let actual = localStorageAdapter;

/** Sustituye el almacenamiento. Pensado para pruebas y para el futuro backend. */
export function setStorage(adapter) {
  if (!adapter || typeof adapter.load !== 'function' || typeof adapter.save !== 'function') {
    throw new Error('El almacenamiento debe implementar al menos load() y save()');
  }
  actual = adapter;
  return actual;
}

export function getStorage() {
  return actual;
}
