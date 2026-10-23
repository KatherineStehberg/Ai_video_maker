/**
 * FORMA DE ONDA REAL
 *
 * No se dibuja una onda decorativa: se leen las muestras del archivo de audio.
 *
 * FFmpeg decodifica a PCM mono de 16 bits a baja frecuencia y aqui se reduce a
 * N picos (el maximo absoluto de cada tramo). A 4 kHz, media hora de narracion
 * son 7,2 M de muestras: se leen en streaming, sin cargar el WAV entero en
 * memoria, y salen ~800 numeros para el navegador.
 *
 * Si el archivo no se puede decodificar se devuelve `disponible: false` y la
 * interfaz dibuja un bloque liso. NUNCA se rellena con ruido inventado: una
 * onda falsa da una sensacion de precision que no existe.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { resolveFfmpeg } from '../lib/ffmpeg.js';
import { logger } from '../lib/logger.js';

const log = logger('waveform');

/** Frecuencia de analisis. Basta para la envolvente; no es para escuchar. */
const HZ = 4000;

export const MUESTRAS_POR_DEFECTO = 800;
const MUESTRAS_MAX = 4000;

/**
 * @returns {Promise<{pista?:string, disponible:boolean, picos:number[], segundos:number|null, motivo?:string}>}
 *   `picos` son valores 0..1, uno por tramo, en orden.
 */
export async function peaks(file, { muestras = MUESTRAS_POR_DEFECTO } = {}) {
  const n = Math.min(MUESTRAS_MAX, Math.max(20, Math.round(Number(muestras) || MUESTRAS_POR_DEFECTO)));
  if (!file || !fs.existsSync(file)) {
    return { disponible: false, motivo: 'El archivo de audio no existe.', picos: [], segundos: null };
  }
  const { ffmpeg } = await resolveFfmpeg();
  if (!ffmpeg) return { disponible: false, motivo: 'FFmpeg no está disponible.', picos: [], segundos: null };

  return new Promise((resolve) => {
    const hijo = spawn(ffmpeg, [
      '-hide_banner', '-nostdin', '-v', 'error',
      '-i', file,
      '-ac', '1', '-ar', String(HZ),
      '-f', 's16le', '-',
    ], { windowsHide: true });

    // Acumulador de maximos. Se dimensiona al vuelo: no se sabe cuantas
    // muestras tiene el archivo hasta haberlo leido entero.
    const maximos = [];
    let total = 0;
    let sobra = null;   // byte suelto entre chunks: una muestra son 2 bytes
    let fallo = null;

    hijo.on('error', e => { fallo = e.message; });
    hijo.stderr.on('data', d => { fallo = fallo || d.toString().trim(); });

    hijo.stdout.on('data', (chunk) => {
      let buf = chunk;
      if (sobra) { buf = Buffer.concat([sobra, chunk]); sobra = null; }
      const pares = Math.floor(buf.length / 2);
      if (buf.length % 2) sobra = buf.subarray(pares * 2);

      for (let i = 0; i < pares; i++) {
        const v = Math.abs(buf.readInt16LE(i * 2)) / 32768;
        maximos.push(v);
        total++;
      }
    });

    hijo.on('close', (code) => {
      if (code !== 0 && !total) {
        log.warn('No se pudo leer el audio:', fallo || `code ${code}`);
        return resolve({ disponible: false, motivo: 'No se pudo decodificar el audio.', picos: [], segundos: null });
      }
      if (!total) {
        return resolve({ disponible: false, motivo: 'El audio está vacío.', picos: [], segundos: 0 });
      }

      // Reduccion a N tramos, quedandose con el pico de cada uno: es lo que
      // hace que un golpe corto siga viendose y no se promedie hasta borrarse.
      const porTramo = total / n;
      const picos = new Array(n).fill(0);
      for (let i = 0; i < total; i++) {
        const tramo = Math.min(n - 1, Math.floor(i / porTramo));
        if (maximos[i] > picos[tramo]) picos[tramo] = maximos[i];
      }

      // Normalizacion suave: una narracion grabada baja rara vez llega a 1, y
      // sin esto la onda se ve plana. Se declara el factor aplicado.
      const pico = Math.max(...picos);
      const factor = pico > 0.02 ? 1 / pico : 1;
      const normalizados = picos.map(v => Number(Math.min(1, v * factor).toFixed(3)));

      resolve({
        disponible: true,
        picos: normalizados,
        segundos: Number((total / HZ).toFixed(2)),
        muestras: n,
        normalizado: factor !== 1,
        factor: Number(factor.toFixed(3)),
        frecuenciaAnalisis: HZ,
      });
    });
  });
}
