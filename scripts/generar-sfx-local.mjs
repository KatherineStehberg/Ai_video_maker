/**
 * Genera una biblioteca de EFECTOS DE SONIDO sin derechos de terceros.
 *
 * Igual que la musica local: todo se sintetiza aqui con FFmpeg a partir de
 * tonos puros y ruido generado, no hay samples ni grabaciones de nadie. Por eso
 * cada efecto se publica como CC0.
 *
 * Son efectos sobrios, pensados para acompanar una transicion o marcar un punto
 * del guion, no una libreria de cine. Para otros, anade archivos propios a
 * data/assets/sfx/ con su ficha <archivo>.json declarando licencia y fuente;
 * sin ficha NO se ofrecen.
 *
 * Uso:
 *   node scripts/generar-sfx-local.mjs            # genera lo que falte
 *   node scripts/generar-sfx-local.mjs --forzar   # regenera todo
 *   node scripts/generar-sfx-local.mjs --dir <ruta>
 *
 * data/assets/ esta en .gitignore: estos archivos no se suben al repositorio,
 * se regeneran con este script.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ffmpegRun } from '../src/lib/ffmpeg.js';
import { PATHS, ensureDir } from '../src/lib/paths.js';

const LICENCIA = {
  licencia: 'CC0 1.0 (dominio público)',
  licenciaUrl: 'https://creativecommons.org/publicdomain/zero/1.0/deed.es',
  fuente: 'Generado localmente por AI Video Maker con FFmpeg a partir de tonos y ruido sintéticos (scripts/generar-sfx-local.mjs). Sin samples ni obras de terceros.',
  autor: 'AI Video Maker (generación procedural)',
  atribucion: null,
  requiereAtribucion: false,
};

/**
 * Cada efecto declara su cadena de filtros sobre una o varias fuentes
 * sintetizadas. `fuentes` son entradas de lavfi; `cadena` el filtro que las
 * convierte en el sonido. Nada viene de un archivo.
 */
export const EFECTOS = [
  {
    archivo: 'transicion-suave.wav', titulo: 'Transición suave', categoria: 'transicion',
    etiquetas: ['transición', 'suave', 'aire', 'pase'], duracion: 1.2, volumenSugerido: 0.5,
    fuentes: ['anoisesrc=color=pink:amplitude=0.6:duration=1.2'],
    cadena: [
      // Ruido rosa filtrado en banda que sube: el «aire» de un pase de escena.
      'highpass=f=300', 'lowpass=f=4000',
      "volume='min(1,t/0.5)*max(0,1-(t-0.5)/0.7)':eval=frame",
      'afade=t=in:st=0:d=0.08', 'afade=t=out:st=0.9:d=0.3', 'volume=2.2',
    ],
  },
  {
    archivo: 'campanilla.wav', titulo: 'Campanilla', categoria: 'interfaz',
    etiquetas: ['campana', 'aviso', 'positivo', 'idea'], duracion: 1.6, volumenSugerido: 0.45,
    // Fundamental + dos parciales: lo que distingue una campana de un pitido.
    fuentes: ['sine=frequency=1568:duration=1.6', 'sine=frequency=2349:duration=1.6', 'sine=frequency=3136:duration=1.6'],
    cadena: ['aecho=0.8:0.6:55|110:0.3|0.15', "volume='exp(-3.2*t)':eval=frame", 'afade=t=out:st=1.35:d=0.25', 'volume=2.4'],
  },
  {
    archivo: 'golpe-suave.wav', titulo: 'Golpe suave', categoria: 'impacto',
    etiquetas: ['impacto', 'énfasis', 'grave', 'acento'], duracion: 0.9, volumenSugerido: 0.55,
    fuentes: ['sine=frequency=70:duration=0.9', 'anoisesrc=color=brown:amplitude=0.4:duration=0.9'],
    cadena: ['lowpass=f=260', "volume='exp(-7*t)':eval=frame", 'afade=t=out:st=0.7:d=0.2', 'volume=2.2'],
  },
  {
    archivo: 'ambiente-luminoso.wav', titulo: 'Ambiente luminoso', categoria: 'ambiente',
    etiquetas: ['ambiente', 'luz', 'fondo', 'apertura'], duracion: 3, volumenSugerido: 0.35,
    fuentes: ['sine=frequency=523.25:duration=3', 'sine=frequency=783.99:duration=3', 'sine=frequency=1046.5:duration=3'],
    cadena: ['tremolo=f=0.6:d=0.3', 'aecho=0.8:0.7:420|830:0.3|0.2', 'lowpass=f=3000',
      'afade=t=in:st=0:d=0.9', 'afade=t=out:st=1.9:d=1.1', 'volume=1.6'],
  },
  {
    archivo: 'whoosh.wav', titulo: 'Whoosh', categoria: 'transicion',
    etiquetas: ['whoosh', 'barrido', 'movimiento', 'transición'], duracion: 0.8, volumenSugerido: 0.5,
    // El movimiento lo da un BARRIDO DE FRECUENCIA. `highpass` no acepta una
    // frecuencia que cambie con el tiempo, asi que el barrido se sintetiza
    // aparte como un tono ascendente (chirp) y se suma al ruido: sin el, el
    // ruido blanco suena a estatica, no a whoosh.
    fuentes: [
      'anoisesrc=color=pink:amplitude=0.7:duration=0.8',
      'aevalsrc=0.35*sin(2*PI*(300*t+3000*t*t)):d=0.8:s=48000',
    ],
    cadena: [
      'highpass=f=200', 'lowpass=f=6000',
      "volume='min(1,t/0.15)*max(0,1-(t-0.15)/0.6)':eval=frame",
      'afade=t=out:st=0.6:d=0.2', 'volume=1.4',
    ],
  },
  {
    archivo: 'click.wav', titulo: 'Click', categoria: 'interfaz',
    etiquetas: ['click', 'marca', 'punto', 'seco'], duracion: 0.18, volumenSugerido: 0.4,
    fuentes: ['sine=frequency=2200:duration=0.18', 'anoisesrc=color=white:amplitude=0.5:duration=0.18'],
    cadena: ['highpass=f=900', "volume='exp(-38*t)':eval=frame", 'volume=1.6'],
  },
];

function argumentos(e, destino) {
  const entradas = e.fuentes.flatMap(f => ['-f', 'lavfi', '-i', f]);
  const mezcla = e.fuentes.length > 1 ? [`amix=inputs=${e.fuentes.length}:normalize=0`] : ['anull'];
  const cadena = [...mezcla, ...e.cadena, 'aformat=channel_layouts=stereo'].join(',');
  return [
    ...entradas,
    '-filter_complex', `${e.fuentes.map((_, i) => `[${i}:a]`).join('')}${cadena}[a]`,
    '-map', '[a]', '-t', String(e.duracion),
    // WAV a 48 kHz: son sonidos cortos, no compensa comprimirlos y asi se
    // mezclan sin recodificar en el render.
    '-ar', '48000', '-c:a', 'pcm_s16le',
    destino,
  ];
}

export async function generarEfectos({ dir = PATHS.assetsSfx, forzar = false } = {}) {
  ensureDir(dir);
  const hechos = [];
  for (const e of EFECTOS) {
    const destino = path.join(dir, e.archivo);
    const ficha = `${destino}.json`;
    if (!forzar && fs.existsSync(destino) && fs.existsSync(ficha)) { hechos.push({ archivo: e.archivo, nuevo: false }); continue; }
    await ffmpegRun(argumentos(e, destino));
    fs.writeFileSync(ficha, JSON.stringify({
      titulo: e.titulo, categoria: e.categoria, etiquetas: e.etiquetas,
      volumenSugerido: e.volumenSugerido,
      ...LICENCIA,
      incorporado: new Date().toISOString().slice(0, 10),
      generadoEn: new Date().toISOString(),
    }, null, 2), 'utf8');
    hechos.push({ archivo: e.archivo, nuevo: true });
  }
  return hechos;
}

const esPrincipal = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (esPrincipal) {
  const i = process.argv.indexOf('--dir');
  const dir = i > -1 ? path.resolve(process.argv[i + 1]) : PATHS.assetsSfx;
  const r = await generarEfectos({ dir, forzar: process.argv.includes('--forzar') });
  for (const x of r) console.log(`  ${x.nuevo ? 'generado ' : 'ya estaba'}  ${x.archivo}`);
  console.log(`Biblioteca de efectos en ${dir}`);
}
