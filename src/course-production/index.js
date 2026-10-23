import fs from 'node:fs';
import path from 'node:path';
import { PATHS, abs } from '../lib/paths.js';
import { resolveFfmpeg, run } from '../lib/ffmpeg.js';
import { listAllVoices } from '../providers/tts/index.js';
import { createJob, getJob, listJobs, normalizeSpec, resumeJob } from '../generation/jobs.js';
import { normalizeOrchestratorInput, specDesdeContrato } from '../generation/orchestrator-contract.js';
import { loadProject } from '../core/project.js';
import { createCourseQueue } from './queue.js';

export const packFile = path.join(PATHS.root, 'content/courses/lc-chile-20261004.json');
export const loadPack = () => JSON.parse(fs.readFileSync(packFile, 'utf8'));
let queue = null;
let startupError = null;

export function courseSpec(item, voice) {
  const contract = normalizeOrchestratorInput({
    projectId: `course:${item.id}:${item.scriptSha256}`, brandId: 'lc-chile-courses',
    title: item.title, script: item.script, format: '16:9', platform: 'lms', style: 'corporativo',
    voice: { provider: voice.provider, name: voice.name, enabled: true, rate: -1 },
    sourceReference: { kind: 'url', id: item.sources[0], name: item.id },
    music: { enabled: false }, subtitles: { enabled: true, burnIn: true, language: 'en', style: { preset: 'curso' } },
    course: item.course,
  });
  // Explicit scenes prevent LLM rewriting, narration of production directions,
  // or paid script generation. Preserve every word of the prepared narration.
  return normalizeSpec({ ...specDesdeContrato(contract), templateId: 'video-curso',
    escenas: item.scenes, scriptSource: 'course-source-adaptation' });
}

export async function preflight() {
  const ff = await resolveFfmpeg();
  const voices = await listAllVoices();
  const voice = voices.find(v => /^en(?:[-_]|$)/i.test(v.language || v.locale || v.name || '') && ['sapi','piper'].includes(v.provider));
  const reasons = [];
  if (!ff.ffmpeg || !ff.ffprobe) reasons.push('Se necesitan FFmpeg y ffprobe para producir y verificar los MP4.');
  if (!voice) reasons.push('Se necesita una voz local en inglés (SAPI o Piper). No se producirán videos silenciosos ni con una voz de otro idioma.');
  return { ok: reasons.length === 0, reasons, voice: voice ? { name: voice.name, provider: voice.provider, language: voice.language } : null };
}

async function verify(job, item) {
  const no = reason => ({ ok: false, reason });
  if (job.generation?.mock || job.provider?.id !== 'pipeline') return no('El resultado no pertenece al pipeline real.');
  const file = job.generation?.file && abs(job.generation.file);
  if (!file || !fs.existsSync(file) || fs.statSync(file).size === 0) return no('No existe un MP4 utilizable.');
  const project = loadProject(job.projectId);
  if (!project || project.scenes.map(s => s.text).join('\n\n') !== item.script) return no('La narración del proyecto no coincide con el guion preparado.');
  if (project.scenes.some(s => !s.narrationPath || !fs.existsSync(abs(s.narrationPath)))) return no('Falta la narración de una o más escenas.');
  if (project.scenes.some(s => !s.assetPath || !fs.existsSync(abs(s.assetPath)))) return no('Falta el visual de una o más escenas.');
  if (!project.captions?.file || !fs.existsSync(abs(project.captions.file))) return no('Falta el archivo de subtítulos.');
  if (!job.generation.spec?.subtitulos || !project.captions?.enabled || !project.captions?.burnIn) return no('No se confirmó la generación de subtítulos completos.');
  const ff = await resolveFfmpeg();
  const measured = await run(ff.ffprobe, ['-v','error','-show_streams','-show_format','-of','json',file]);
  if (measured.code !== 0) return no('ffprobe no pudo verificar el MP4.');
  const media = JSON.parse(measured.stdout);
  const video = media.streams.find(s => s.codec_type === 'video');
  const audio = media.streams.find(s => s.codec_type === 'audio');
  if (!audio || !video || video.width !== 1920 || video.height !== 1080 || !(Number(media.format.duration) > 0)) return no('Formato, duración o pista de audio no válidos.');
  const decoded = await run(ff.ffmpeg, ['-hide_banner','-nostdin','-v','info','-xerror','-i',file,'-af','volumedetect','-f','null','-']);
  const mean = Number(decoded.stderr.match(/mean_volume:\s*(-?[\d.]+) dB/)?.[1]);
  if (decoded.code !== 0 || !Number.isFinite(mean) || mean < -55) return no('El MP4 no se decodifica completamente o la narración es inaudible.');
  return { ok: true, durationSeconds: Number(media.format.duration), bytes: fs.statSync(file).size,
    width: video.width, height: video.height, audio: true, meanVolumeDb: mean, fullyDecoded: true, scriptSha256: item.scriptSha256,
    notes: 'Verificación técnica automática. Calidad visual, pronunciación y sincronía requieren revisión final.' };
}

export function getCourseQueue() {
  if (queue) return queue;
  const queueDir = process.env.AIVM_COURSE_QUEUE_DIR || path.join(PATHS.data,'course-production');
  queue = createCourseQueue({ pack: loadPack(), stateFile: path.join(queueDir,'state.json'), backend: {
    preflight, getJob, verify,
    resumeJob: id => resumeJob(id, { providerName: 'pipeline' }),
    findJob: (id, hash) => listJobs({ limit: 100000 }).map(j => getJob(j.id)).find(j => j?.spec?.orchestratorProjectId === `course:${id}:${hash}`),
    submit: (item, voice) => createJob(courseSpec(item, voice), { providerName: 'pipeline' }),
    isBusy: error => error.message === 'Ya hay una generación en curso; espera a que termine.',
  } });
  return queue;
}

export function startCourseProduction(server) {
  if (process.env.COURSE_PRODUCTION_ENABLED === '0') return;
  const tick = () => getCourseQueue().tick().catch(error => { startupError = error.message; console.error('Cursos: '+error.message); });
  // Work is scheduled without delaying the editor's startup.
  void tick();
  const timer = setInterval(tick, 15000); timer.unref();
  server.once('close', () => clearInterval(timer));
}

export async function courseProductionRoute(req, res, url) {
  if (url.pathname !== '/api/course-production') return false;
  const local = /^(::1|::ffff:127\.|127\.)/.test(req.socket.remoteAddress || '') && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '');
  const status = !local ? 403 : req.method !== 'GET' ? 405 : 200;
  let body;
  try { body = status === 200 ? { ...getCourseQueue().snapshot(), startupError } : { error: 'Consulta local mediante GET requerida' }; }
  catch(error) { body = { error: error.message }; }
  res.writeHead(body.error && status===200 ? 503 : status, { 'content-type': 'application/json; charset=utf-8', 'cache-control':'no-store' });
  res.end(JSON.stringify(body)); return true;
}
