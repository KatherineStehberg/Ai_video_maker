import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PATHS, ensureDir } from '../lib/paths.js';
import { get as getAnalysis } from '../analysis/routes.js';
import { planEdit } from './plan.js';
import { exportEdit } from './export.js';
import { validateProposal } from './schema.js';
import { ASPECTS } from '../config.js';

const root = path.join(PATHS.data, 'video-edits');
const UUID = /^[\da-f-]{36}$/;
let exporting = false;

const reply = (res, status, data) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
};

async function readJson(req, limit = 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Cuerpo de la petición demasiado grande');
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('JSON inválido'); }
}

const file = id => path.join(root, `${id}.json`);
export const saveProposal = p => { ensureDir(root); fs.writeFileSync(file(p.id), JSON.stringify(p, null, 2), 'utf8'); return p; };
export function loadProposal(id) {
  if (!UUID.test(id || '')) return null;
  try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { return null; }
}

export async function editsRoute(req, res, url) {
  if (!url.pathname.startsWith('/api/video-edits')) return false;
  // Mismas restricciones que el análisis: sólo este equipo, sólo host local.
  if (!/^(::1|::ffff:127\.|127\.)/.test(req.socket.remoteAddress || '')) { reply(res, 403, { error: 'Edición disponible sólo desde este equipo' }); return true; }
  const host = req.headers.host || '';
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) { reply(res, 403, { error: 'Host local requerido' }); return true; }

  const parts = url.pathname.split('/').filter(Boolean);   // ['api','video-edits',id?,action?]
  try {
    if (req.method === 'GET' && parts.length === 2) { reply(res, 200, { formats: Object.keys(ASPECTS), aspects: ASPECTS }); return true; }

    // Crear propuesta a partir de un análisis existente.
    if (req.method === 'POST' && parts.length === 2) {
      const body = await readJson(req);
      const job = getAnalysis(String(body.videoJobId || ''));
      if (!job) { reply(res, 404, { error: 'Análisis de origen no encontrado' }); return true; }
      if (job.status !== 'complete') { reply(res, 409, { error: `El análisis está en estado "${job.status}"; debe estar completo para proponer una edición` }); return true; }
      const proposal = planEdit(job, {
        format: body.format ?? '9:16',
        targetDuration: body.targetDuration ?? null,
        syncMode: body.syncMode ?? 'beats',
        enableSpeedRamps: body.enableSpeedRamps ?? true,
        approvalRequired: body.approvalRequired ?? true,
      });
      saveProposal(proposal);
      reply(res, 201, proposal);
      return true;
    }

    const id = parts[2] || '';
    const proposal = loadProposal(id);
    if (!proposal) { reply(res, 404, { error: 'Propuesta de edición no encontrada' }); return true; }
    const action = parts[3];

    if (req.method === 'GET' && !action) { reply(res, 200, proposal); return true; }

    if (req.method === 'GET' && action === 'file') {
      if (!proposal.export) { reply(res, 409, { error: 'La propuesta todavía no se ha exportado' }); return true; }
      const target = path.resolve(PATHS.root, proposal.export.file);
      if (!target.startsWith(PATHS.output) || !fs.existsSync(target)) { reply(res, 404, { error: 'Archivo exportado no disponible' }); return true; }
      const size = fs.statSync(target).size;
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': size, 'accept-ranges': 'bytes' });
      fs.createReadStream(target).pipe(res);
      return true;
    }

    // Aprobación humana explícita: es el paso que habilita la exportación.
    if (req.method === 'POST' && action === 'approve') {
      const body = await readJson(req);
      if (body.confirm !== true) { reply(res, 400, { error: 'Se requiere {"confirm": true} para aprobar la propuesta' }); return true; }
      validateProposal(proposal, { duration: proposal.sourceDuration });
      proposal.approval = { status: 'aprobada', at: new Date().toISOString(), by: typeof body.by === 'string' ? body.by.slice(0, 120) : 'local' };
      saveProposal(proposal);
      reply(res, 200, proposal);
      return true;
    }

    if (req.method === 'POST' && action === 'export') {
      if (proposal.approvalRequired && proposal.approval?.status !== 'aprobada') {
        reply(res, 403, { error: 'La propuesta requiere aprobación humana explícita antes de exportar' }); return true;
      }
      if (exporting) { reply(res, 409, { error: 'Hay una exportación en curso; espera a que termine' }); return true; }
      const body = await readJson(req);
      const fit = body.fit === 'crop' ? 'crop' : 'pad';
      exporting = true;
      try {
        const report = await exportEdit(proposal, { fit });
        saveProposal(proposal);
        reply(res, 200, { id: proposal.id, syncStatus: proposal.syncStatus, export: report, warnings: proposal.warnings });
      } finally { exporting = false; }
      return true;
    }

    reply(res, 405, { error: 'Método o acción no permitidos' });
    return true;
  } catch (e) {
    if (!res.destroyed) reply(res, 400, { error: e.message });
    return true;
  }
}
