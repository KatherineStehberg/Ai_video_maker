import os from 'node:os';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PATHS } from './paths.js';

const exec = promisify(execFile);

/**
 * Inspeccion de hardware. Sirve para DECIDIR que se puede ejecutar localmente
 * antes de intentarlo: en una maquina sin GPU no tiene sentido ofrecer
 * generacion de imagen local.
 */

async function windowsGpu() {
  try {
    const { stdout } = await exec(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_VideoController | ForEach-Object { "$($_.Name)|$($_.AdapterRAM)" }'],
      { timeout: 15_000, windowsHide: true },
    );
    return stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const [name, ram] = l.split('|');
      return { name, vramMB: Number(ram) > 0 ? Math.round(Number(ram) / 1048576) : null };
    });
  } catch {
    return [];
  }
}

async function freeDiskGB(dir) {
  try {
    const st = await fs.promises.statfs(dir);
    return Number(((st.bsize * st.bavail) / 1e9).toFixed(1));
  } catch {
    return null;
  }
}

function classifyGpu(gpus) {
  const names = gpus.map((g) => g.name?.toLowerCase() || '').join(' ');
  if (/nvidia|geforce|rtx|gtx|quadro|tesla/.test(names)) return 'nvidia';
  if (/radeon|amd/.test(names)) return 'amd';
  if (/intel/.test(names)) return 'intel-integrated';
  return 'unknown';
}

export async function hardwareReport() {
  const cpus = os.cpus();
  const totalGB = Number((os.totalmem() / 1e9).toFixed(2));
  const freeGB = Number((os.freemem() / 1e9).toFixed(2));
  const gpus = process.platform === 'win32' ? await windowsGpu() : [];
  const gpuClass = classifyGpu(gpus);
  const cores = cpus.length;

  // Reglas explicitas: que se puede hacer local y que no.
  const capabilities = {
    ffmpegRender: true,
    localTTS: true,
    // Whisper base pide ~1 GB de RAM libre y varios nucleos para ser usable.
    localSTT: cores >= 4 && totalGB >= 8,
    // Stable Diffusion necesita GPU dedicada con >=4 GB de VRAM.
    localImageGen: gpuClass === 'nvidia' && (gpus[0]?.vramMB ?? 0) >= 4000,
    // Un LLM 3B cuantizado necesita ~4 GB libres; 7B necesita ~8 GB.
    localLLM3B: totalGB >= 8 && cores >= 4,
    localLLM7B: totalGB >= 16,
    localVideoGen: false, // ninguna maquina de escritorio comun lo sostiene a costo cero
  };

  const notes = [];
  if (!capabilities.localImageGen) {
    notes.push('Sin GPU dedicada: la generacion local de imagenes no es viable. Usa imagenes propias, bancos libres o fondos generados con FFmpeg.');
  }
  if (cores <= 4) {
    notes.push(`Solo ${cores} hilos de CPU: usa el perfil de render "fast" y videos cortos (<90s).`);
  }
  if (totalGB < 8) {
    notes.push('Menos de 8 GB de RAM: evita resoluciones sobre 1080p.');
  }
  if (!capabilities.localLLM3B) {
    notes.push('Hardware justo para un LLM local: usa guion manual o una API con free tier.');
  }

  return {
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    node: process.version,
    cpu: { model: cpus[0]?.model?.trim() || 'desconocido', threads: cores, speedMHz: cpus[0]?.speed || null },
    memory: { totalGB, freeGB },
    gpu: { devices: gpus, class: gpuClass, dedicated: gpuClass === 'nvidia' || gpuClass === 'amd' },
    disk: { freeGB: await freeDiskGB(PATHS.root) },
    capabilities,
    notes,
    recommendedProfile: cores <= 4 ? 'fast' : totalGB >= 16 ? 'quality' : 'balanced',
  };
}
