/**
 * Genera una biblioteca de musica de fondo SIN derechos de terceros.
 *
 * Todo se sintetiza aqui con FFmpeg a partir de tonos puros: no hay samples,
 * grabaciones ni obras de nadie. Por eso cada pista se publica como CC0.
 *
 * Es musica ambiental sencilla (acordes sostenidos con movimiento lento), no
 * produccion profesional: sirve de base discreta bajo una narracion. Para
 * musica mejor, anade archivos propios a data/assets/music/ con su ficha
 * <archivo>.json declarando licencia y fuente; sin ficha no se ofrecen.
 *
 * Uso:
 *   node scripts/generar-musica-local.mjs            # genera lo que falte
 *   node scripts/generar-musica-local.mjs --forzar   # regenera todo
 *   node scripts/generar-musica-local.mjs --dir <ruta>
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
  fuente: 'Generada localmente por AI Video Maker con FFmpeg a partir de tonos sintéticos (scripts/generar-musica-local.mjs). Sin samples ni obras de terceros.',
  autor: 'AI Video Maker (generación procedural)',
  atribucion: null,
  requiereAtribucion: false,
};

/** Frecuencias en Hz de cada nota usada. */
const N = { A2: 110, C3: 130.81, D3: 146.83, E3: 164.81, F3: 174.61, G3: 196, A3: 220, B3: 246.94, C4: 261.63, D4: 293.66, E4: 329.63, G4: 392, A4: 440 };

export const PISTAS = [
  {
    archivo: 'calma-luminosa.mp3', titulo: 'Calma luminosa', genero: 'Ambiental', ambiente: 'sereno',
    etiquetas: ['calma', 'meditación', 'espiritual', 'suave', 'fondo'],
    notas: [N.C3, N.G3, N.C4, N.E4], tremolo: 0.12, duracion: 120,
  },
  {
    archivo: 'contemplacion.mp3', titulo: 'Contemplación', genero: 'Ambiental', ambiente: 'introspectivo',
    etiquetas: ['reflexivo', 'espiritual', 'profundo', 'lento', 'naturaleza'],
    notas: [N.A2, N.E3, N.A3, N.C4], tremolo: 0.1, duracion: 150,
  },
  {
    archivo: 'amanecer.mp3', titulo: 'Amanecer', genero: 'Ambiental', ambiente: 'esperanzador',
    etiquetas: ['positivo', 'inicio', 'naturaleza', 'luz', 'educativo'],
    notas: [N.F3, N.C4, N.A3, N.G4], tremolo: 0.18, duracion: 90,
  },
  {
    archivo: 'pulso-sereno.mp3', titulo: 'Pulso sereno', genero: 'Ambiental rítmico', ambiente: 'enfocado',
    etiquetas: ['curso', 'explicación', 'concentración', 'corporativo', 'suave'],
    notas: [N.D3, N.A3, N.D4, N.E4], tremolo: 1.2, duracion: 60,
  },
];

/**
 * Receta de FFmpeg: cuatro tonos -> mezcla -> modulacion lenta de volumen ->
 * eco largo (da sensacion de espacio) -> filtro de graves y agudos -> fundidos.
 */
function argumentos(p, destino) {
  const entradas = p.notas.flatMap(f => ['-f', 'lavfi', '-i', `sine=frequency=${f}:duration=${p.duracion}:sample_rate=44100`]);
  const n = p.notas.length;
  const cadena = [
    `amix=inputs=${n}:normalize=0`,
    `tremolo=f=${p.tremolo}:d=0.45`,
    'aecho=0.8:0.7:900|1700:0.35|0.25',
    'lowpass=f=2200', 'highpass=f=60',
    `afade=t=in:st=0:d=4`, `afade=t=out:st=${p.duracion - 5}:d=5`,
    // Cuatro tonos a 1/8 de amplitud: se sube para quedar en torno a -16 dB de
    // media, nivel de musica de fondo, con margen antes de saturar.
    'volume=4',
    'aformat=channel_layouts=stereo',
  ].join(',');
  return [...entradas, '-filter_complex', `${p.notas.map((_, i) => `[${i}:a]`).join('')}${cadena}[a]`,
    '-map', '[a]', '-t', String(p.duracion), '-ar', '44100', '-b:a', '160k', destino];
}

export async function generarBiblioteca({ dir = PATHS.assetsMusic, forzar = false } = {}) {
  ensureDir(dir);
  const hechas = [];
  for (const p of PISTAS) {
    const destino = path.join(dir, p.archivo);
    const ficha = `${destino}.json`;
    if (!forzar && fs.existsSync(destino) && fs.existsSync(ficha)) { hechas.push({ archivo: p.archivo, nueva: false }); continue; }
    await ffmpegRun(argumentos(p, destino));
    fs.writeFileSync(ficha, JSON.stringify({
      titulo: p.titulo, genero: p.genero, ambiente: p.ambiente, etiquetas: p.etiquetas,
      ...LICENCIA, generadaEn: new Date().toISOString(),
    }, null, 2), 'utf8');
    hechas.push({ archivo: p.archivo, nueva: true });
  }
  return hechas;
}

const esPrincipal = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (esPrincipal) {
  const i = process.argv.indexOf('--dir');
  const dir = i > -1 ? path.resolve(process.argv[i + 1]) : PATHS.assetsMusic;
  const r = await generarBiblioteca({ dir, forzar: process.argv.includes('--forzar') });
  for (const x of r) console.log(`  ${x.nueva ? 'generada ' : 'ya estaba'}  ${x.archivo}`);
  console.log(`Biblioteca en ${dir}`);
}
