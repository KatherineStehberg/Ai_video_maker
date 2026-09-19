import { listProviders, DEFAULT_PROVIDER } from '../providers/video-generation/index.js';
import { createJob, getJob, publicJob, draftJob, listJobs, FORMATS, STYLES, DURATION_LIMITS, DURATION_OPTIONS, PROMPT_MAX } from './jobs.js';

/**
 * Endpoints de generación de video con IA.
 *
 *   GET  /api/video-generation/config      -> proveedores, formatos, estilos
 *   POST /api/video-generation/jobs        -> crea el trabajo (202)
 *   GET  /api/video-generation/jobs/:id    -> estado del trabajo
 *
 * Mismas guardas de red que el resto de la aplicación. Ninguna respuesta
 * contiene claves: de los proveedores sólo se publica si están configurados y
 * qué variables de entorno necesitarían.
 */

const reply = (res, status, data) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
};

async function readJson(req, limit = 256 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('El cuerpo de la petición es demasiado grande');
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('JSON inválido'); }
}

export async function generationRoute(req, res, url) {
  if (!url.pathname.startsWith('/api/video-generation')) return false;
  if (!/^(::1|::ffff:127\.|127\.)/.test(req.socket.remoteAddress || '')) { reply(res, 403, { error: 'Generación disponible sólo desde este equipo' }); return true; }
  const host = req.headers.host || '';
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) { reply(res, 403, { error: 'Host local requerido' }); return true; }

  const parts = url.pathname.split('/').filter(Boolean);   // ['api','video-generation','config'|'jobs', id?]
  try {
    if (req.method === 'GET' && parts[2] === 'config') {
      reply(res, 200, {
        providers: listProviders(), defaultProvider: DEFAULT_PROVIDER,
        formats: FORMATS, styles: STYLES, duration: DURATION_LIMITS,
        durationOptions: DURATION_OPTIONS, promptMax: PROMPT_MAX,
      });
      return true;
    }

    // Proyectos recientes, para la pantalla de inicio. No borra nada.
    if (req.method === 'GET' && parts[2] === 'projects' && parts.length === 3) {
      reply(res, 200, { proyectos: listJobs({ limit: Number(url.searchParams.get('limit')) || 40 }) });
      return true;
    }

    // Borrador de guion y escenas, sin producir nada todavía.
    if (req.method === 'POST' && parts[2] === 'draft' && parts.length === 3) {
      reply(res, 200, await draftJob(await readJson(req)));
      return true;
    }

    if (req.method === 'POST' && parts[2] === 'jobs' && parts.length === 3) {
      const body = await readJson(req);
      const job = createJob(body, body.provider ? { providerName: String(body.provider) } : undefined);
      reply(res, 202, publicJob(job));
      return true;
    }

    if (req.method === 'GET' && parts[2] === 'jobs' && parts.length === 4) {
      const job = getJob(parts[3]);
      if (!job) { reply(res, 404, { error: 'Trabajo de generación no encontrado' }); return true; }
      reply(res, 200, publicJob(job));
      return true;
    }

    reply(res, 405, { error: 'Método o ruta no permitidos' });
    return true;
  } catch (e) {
    if (!res.destroyed) reply(res, 400, { error: e.message });
    return true;
  }
}
