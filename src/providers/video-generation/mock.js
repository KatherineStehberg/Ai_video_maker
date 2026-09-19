import path from 'node:path';
import { createHash } from 'node:crypto';
import { ffmpegRun } from '../../lib/ffmpeg.js';

/**
 * PROVEEDOR MOCK — NO es generación con IA.
 *
 * Construye localmente con FFmpeg un video sintético a partir del prompt: unos
 * planos de color y una pista de clics a un tempo fijo. Sirve para ejercitar el
 * flujo completo (generar → analizar → proponer → aprobar → exportar) sin gastar
 * créditos ni contactar ningún servicio.
 *
 * El resultado NO representa el contenido del prompt. Sólo lo usa como semilla
 * determinista: el mismo prompt produce siempre el mismo video, lo que hace que
 * las pruebas sean reproducibles. Todo lo que devuelve va marcado `mock: true`
 * para que la interfaz y el JSON no puedan confundirlo con material real.
 */

/** Paletas por estilo. Sólo afectan al color del mock; no hay semántica real. */
const PALETAS = {
  'cinematográfico': ['0x1a1a2e', '0x16213e', '0x0f3460', '0x533483'],
  documental: ['0x2d3142', '0x4f5d75', '0xbfc0c0', '0x5d737e'],
  dinámico: ['0xff6b35', '0x004e89', '0x1a659e', '0xf7c59f'],
  minimalista: ['0xf8f9fa', '0xdee2e6', '0xadb5bd', '0x6c757d'],
  corporativo: ['0x003366', '0x0066ff', '0x1b4f86', '0x5b6b7f'],
};

/** Resolución de trabajo del mock. La exportación final reescala a 1080p. */
const RESOLUCIONES = { '9:16': [540, 960], '16:9': [960, 540], '1:1': [720, 720] };

const mezcla = (canal, destino, t) => Math.round(canal + (destino - canal) * t);

/**
 * Deriva el color de un plano alternando luminancia entre planos consecutivos.
 *
 * Sin esto el mock es inútil como material de prueba: varias paletas son
 * monocromas (la corporativa son todos azules) y el detector de escenas de
 * FFmpeg, con umbral 0.3, no ve ningún corte entre ellas. Alternar claro/oscuro
 * garantiza un salto de luminancia grande y, por tanto, cortes detectables.
 */
function colorDePlano(base, indice) {
  const n = parseInt(String(base).replace(/^0x/, ''), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const [destino, t] = indice % 2 === 0 ? [0, 0.45] : [255, 0.75];
  const hex = [mezcla(r, destino, t), mezcla(g, destino, t), mezcla(b, destino, t)]
    .map(c => c.toString(16).padStart(2, '0')).join('');
  return `0x${hex}`;
}

export const mockProvider = {
  id: 'mock',
  label: 'Mock local (FFmpeg) — video de prueba, sin IA',
  mock: true,
  configured: () => true,
  requires: [],

  /**
   * @param {object} spec  { prompt, duration, format, style, ... }
   * @param {object} opts  { workDir, onProgress }
   * @returns {Promise<{file:string, provider:string, mock:boolean, notes:string[]}>}
   */
  async generate(spec, { workDir, onProgress = () => {} } = {}) {
    const semilla = createHash('sha256').update(String(spec.prompt)).digest();
    const paleta = PALETAS[spec.style] || PALETAS.corporativo;
    const [ancho, alto] = RESOLUCIONES[spec.format] || RESOLUCIONES['9:16'];

    // Número de planos y tempo, derivados del prompt de forma determinista.
    const planos = Math.min(8, Math.max(2, Math.round(spec.duration / 2.5)));
    const bpm = 90 + (semilla[0] % 41);            // 90–130 BPM
    const periodo = 60 / bpm;

    // Duraciones ligeramente irregulares: así los cortes NO caen sobre la
    // rejilla y el análisis tiene rampas reales que proponer.
    const pesos = Array.from({ length: planos }, (_, i) => 1 + ((semilla[i + 1] % 7) - 3) * 0.08);
    const total = pesos.reduce((a, b) => a + b, 0);
    const duraciones = pesos.map(p => Math.max(0.5, (p / total) * spec.duration));

    onProgress(10, `Preparando ${planos} planos a ${bpm} BPM`);

    const entradas = [], etiquetas = [];
    duraciones.forEach((d, i) => {
      const color = colorDePlano(paleta[(semilla[i + 9] + i) % paleta.length], i);
      entradas.push('-f', 'lavfi', '-i', `color=c=${color}:s=${ancho}x${alto}:r=30:d=${d.toFixed(3)}`);
      etiquetas.push(`[${i}:v]`);
    });
    // Pista de clics: da beats detectables al análisis local.
    entradas.push('-f', 'lavfi', '-i',
      `aevalsrc=if(lt(mod(t\\,${periodo.toFixed(4)})\\,0.03)\\,0.7*sin(2*PI*880*t)\\,0):s=16000:d=${spec.duration}`);

    const salida = path.join(workDir, 'generated.mp4');
    onProgress(45, 'Renderizando el video de prueba');
    await ffmpegRun([
      ...entradas,
      '-filter_complex', `${etiquetas.join('')}concat=n=${planos}:v=1:a=0[v]`,
      '-map', '[v]', '-map', `${planos}:a`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-threads', '1',
      '-c:a', 'aac', '-shortest', '-movflags', '+faststart', salida,
    ]);
    onProgress(90, 'Video de prueba listo');

    return {
      file: salida,
      provider: 'mock',
      mock: true,
      model: 'ffmpeg-lavfi',
      spec: { planos, bpm, resolucion: `${ancho}x${alto}` },
      // El aviso de «esto es un mock» lo añade jobs.js una sola vez; aquí sólo
      // van los detalles concretos, para no repetir lo mismo en la interfaz.
      notes: [
        `El prompt sólo se usa como semilla: ${planos} planos de color y clics a ${bpm} BPM.`,
        'No se gastaron créditos ni se envió nada a ningún servicio externo.',
      ],
    };
  },
};
