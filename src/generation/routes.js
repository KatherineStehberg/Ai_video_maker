import { listProviders, defaultProvider } from '../providers/video-generation/index.js';
import {
  createJob, getJob, publicJob, draftJob, planJob, listJobs, resumeJob, regenerateScene,
  FORMATS, STYLES, DURATION_LIMITS, DURATION_OPTIONS, PROMPT_MAX, SCRIPT_MAX_CHARS, MAX_ESCENAS,
} from './jobs.js';
import { HTTP_BODY_MAX, SCENE_TEXT_MAX, SCENE_DURATION_LIMITS } from './limits.js';
import { ETAPAS, ESTADOS } from './states.js';
import { WPM_POR_DEFECTO, PAUSA_ENTRE_ESCENAS } from './segmenter.js';
import { normalizeOrchestratorInput, specDesdeContrato, CONTRACT_VERSION } from './orchestrator-contract.js';

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

/**
 * El límite tiene que dejar pasar un guion largo COMPLETO más sus escenas ya
 * editadas (que repiten el mismo texto). Ver `limits.js`: son 8 MB, muy por
 * encima de las ~400 KB que ocupa el guion más largo admitido.
 */
async function readJson(req, limit = HTTP_BODY_MAX) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw new Error(`El cuerpo de la petición supera ${(limit / 1024 / 1024).toFixed(0)} MB, que es el límite técnico. No se ha procesado nada.`);
    }
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
        providers: listProviders(), defaultProvider: defaultProvider(),
        formats: FORMATS, styles: STYLES, duration: DURATION_LIMITS,
        durationOptions: DURATION_OPTIONS,
        // Límites técnicos REALES, publicados para que la interfaz los muestre
        // en vez de inventarse los suyos.
        limits: {
          promptMax: PROMPT_MAX, scriptMax: SCRIPT_MAX_CHARS, maxEscenas: MAX_ESCENAS,
          sceneTextMax: SCENE_TEXT_MAX, sceneDuration: SCENE_DURATION_LIMITS,
          duration: DURATION_LIMITS, httpBodyMax: HTTP_BODY_MAX,
        },
        narration: { wpm: WPM_POR_DEFECTO, pausaEntreEscenas: PAUSA_ENTRE_ESCENAS },
        states: ESTADOS, stages: ETAPAS,
        orchestratorContract: CONTRACT_VERSION,
        promptMax: PROMPT_MAX,   // compatibilidad con la interfaz anterior
      });
      return true;
    }

    // Estimación pura: palabras, escenas y duración, sin producir nada.
    if (req.method === 'POST' && parts[2] === 'plan' && parts.length === 3) {
      reply(res, 200, planJob(await readJson(req)));
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

    // Reanudar un proyecto interrumpido, reutilizando lo ya producido.
    if (req.method === 'POST' && parts[2] === 'jobs' && parts[4] === 'resume' && parts.length === 5) {
      reply(res, 202, publicJob(resumeJob(parts[3])));
      return true;
    }

    // Regenerar UNA escena; las demás se reutilizan tal cual.
    if (req.method === 'POST' && parts[2] === 'jobs' && parts[4] === 'scenes' && parts.length === 6) {
      const body = await readJson(req);
      reply(res, 202, publicJob(regenerateScene(parts[3], Number(parts[5]), body)));
      return true;
    }

    /*
     * Contrato del Orquestador KSL. Valida y normaliza SIN producir nada
     * cuando `dryRun` viene marcado, que es como el Orquestador podrá
     * comprobar su carga útil antes de mandarla de verdad.
     *
     * Aquí no hay ningún cliente del Orquestador ni ninguna credencial: esto
     * sólo recibe.
     */
    if (req.method === 'POST' && parts[2] === 'orchestrator' && parts.length === 3) {
      const body = await readJson(req);
      const contrato = normalizeOrchestratorInput(body);
      const spec = specDesdeContrato(contrato);
      if (body.dryRun) {
        reply(res, 200, { contractVersion: CONTRACT_VERSION, aceptado: true, contrato, plan: planJob(spec) });
        return true;
      }
      reply(res, 202, publicJob(createJob(spec)));
      return true;
    }

    reply(res, 405, { error: 'Método o ruta no permitidos' });
    return true;
  } catch (e) {
    if (!res.destroyed) reply(res, 400, { error: e.message });
    return true;
  }
}
