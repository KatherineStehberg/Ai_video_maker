import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ffmpegRun } from '../../lib/ffmpeg.js';

export const id = 'edge';
export const label = 'Edge TTS · voces en línea (requiere internet y Python edge-tts)';
export const supportsSegments = true;
const helper = fileURLToPath(new URL('./edge-helper.py', import.meta.url));

export function ejecutar(request, { timeoutMs = 120_000 } = {}) {
  const bin = process.env.EDGE_TTS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [helper], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('La voz en línea no respondió a tiempo.')); }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; if (stdout.length > 1_000_000) child.kill(); });
    child.stderr.on('data', () => {}); // Provider details are never exposed.
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new Error('No se encontró Python para Edge TTS.')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('Edge TTS no está disponible. Comprueba la instalación y la conexión.'));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Respuesta de Edge TTS inválida.')); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

let disponible;
export async function isAvailable() {
  if (!disponible || Date.now() - disponible.time > 60_000) {
    try { await ejecutar({ action: 'check' }, { timeoutMs: 10_000 });
      if (!(await listVoices()).length) throw new Error('No hay voces en línea.');
      disponible = { value: true, time: Date.now() }; }
    catch { disponible = { value: false, time: Date.now() }; }
  }
  return disponible.value;
}
let catalogo;
export async function listVoices() {
  if (catalogo && Date.now() - catalogo.time < 10 * 60_000) return catalogo.voices;
  const voices = await ejecutar({ action: 'voices' }, { timeoutMs: 8_000 });
  if (!Array.isArray(voices)) throw new Error('Catálogo de voces inválido.');
  // Chile first, then other Spanish variants, followed by English.
  voices.sort((a, b) => (a.language === 'es-CL' ? 0 : a.language.startsWith('es') ? 1 : 2)
    - (b.language === 'es-CL' ? 0 : b.language.startsWith('es') ? 1 : 2));
  catalogo = { voices, time: Date.now() };
  return voices;
}

export async function synthesize(text, outFile, { voice = '', rate = 0, volume = 100, segments = null, voices = {} } = {}) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('Texto vacío para narrar.');
  if (!voice) throw new Error('Elige una voz Edge TTS disponible.');
  const parts = segments?.length ? segments : [{ text: clean, lang: null }];
  const dir = path.dirname(outFile);
  fs.mkdirSync(dir, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(dir, '.edge-'));
  try {
    const files = [];
    for (let i = 0; i < parts.length; i++) {
      const mp3 = path.join(tempDir, `${i}.mp3`);
      const wav = path.join(tempDir, `${i}.wav`);
      await ejecutar({ action: 'synthesize', text: parts[i].text, voice: voices[parts[i].lang] || voice,
        rate: `${Math.max(-50, Math.min(100, Math.round(Number(rate) * 5) || 0)) >= 0 ? '+' : ''}${Math.max(-50, Math.min(100, Math.round(Number(rate) * 5) || 0))}%`,
        volume: `${Math.max(-100, Math.min(0, Math.round(Number(volume) || 0) - 100))}%`, output: mp3 });
      await ffmpegRun(['-i', mp3, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', wav]);
      files.push(wav);
    }
    const list = path.join(tempDir, 'concat.txt');
    fs.writeFileSync(list, files.map(f => `file '${f.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`).join('\n'));
    const partial = path.join(dir, `${randomUUID()}.partial.wav`);
    try {
      await ffmpegRun(['-f', 'concat', '-safe', '0', '-i', list, '-c:a', 'pcm_s16le', partial]);
      if (fs.statSync(partial).size < 1024) throw new Error('Edge TTS no generó audio.');
      fs.renameSync(partial, outFile);
    } finally { try { fs.unlinkSync(partial); } catch {} }
    return outFile;
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
}
