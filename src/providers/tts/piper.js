import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CONFIG } from '../../config.js';

/**
 * Piper TTS (open source, MIT, corre en CPU).
 * NO se descarga nada automaticamente: el usuario instala piper.exe y baja
 * un modelo de voz (~60 MB) manualmente, y apunta PIPER_PATH / PIPER_MODEL en .env.
 * Es la mejor opcion para voces en espanol de calidad a costo $0.
 */

export const id = 'piper';
export const label = 'Piper TTS (local, $0, requiere instalacion manual)';

export async function isAvailable() {
  const bin = CONFIG.tts.piperPath;
  const model = CONFIG.tts.piperModel;
  return Boolean(bin && model && fs.existsSync(bin) && fs.existsSync(model));
}

export async function listVoices() {
  if (!(await isAvailable())) return [];
  const model = CONFIG.tts.piperModel;
  return [{
    id: path.basename(model, '.onnx'),
    name: path.basename(model, '.onnx'),
    language: path.basename(model).split('-')[0] || 'es',
    gender: 'unknown',
    provider: 'piper',
  }];
}

export async function synthesize(text, outFile, { rate = 0 } = {}) {
  if (!(await isAvailable())) {
    throw new Error('Piper no configurado. Define PIPER_PATH y PIPER_MODEL en .env');
  }
  const clean = String(text || '').trim();
  if (!clean) throw new Error('Texto vacio para TTS');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  // rate 0 => 1.0. Piper usa length_scale: mayor = mas lento.
  const lengthScale = Math.max(0.5, Math.min(2, 1 - Number(rate || 0) * 0.05));

  const args = [
    '--model', CONFIG.tts.piperModel,
    '--output_file', outFile,
    '--length_scale', String(lengthScale),
  ];

  await new Promise((resolve, reject) => {
    const child = spawn(CONFIG.tts.piperPath, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Piper fallo (${code}): ${stderr.slice(-400)}`));
    });
    child.stdin.write(clean);
    child.stdin.end();
  });

  if (!fs.existsSync(outFile) || fs.statSync(outFile).size < 1024) {
    throw new Error('Piper no genero audio');
  }
  return outFile;
}
