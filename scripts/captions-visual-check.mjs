/**
 * MEDICION VISUAL DE LOS SUBTITULOS QUEMADOS
 *
 * No comprueba la configuracion: mide los PIXELES que libass dibuja.
 *
 * Por que sobre fondo negro y no sobre el video: el umbral de blanco no sabe
 * distinguir una letra de un cielo despejado, asi que medir sobre la imagen
 * final da cajas gigantes que en realidad son la foto. Aqui se quema el MISMO
 * .ass, con el MISMO libass y el mismo PlayRes, sobre un fondo negro. La
 * geometria resultante (tamano de letra, margenes, ancho, numero de lineas) es
 * identica a la del video entregado, y ya es medible sin ambiguedad.
 *
 * Uso:
 *   node scripts/captions-visual-check.mjs <archivo.ass> [segundo, segundo, ...]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../src/lib/paths.js';
import { resolveFfmpeg, escapeFilterPath } from '../src/lib/ffmpeg.js';
import { captionMetrics } from '../src/core/captions-style.js';

/** Ejecuta ffmpeg y devuelve stderr, que es donde `bbox` imprime. */
function correr(bin, args) {
  return new Promise((resolve, reject) => {
    const hijo = spawn(bin, ['-hide_banner', '-nostdin', ...args], { windowsHide: true });
    let err = '';
    hijo.stderr.on('data', d => { err += d.toString(); });
    hijo.on('error', reject);
    hijo.on('close', () => resolve(err));
  });
}

/**
 * Lo que el propio .ass DECLARA: resolucion, cuerpo de letra y margen.
 *
 * Se lee del archivo y no de la configuracion a proposito: asi la herramienta
 * mide cualquier .ass (incluido uno viejo) contra lo que ese archivo dice, en
 * vez de contra lo que hoy deberia decir.
 */
function declarado(assFile) {
  const texto = fs.readFileSync(assFile, 'utf8');
  const x = texto.match(/^PlayResX:\s*(\d+)/m);
  const y = texto.match(/^PlayResY:\s*(\d+)/m);
  if (!x || !y) throw new Error('El .ass no declara PlayResX/PlayResY');
  const estilo = texto.match(/^Style: Main,(.+)$/m);
  if (!estilo) throw new Error('El .ass no trae el estilo Main');
  const campos = estilo[1].split(',');
  return {
    width: Number(x[1]),
    height: Number(y[1]),
    fontName: campos[0],
    fontSize: Number(campos[1]),
    borderStyle: Number(campos[14]),
    marginV: Number(campos[20]),
  };
}

/**
 * Caja que ocupa el texto claro dentro de una franja del encuadre.
 * Devuelve null si en ese instante no hay subtitulo en pantalla.
 */
async function cajaDeTexto(ffmpeg, assFile, segundo, { width, height, fontsDir }) {
  const err = await correr(ffmpeg, [
    '-f', 'lavfi', '-i', `color=black:s=${width}x${height}:d=1`,
    '-vf', [
      // Nada de `-ss`: al buscar sobre una fuente lavfi los timestamps se
      // reinician en 0 y libass acaba dibujando SIEMPRE el primer cue. En vez
      // de buscar, se desplaza el PTS del unico frame hasta el instante
      // pedido, asi que el filtro de subtitulos dibuja el cue que toca.
      `setpts=PTS+${segundo}/TB`,
      `subtitles='${escapeFilterPath(assFile)}'${fontsDir ? `:fontsdir='${escapeFilterPath(fontsDir)}'` : ''}`,
      'format=gray',
      // Sobre negro, cualquier pixel encendido es texto o su contorno.
      "lutyuv=y='if(gt(val,60),255,0)'",
      'bbox=min_val=128',
    ].join(','),
    '-frames:v', '1',
    '-f', 'null', '-',
  ]);
  const m = err.match(/x1:(\d+)\s+x2:(\d+)\s+y1:(\d+)\s+y2:(\d+)/);
  if (!m) return null;
  const [x1, x2, y1, y2] = m.slice(1).map(Number);
  if (x2 <= x1 || y2 <= y1) return null;
  return { x1, x2, y1, y2, ancho: x2 - x1, alto: y2 - y1 };
}

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('Falta el .ass. Uso: node scripts/captions-visual-check.mjs <archivo.ass> [segundos...]');
  process.exit(1);
}
const instantes = process.argv.slice(3).map(Number).filter(Number.isFinite);

const { ffmpeg } = await resolveFfmpeg();
if (!ffmpeg) throw new Error('FFmpeg no disponible');

const dim = declarado(file);
// Lo que la configuracion actual pediria para este encuadre, para poder decir
// si el archivo medido esta al dia o se quedo con un estilo antiguo.
const recomendado = captionMetrics(dim.width, dim.height, {});
const esperado = { ...recomendado, fontSize: dim.fontSize, marginV: dim.marginV };
// Misma carpeta de fuentes que usa el render (este build de FFmpeg no trae
// fontconfig y libass solo encuentra la fuente mirando ahi).
const fontsDir = path.join(PATHS.drafts, '_fonts');
const franja = { width: dim.width, height: dim.height, fontsDir: fs.existsSync(fontsDir) ? fontsDir : null };

console.log(`Archivo : ${file}`);
console.log(`Encuadre: ${dim.width}x${dim.height} (${recomendado.aspecto})`);
console.log(`Declara : ${dim.fontName} ${dim.fontSize} px · margen inferior ${dim.marginV} px · `
  + `BorderStyle ${dim.borderStyle}`);
console.log(`Config. : recomendaria ${recomendado.fontSize} px · margen ${recomendado.marginV} px`
  + (dim.fontSize === recomendado.fontSize ? '  (coincide)' : '  (NO coincide: el .ass es de una version anterior)'));
console.log('');

const filas = [];
for (const t of instantes) {
  const caja = await cajaDeTexto(ffmpeg, file, t, franja);
  if (!caja) { console.log(`  t=${String(t).padStart(5)}s   (sin subtitulo en pantalla)`); continue; }

  // Altura de UNA linea: el bloque puede traer una o dos.
  const lineas = caja.alto > dim.fontSize * 1.6 ? 2 : 1;
  const alturaLinea = Math.round(caja.alto / lineas);
  const margenInferior = dim.height - caja.y2;
  const anchoPct = (caja.ancho / dim.width) * 100;

  filas.push({ t, alturaLinea, lineas, margenInferior, anchoPct, caja });
  console.log(
    `  t=${String(t).padStart(5)}s   ${lineas} linea(s) · alto de linea ${String(alturaLinea).padStart(3)} px`
    + ` · ancho ${anchoPct.toFixed(0).padStart(3)} % · margen inferior ${String(margenInferior).padStart(4)} px`,
  );
}

if (!filas.length) { console.log('\nNo se encontro subtitulo en ninguno de los instantes pedidos.'); process.exit(0); }

// --------------------------------------------------------------- VEREDICTO
const alturas = filas.map(f => f.alturaLinea);
const media = Math.round(alturas.reduce((a, b) => a + b, 0) / alturas.length);
const problemas = [];

// La caja medida es la altura de los GLIFOS, menor que el cuerpo de la fuente
// (las mayusculas ocupan ~0.72 em). Se compara con ese margen.
const minimo = Math.round(esperado.fontSize * 0.55);
const maximo = Math.round(esperado.fontSize * 1.15);
if (media < minimo) problemas.push(`la letra mide ${media} px de alto y para ${esperado.fontSize} px de cuerpo deberia pasar de ${minimo}`);
if (media > maximo) problemas.push(`la letra mide ${media} px, mas de lo esperado para ${esperado.fontSize} px de cuerpo`);

for (const f of filas) {
  if (f.caja.x1 < 2 || f.caja.x2 > dim.width - 2) problemas.push(`t=${f.t}s: el texto toca el borde lateral`);
  if (f.caja.y2 > dim.height - 2) problemas.push(`t=${f.t}s: el texto toca el borde inferior`);
  if (f.anchoPct > 90) problemas.push(`t=${f.t}s: el bloque ocupa el ${f.anchoPct.toFixed(0)} % del ancho`);
  if (f.lineas > 2) problemas.push(`t=${f.t}s: mas de dos lineas simultaneas`);
  if (f.margenInferior < esperado.safeBottom * 0.85) {
    problemas.push(`t=${f.t}s: el subtitulo entra en la franja de controles (margen ${f.margenInferior} px, se esperan ~${esperado.safeBottom})`);
  }
}

console.log('');
console.log(`Alto medio de linea: ${media} px  (cuerpo declarado ${esperado.fontSize} px)`);
console.log(`Margen inferior minimo medido: ${Math.min(...filas.map(f => f.margenInferior))} px`);
console.log(`Ancho maximo medido: ${Math.max(...filas.map(f => f.anchoPct)).toFixed(0)} %`);
// El encargo fija un minimo por formato: 58 px en 9:16 y 42 px en 16:9.
const MINIMO_ENCARGO = { '9:16': 58, '16:9': 42, '1:1': 48, '4:5': 48 };
const minimoFormato = MINIMO_ENCARGO[recomendado.aspecto];
if (minimoFormato && dim.fontSize < minimoFormato) {
  problemas.push(`el .ass declara ${dim.fontSize} px y en ${recomendado.aspecto} el minimo pedido es ${minimoFormato} px`);
}

console.log('');
if (problemas.length) {
  console.log('PROBLEMAS:');
  for (const p of problemas) console.log(`  - ${p}`);
  process.exitCode = 1;
} else {
  console.log('OK: legible, dentro del encuadre, dos lineas como mucho y fuera de la zona de controles.');
}
