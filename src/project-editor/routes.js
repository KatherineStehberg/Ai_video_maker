/**
 * API DEL EDITOR VISUAL  ·  /api/project-editor/...
 *
 * Namespace NUEVO y aparte. No toca `/api/studio`, `/api/analysis`,
 * `/api/video-edits` ni `/api/video-generation`: los endpoints que ya usa el
 * Orquestador siguen exactamente donde estaban.
 *
 * Mismas defensas que el estudio: solo desde este equipo, y las escrituras
 * exigen una cabecera propia para que una pagina de otro origen no pueda
 * dispararlas desde el navegador.
 *
 *   GET   /api/project-editor/config                      opciones reales
 *   GET   /api/project-editor/projects                    lista
 *   GET   /api/project-editor/projects/:id                proyecto + derivados
 *   PATCH /api/project-editor/projects/:id                guardar cambios
 *   GET   /api/project-editor/projects/:id/job            estado del trabajo
 *   GET   /api/project-editor/projects/:id/waveform       picos reales
 *   POST  /api/project-editor/projects/:id/regenerate     una escena
 *   POST  /api/project-editor/projects/:id/export         MP4
 *
 *   GET   /api/project-editor/library/images?q=&aspecto=&pagina=   buscar
 *   POST  /api/project-editor/library/images/import      { id, consulta }
 *   GET   /api/project-editor/library/music?q=&maxDuracion=         listar
 *   GET   /api/project-editor/library/sfx?q=&categoria=             listar
 *
 * La biblioteca NUNCA devuelve la clave del proveedor ni acepta URLs de
 * descarga del navegador: solo terminos de busqueda e identificadores.
 */

import { capacidades, listar, vistaEditor, guardar, regenerarEscena, exportar, estadoTrabajo, ondaDe } from './service.js';
import { buscarImagenes, importarImagen, listarMusica, listarSfx } from './media-library.js';

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

async function leerJson(req) {
  let texto = '';
  for await (const trozo of req) {
    texto += trozo;
    if (texto.length > 2_000_000) throw new Error('Solicitud demasiado grande.');
  }
  return JSON.parse(texto || '{}');
}

const esLocal = req => /^(::1|::ffff:127\.|127\.)/.test(req.socket.remoteAddress || '');

export async function projectEditorRoute(req, res, url) {
  if (!url.pathname.startsWith('/api/project-editor')) return false;

  if (!esLocal(req)) { send(res, 403, { error: 'Sólo acceso local.' }); return true; }
  if (req.method !== 'GET') {
    const cabecera = req.headers['x-editor-request'] === '1';
    const origen = !req.headers.origin || req.headers.origin === `http://${req.headers.host}`;
    if (!cabecera || !origen) { send(res, 403, { error: 'Solicitud de editor no autorizada.' }); return true; }
  }

  const seg = url.pathname.split('/').filter(Boolean).slice(2);  // ['config'|'projects', id?, accion?]

  try {
    if (req.method === 'GET' && seg[0] === 'config') { send(res, 200, await capacidades()); return true; }

    if (seg[0] === 'library') {
      if (req.method === 'GET' && seg[1] === 'images' && !seg[2]) {
        send(res, 200, await buscarImagenes({
          consulta: url.searchParams.get('q'),
          aspecto: url.searchParams.get('aspecto') || '9:16',
          idioma: url.searchParams.get('idioma') || 'es',
          pagina: url.searchParams.get('pagina') || 1,
        }));
        return true;
      }
      if (req.method === 'POST' && seg[1] === 'images' && seg[2] === 'import') {
        const b = await leerJson(req);
        send(res, 201, await importarImagen({ id: b.id, consulta: b.consulta }));
        return true;
      }
      if (req.method === 'GET' && seg[1] === 'music') {
        send(res, 200, await listarMusica({
          consulta: url.searchParams.get('q') || '',
          maxDuracion: url.searchParams.get('maxDuracion'),
        }));
        return true;
      }
      if (req.method === 'GET' && seg[1] === 'sfx') {
        send(res, 200, await listarSfx({
          consulta: url.searchParams.get('q') || '',
          categoria: url.searchParams.get('categoria') || null,
        }));
        return true;
      }
    }

    if (seg[0] === 'projects') {
      if (req.method === 'GET' && !seg[1]) { send(res, 200, { proyectos: await listar() }); return true; }

      const id = seg[1];
      if (id) {
        if (req.method === 'GET' && !seg[2]) { send(res, 200, await vistaEditor(id)); return true; }
        if (req.method === 'GET' && seg[2] === 'job') { send(res, 200, await estadoTrabajo(id)); return true; }
        if (req.method === 'GET' && seg[2] === 'waveform') {
          const pista = url.searchParams.get('pista') || 'narracion';
          const muestras = Number(url.searchParams.get('muestras')) || undefined;
          send(res, 200, await ondaDe(id, pista, muestras));
          return true;
        }
        if (req.method === 'PATCH' && !seg[2]) { send(res, 200, await guardar(id, await leerJson(req))); return true; }
        if (req.method === 'POST' && seg[2] === 'regenerate') {
          const b = await leerJson(req);
          send(res, 202, await regenerarEscena(id, b.index, {
            visual: b.visual !== false, voz: b.voz !== false, montar: b.montar === true,
          }));
          return true;
        }
        if (req.method === 'POST' && seg[2] === 'export') { send(res, 202, await exportar(id)); return true; }
      }
    }

    send(res, 404, { error: 'Ruta del editor no encontrada.' });
  } catch (e) {
    if (!res.destroyed) send(res, 400, { error: e.message });
  }
  return true;
}
