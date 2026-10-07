import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PATHS, abs, rel, ensureDir } from '../../lib/paths.js';
import { resolveFfmpeg, run } from '../../lib/ffmpeg.js';

const helper = fileURLToPath(new URL('./wan-helper.py', import.meta.url));
const MAX_BYTES = 150 * 1024 * 1024;
const bounded = (v, fallback, min, max) => Number.isFinite(Number(v)) && v !== '' && v !== undefined
  ? Math.max(min, Math.min(max, Math.floor(Number(v)))) : fallback;

/** Environment only: browser requests cannot choose a binary, Space or token. */
export function wanConfig() {
  const backend = process.env.WAN_BACKEND || 'local';
  const enabled = process.env.WAN_ENABLED === '1';
  const local = backend === 'local' && Boolean(process.env.WAN_REPO_DIR && process.env.WAN_MODEL_DIR) && fs.existsSync(path.join(process.env.WAN_REPO_DIR || '', 'generate.py'))
    && fs.existsSync(path.join(process.env.WAN_MODEL_DIR || '', 'config.json'));
  const space = backend === 'space' && /^[\w.-]+\/[\w.-]+$/.test(process.env.WAN_SPACE_ID || '')
    && /^\/[\w/-]+$/.test(process.env.WAN_SPACE_API_NAME || '')
    && Boolean(process.env.WAN_SPACE_ARGS);
  return {
    enabled, configured: Boolean(enabled && (local || space)), backend,
    model: backend === 'space' ? 'Wan (Space configurado)' : 'Wan2.2-TI2V-5B', verified: false,
    maxScenes: bounded(process.env.WAN_MAX_SCENES, 8, 1, 100),
    clipSeconds: bounded(process.env.WAN_CLIP_SECONDS, 5, 1, 5),
    notice: backend === 'space'
      ? 'Space externo: envía prompt e imagen. Tiene cuota y colas; el conector no compra créditos ni garantiza gratuidad.'
      : 'Wan local: sin tarifa por llamada. Requiere modelo instalado y GPU NVIDIA compatible; la configuración oficial usa 24 GB de VRAM.',
  };
}

export function executeWan(request, { timeoutMs = 30 * 60_000 } = {}) {
  const bin = process.env.WAN_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [helper], { windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', settled = false;
    const stop = () => {
      if (process.platform === 'win32') {
        if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
      } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const finish = (err, result) => { if (settled) return; settled = true; clearTimeout(timer); err ? reject(err) : resolve(result); };
    const timer = setTimeout(() => { stop(); finish(new Error('Wan excedió el tiempo límite. No se reintentó la generación.')); }, timeoutMs);
    child.stdout.on('data', d => { output += d; if (output.length > 100_000) { stop(); finish(new Error('Respuesta de Wan demasiado grande.')); } });
    child.stderr.on('data', () => {}); // Never disclose provider errors, local paths or HF_TOKEN.
    child.stdin.on('error', () => {});
    child.on('error', () => finish(new Error('No se encontró el intérprete Python de Wan. Configura WAN_PYTHON.')));
    child.on('close', code => {
      if (code !== 0) return finish(new Error('Wan no pudo completar la operación. Comprueba GPU, instalación o cuota del Space; no se reintentó.'));
      try {
        const result = JSON.parse(output);
        if (result.error) return finish(new Error(result.error));
        finish(null, result);
      } catch { finish(new Error('Respuesta de Wan inválida.')); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

/** Checks dependencies/GPU or the Space API without generating or duplicating a Space. */
export async function checkWan({ execute = executeWan } = {}) {
  const config = wanConfig();
  if (!config.configured) return { ...config, available: false, reason: 'Configura y habilita Wan en el servidor. Consulta README.' };
  try {
    const result = await execute({ action: 'check' }, { timeoutMs: 30_000 });
    return { ...config, verified: true, available: result.available === true,
      reason: result.available ? 'Conexión comprobada; todavía no verifica calidad ni cuota suficiente para generar.' : 'Motor no disponible. Revisa GPU o API del Space.' };
  } catch (e) { return { ...config, verified: true, available: false, reason: e.message }; }
}

function safeImage(p) {
  if (!p) return null;
  const file = abs(p), stat = fs.statSync(file);
  const allowed = [PATHS.data, PATHS.output].some(base => {
    if (!fs.existsSync(base)) return false;
    const relative = path.relative(fs.realpathSync(base), fs.realpathSync(file));
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
  if (!allowed || !stat.isFile() || !/\.(png|jpe?g|webp)$/i.test(file) || stat.size > 20 * 1024 * 1024) throw new Error('Imagen de referencia de Wan inválida.');
  return file;
}

export async function validateWanVideo(file) {
  const { ffprobe } = await resolveFfmpeg();
  if (!ffprobe) throw new Error('Se necesita ffprobe para verificar el clip de Wan.');
  const r = await run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error('Wan devolvió un video inválido.');
  const info = JSON.parse(r.stdout), video = info.streams?.find(s => s.codec_type === 'video');
  const duration = Number(info.format?.duration);
  if (!video || !Number.isFinite(duration) || duration <= 0 || duration > 30 || !video.width || !video.height) throw new Error('Wan no produjo un clip de video válido de hasta 30 segundos.');
  return { duration, width: video.width, height: video.height };
}

let busy = false;
/** A clip provider, not a whole-video renderer. Existing pipeline adds narration/captions. */
export async function generateWanClip({ prompt, referencePath = null, aspect = '9:16', force = false, variant = 0 }, { execute = executeWan } = {}) {
  const config = wanConfig();
  if (!config.configured) throw new Error('Wan no está configurado. Habilita el motor local o un Space compatible; no se sustituirá por una imagen.');
  if (!['9:16', '16:9', '1:1'].includes(aspect)) throw new Error('Formato de Wan inválido.');
  prompt = String(prompt || '').trim();
  if (!prompt || prompt.length > 4000) throw new Error('Describe el movimiento de la escena en un prompt de hasta 4000 caracteres.');
  const image = safeImage(referencePath);
  const settings = [config.backend, config.clipSeconds, aspect, process.env.WAN_MODEL_DIR || '', process.env.WAN_SPACE_ID || '',
    process.env.WAN_SPACE_API_NAME || '', process.env.WAN_SPACE_ARGS || '', prompt, variant];
  const hash = createHash('sha256').update(JSON.stringify(settings));
  if (image) hash.update(fs.readFileSync(image));
  const key = hash.digest('hex');
  const dir = ensureDir(path.join(PATHS.assetsImages, '_library', 'wan'));
  const target = path.join(dir, `${key}.mp4`), metadata = `${target}.json`;
  if (!force && fs.existsSync(target) && fs.existsSync(metadata)) {
    await validateWanVideo(target);
    const credit = JSON.parse(fs.readFileSync(metadata, 'utf8'));
    return { path: rel(target), provider: 'wan', credit, cache: true };
  }
  if (busy) throw new Error('Wan está generando otro clip. Espera a que termine antes de iniciar otra generación.');
  busy = true;
  const temp = fs.mkdtempSync(path.join(dir, '.pending-'));
  try {
    const output = path.join(temp, 'clip.mp4');
    await execute({ action: 'generate', prompt, image, aspect, seconds: config.clipSeconds, seed: parseInt(key.slice(0, 8), 16), output });
    if (!fs.existsSync(output) || fs.statSync(output).size > MAX_BYTES || fs.statSync(output).size === 0) throw new Error('Wan no produjo un archivo de video dentro del tamaño permitido.');
    const measured = await validateWanVideo(output);
    const credit = { kind: 'video', proveedor: 'wan', generated: true, model: config.model, backend: config.backend,
      prompt, referencePath: image ? rel(image) : null, generatedAt: new Date().toISOString(), ...measured,
      licencia: config.backend === 'local' ? 'Modelo Apache 2.0; revisa derechos de la imagen de referencia.' : 'Condiciones del modelo y del Space seleccionado.',
      licenciaUrl: 'https://github.com/Wan-Video/Wan2.2/blob/main/LICENSE.txt',
      note: 'Clip corto: el montaje puede repetirlo para cubrir la narración. 1:1 se recorta en el render.' };
    fs.renameSync(output, target);
    fs.writeFileSync(metadata, JSON.stringify(credit, null, 2));
    return { path: rel(target), provider: 'wan', credit, cache: false };
  } finally { busy = false; fs.rmSync(temp, { recursive: true, force: true }); }
}
