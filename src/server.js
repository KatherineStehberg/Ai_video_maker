import http from 'node:http';
import { analysisRoute } from './analysis/routes.js';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, publicConfig, ASPECTS } from './config.js';
import { PATHS, ensureDirs, abs, rel } from './lib/paths.js';
import { logger } from './lib/logger.js';
import { resolveFfmpeg } from './lib/ffmpeg.js';
import {
  makeProject, makeScene, saveProject, loadProject, listProjects, deleteProject,
  validateProject, totalDuration, STATUS,
} from './core/project.js';
import { listBrands, loadBrand, saveBrand } from './core/brands.js';
import { listTemplates, getTemplate } from './templates/index.js';
import { listAssets, listTracks, saveUpload, resolveSafeAsset } from './core/asset-manager.js';
import { outline } from './core/scene-planner.js';
import { previewVoice } from './core/tts.js';
import { buildCues, cuesToVtt } from './core/subtitles.js';
import { buildExportPackage, pendingFormats } from './core/export.js';
import { cleanIntermediates } from './core/renderer.js';
import { createJob, getJob, listJobs, cancelJob, publicJob, queueStats, restoreJobs } from './core/jobs.js';
import * as ttsProviders from './providers/tts/index.js';
import * as llmProviders from './providers/llm/index.js';
import * as imageProviders from './providers/image/index.js';
import * as musicProviders from './providers/music/index.js';
import { PLATFORMS, publishers, buildMetadata } from './providers/publish/index.js';
import { hardwareReport } from './lib/hardware.js';

const log = logger('server');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.srt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.ttf': 'font/ttf',
};

const MAX_UPLOAD = 60 * 1024 * 1024; // 60 MB

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

const ok = (res, data) => send(res, 200, data);
const fail = (res, status, message, extra = {}) => send(res, status, { error: message, ...extra });

async function readBody(req, limit = MAX_UPLOAD) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Cuerpo de la peticion demasiado grande');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buf = await readBody(req, 8 * 1024 * 1024);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new Error('JSON invalido');
  }
}

/** Sirve un archivo con soporte de Range (necesario para <video> en Chrome). */
function serveFile(req, res, file, { download = false } = {}) {
  const stat = fs.statSync(file);
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'content-type': type };
  if (download) headers['content-disposition'] = `attachment; filename="${path.basename(file)}"`;

  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Number(m[2]) : stat.size - 1;
    if (start >= stat.size) {
      res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${stat.size}`,
      'accept-ranges': 'bytes',
      'content-length': end - start + 1,
    });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }

  res.writeHead(200, { ...headers, 'content-length': stat.size, 'accept-ranges': 'bytes' });
  return fs.createReadStream(file).pipe(res);
}

/** Parser de multipart/form-data minimo (solo lo que necesita la subida de assets). */
function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw new Error('Boundary no encontrado');
  const boundary = Buffer.from(`--${(m[1] || m[2]).trim()}`);
  const parts = [];
  let start = buffer.indexOf(boundary);
  if (start === -1) throw new Error('Multipart malformado');
  start += boundary.length;

  while (start < buffer.length) {
    if (buffer.slice(start, start + 2).toString() === '--') break;
    start += 2; // CRLF tras el boundary
    const headerEnd = buffer.indexOf('\r\n\r\n', start);
    if (headerEnd === -1) break;
    const headers = buffer.slice(start, headerEnd).toString('utf8');
    const bodyStart = headerEnd + 4;
    const next = buffer.indexOf(boundary, bodyStart);
    if (next === -1) break;
    const body = buffer.slice(bodyStart, next - 2); // quita el CRLF final

    const nameM = /name="([^"]*)"/i.exec(headers);
    const fileM = /filename="([^"]*)"/i.exec(headers);
    parts.push({
      name: nameM ? nameM[1] : '',
      filename: fileM ? fileM[1] : null,
      data: body,
    });
    start = next + boundary.length;
  }
  return parts;
}

// ---------------------------------------------------------------- rutas API

async function handleApi(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const p = seg.slice(1);
  const method = req.method;

  // ---- salud / entorno ----
  if (p[0] === 'health') {
    const ff = await resolveFfmpeg();
    return ok(res, {
      ok: true,
      version: '0.1.0',
      ffmpeg: { available: ff.available, path: ff.ffmpeg, ffprobe: ff.ffprobe },
      queue: queueStats(),
      config: publicConfig(),
    });
  }

  if (p[0] === 'doctor') {
    const ff = await resolveFfmpeg();
    return ok(res, {
      hardware: await hardwareReport(),
      ffmpeg: ff,
      providers: {
        llm: await llmProviders.status(),
        tts: await ttsProviders.status(),
        image: await imageProviders.status(),
        music: await musicProviders.status(),
      },
      node: process.version,
      platform: process.platform,
    });
  }

  // ---- catalogos ----
  if (p[0] === 'templates') return ok(res, listTemplates());
  if (p[0] === 'aspects') return ok(res, ASPECTS);
  if (p[0] === 'platforms') {
    return ok(res, PLATFORMS.map((id) => ({
      id,
      implemented: publishers[id].implemented,
      limits: publishers[id].limits,
    })));
  }
  if (p[0] === 'voices') return ok(res, await ttsProviders.listAllVoices());

  if (p[0] === 'brands') {
    if (method === 'GET' && !p[1]) return ok(res, listBrands());
    if (method === 'GET' && p[1]) return ok(res, loadBrand(p[1]));
    if (method === 'POST') return ok(res, saveBrand(await readJson(req)));
    return fail(res, 405, 'Metodo no permitido');
  }

  if (p[0] === 'assets') {
    if (method === 'GET') {
      return ok(res, {
        images: listAssets(url.searchParams.get('brand')),
        music: listTracks(url.searchParams.get('brand')),
      });
    }
    if (method === 'POST') {
      const buf = await readBody(req);
      const parts = parseMultipart(buf, req.headers['content-type']);
      const field = Object.fromEntries(
        parts.filter((x) => !x.filename).map((x) => [x.name, x.data.toString('utf8')]),
      );
      const saved = parts
        .filter((x) => x.filename && x.data.length)
        .map((x) => saveUpload(x.filename, x.data, {
          brand: field.brand || null,
          kind: field.kind || 'image',
        }));
      if (!saved.length) return fail(res, 400, 'No se recibio ningun archivo');
      return ok(res, { saved });
    }
    return fail(res, 405, 'Metodo no permitido');
  }

  // ---- proyectos ----
  if (p[0] === 'projects') {
    if (method === 'GET' && !p[1]) return ok(res, listProjects());

    if (method === 'POST' && !p[1]) {
      const body = await readJson(req);
      const template = getTemplate(body.template);
      const project = makeProject({
        ...body,
        template: template.id,
        aspectRatio: body.aspectRatio || template.aspectRatio,
        exportFormats: body.exportFormats?.length ? body.exportFormats : template.exportFormats,
        platform: body.platform?.length ? body.platform : template.platform,
        captions: { ...template.captions, ...(body.captions || {}) },
      });
      saveProject(project);
      log.info('Proyecto creado:', project.id, project.title);
      return send(res, 201, project);
    }

    const id = p[1];
    if (!id) return fail(res, 404, 'Ruta no encontrada');
    const project = loadProject(id);
    if (!project) return fail(res, 404, `Proyecto ${id} no encontrado`);

    // /api/projects/:id
    if (!p[2]) {
      if (method === 'GET') {
        return ok(res, {
          ...project,
          _outline: outline(project),
          _validation: validateProject(project),
          _pendingFormats: pendingFormats(project),
        });
      }
      if (method === 'PUT' || method === 'PATCH') {
        const body = await readJson(req);
        const merged = makeProject({
          ...project,
          ...body,
          id: project.id,
          createdAt: project.createdAt,
          scenes: body.scenes ? body.scenes.map(makeScene) : project.scenes,
        });
        saveProject(merged);
        return ok(res, { ...merged, _outline: outline(merged), _validation: validateProject(merged) });
      }
      if (method === 'DELETE') {
        deleteProject(id);
        return ok(res, { deleted: id, note: 'Assets y renders NO se borraron' });
      }
      return fail(res, 405, 'Metodo no permitido');
    }

    // /api/projects/:id/<accion>
    switch (p[2]) {
      case 'outline':
        return ok(res, outline(project));

      case 'validate':
        return ok(res, validateProject(project));

      case 'scenes': {
        if (method === 'GET') return ok(res, project.scenes);
        if (method === 'PUT') {
          const body = await readJson(req);
          project.scenes = (body.scenes || []).map(makeScene);
          saveProject(project);
          return ok(res, { scenes: project.scenes, outline: outline(project) });
        }
        return fail(res, 405, 'Metodo no permitido');
      }

      case 'captions': {
        const cues = buildCues(project);
        if (url.searchParams.get('format') === 'vtt') {
          return send(res, 200, cuesToVtt(cues), { 'content-type': MIME['.vtt'] });
        }
        return ok(res, cues);
      }

      case 'metadata':
        return ok(res, project.metadata || buildMetadata(project, loadBrand(project.brand)));

      case 'export': {
        if (method !== 'POST') return fail(res, 405, 'Metodo no permitido');
        return ok(res, buildExportPackage(project));
      }

      case 'clean':
        return ok(res, { removed: cleanIntermediates(project.id) });

      case 'run': {
        if (method !== 'POST') return fail(res, 405, 'Metodo no permitido');
        const body = await readJson(req);
        const job = createJob({
          project: project.id,
          steps: body.steps || undefined,
          format: body.formats || body.format || undefined,
          priority: body.priority ?? 1,
          stopOnMissingAssets: body.stopOnMissingAssets ?? false,
          source: 'ui',
        });
        return send(res, 202, publicJob(job));
      }

      default:
        return fail(res, 404, 'Accion desconocida');
    }
  }

  // ---- jobs: contrato para el Orquestador KSL ----
  if (p[0] === 'video-jobs' || p[0] === 'jobs') {
    if (method === 'POST' && !p[1]) {
      const body = await readJson(req);
      if (!body.project && !body.prompt && !body.title) {
        return fail(res, 400, 'Se requiere `project` (id existente) o `prompt`/`title`');
      }
      const job = createJob({ ...body, source: body.source || 'orchestrator' });
      log.info('Job creado:', job.id, '->', job.projectId);
      return send(res, 202, publicJob(job));
    }
    if (method === 'GET' && !p[1]) {
      return ok(res, {
        jobs: listJobs({ status: url.searchParams.get('status') }).map(publicJob),
        queue: queueStats(),
      });
    }
    if (method === 'GET' && p[1]) {
      const job = getJob(p[1]);
      return job ? ok(res, publicJob(job)) : fail(res, 404, 'Job no encontrado');
    }
    if (method === 'DELETE' && p[1]) {
      const r = cancelJob(p[1]);
      if (!r) return fail(res, 404, 'Job no encontrado');
      return r.ok ? ok(res, publicJob(r.job)) : fail(res, 409, r.reason);
    }
    return fail(res, 405, 'Metodo no permitido');
  }

  // ---- utilidades ----
  if (p[0] === 'preview-voice' && method === 'POST') {
    const body = await readJson(req);
    try {
      const file = await previewVoice(body.text || 'Hola, esta es una prueba de voz.', {
        provider: body.provider || 'auto',
        voice: body.voice || '',
        rate: body.rate ?? 0,
      });
      return ok(res, { file, url: `/file?path=${encodeURIComponent(file)}` });
    } catch (e) {
      return fail(res, 503, e.message);
    }
  }

  if (p[0] === 'publish' && method === 'POST') {
    // Existe para documentar el contrato y devolver siempre 501.
    return send(res, 501, {
      error: 'Publicacion automatica no implementada por diseno',
      hint: 'Usa POST /api/projects/:id/export y sube el MP4 manualmente',
    });
  }

  return fail(res, 404, 'Endpoint no encontrado');
}

// ---------------------------------------------------------------- servidor

export function createServer() {
  ensureDirs();
  restoreJobs();

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // Solo se acepta trafico local: esta herramienta no esta pensada para exponerse.
    const remote = req.socket.remoteAddress || '';
    if (!/^(::1|::ffff:127\.|127\.)/.test(remote) && CONFIG.host === '127.0.0.1') {
      return fail(res, 403, 'Solo se permiten conexiones locales');
    }

    try {
      if (await analysisRoute(req, res, url)) return;
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

      // Sirve assets y renders bajo data/ y output/ (con validacion de ruta).
      if (url.pathname === '/file') {
        const requested = url.searchParams.get('path');
        const file = resolveSafeAsset(requested);
        if (!file) return fail(res, 404, 'Archivo no encontrado o fuera de las carpetas permitidas');
        return serveFile(req, res, file, { download: url.searchParams.has('download') });
      }

      // UI estatica
      let file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const target = path.resolve(PATHS.ui, file);
      if (!target.startsWith(PATHS.ui) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
        return fail(res, 404, 'No encontrado');
      }
      return serveFile(req, res, target);
    } catch (e) {
      log.error(req.method, url.pathname, '->', e.message);
      return fail(res, 500, e.message);
    }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

if (isMain) {
  const server = createServer();
  server.listen(CONFIG.port, CONFIG.host, async () => {
    const ff = await resolveFfmpeg();
    console.log('');
    console.log('  AI_Video_Maker');
    console.log(`  UI:      http://${CONFIG.host}:${CONFIG.port}`);
    console.log(`  API:     http://${CONFIG.host}:${CONFIG.port}/api/health`);
    console.log(`  FFmpeg:  ${ff.available ? ff.ffmpeg : 'NO DISPONIBLE -> npm run doctor'}`);
    console.log(`  LLM:     ${CONFIG.llm.provider}   TTS: ${CONFIG.tts.provider}`);
    console.log('');
  });
}
