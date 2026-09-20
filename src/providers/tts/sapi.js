import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newId } from '../../lib/util.js';

/**
 * TTS con System.Speech (SAPI5) de Windows.
 * Coste 0, sin descargas: usa las voces ya instaladas en el sistema.
 * Para voces en espanol hay que instalar el paquete de idioma de Windows
 * (Configuracion > Hora e idioma > Voz), tambien gratuito.
 */

const isWin = process.platform === 'win32';

function runPowerShell(script, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Timeout de SAPI'));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`PowerShell fallo (${code}): ${stderr.slice(0, 500)}`));
      else resolve(stdout);
    });
  });
}

/** Literal de string PowerShell con comillas simples (escapando ' -> ''). */
function psLiteral(s) {
  return "'" + String(s).split("'").join("''") + "'";
}

export const id = 'sapi';
export const label = 'Windows SAPI (local, $0)';

export async function isAvailable() {
  if (!isWin) return false;
  try {
    const out = await runPowerShell(
      'Add-Type -AssemblyName System.Speech; ' +
      '(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices().Count',
      { timeoutMs: 20_000 },
    );
    return Number(out.trim()) > 0;
  } catch {
    return false;
  }
}

/** Lista de voces instaladas: [{ id, name, language, gender }] */
export async function listVoices() {
  if (!isWin) return [];
  try {
    const out = await runPowerShell(
      'Add-Type -AssemblyName System.Speech; ' +
      '(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ' +
      'ForEach-Object { $i = $_.VoiceInfo; "$($i.Name)|$($i.Culture.Name)|$($i.Gender)" }',
      { timeoutMs: 20_000 },
    );
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const [name, language, gender] = l.split('|');
      return { id: name, name, language, gender, provider: 'sapi' };
    });
  } catch {
    return [];
  }
}

/**
 * Sintetiza `text` a un WAV en `outFile`.
 * SAPI escribe WAV PCM; FFmpeg lo normaliza despues.
 */
export async function synthesize(text, outFile, { voice = '', rate = 0, volume = 100 } = {}) {
  if (!isWin) throw new Error('SAPI solo esta disponible en Windows');
  const clean = String(text || '').trim();
  if (!clean) throw new Error('Texto vacio para TTS');

  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  // El texto va por archivo temporal: evita limites de longitud y problemas de escape.
  const tmpTxt = path.join(os.tmpdir(), `avm_tts_${newId('t')}.txt`);
  fs.writeFileSync(tmpTxt, clean, 'utf8');

  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$ErrorActionPreference = "Stop"',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    voice ? `$s.SelectVoice(${psLiteral(voice)})` : '',
    `$s.Rate = ${Math.max(-10, Math.min(10, Math.round(Number(rate) || 0)))}`,
    `$s.Volume = ${Math.max(0, Math.min(100, Math.round(Number(volume) || 100)))}`,
    `$txt = [System.IO.File]::ReadAllText(${psLiteral(tmpTxt)}, [System.Text.Encoding]::UTF8)`,
    `$s.SetOutputToWaveFile(${psLiteral(outFile)})`,
    '$s.Speak($txt)',
    '$s.SetOutputToNull()',
    '$s.Dispose()',
  ].filter(Boolean).join('; ');

  try {
    await runPowerShell(script, { timeoutMs: 300_000 });
  } finally {
    try { fs.unlinkSync(tmpTxt); } catch { /* temporal ya borrado */ }
  }

  if (!fs.existsSync(outFile) || fs.statSync(outFile).size < 1024) {
    throw new Error('SAPI no genero audio audible');
  }
  return outFile;
}
