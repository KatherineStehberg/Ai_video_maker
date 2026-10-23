/**
 * Deja el equipo con los proyectos que valen y quita el resto.
 *
 * De 260 proyectos, 215 tenian un MP4 exportado, pero casi todos eran renders
 * de prueba de 1-4 MB: las pruebas automaticas escribian en las carpetas reales
 * (ya no; ver scripts/test.mjs). Con tanto ruido, encontrar un video de verdad
 * en el inicio era imposible.
 *
 * QUE TOCA Y QUE NO
 *
 *   data/projects          borra los que no estan en CONSERVAR
 *   output/final           borra los MP4 y paquetes de esos proyectos
 *   output/drafts          borra su cache de render (se puede rehacer)
 *   data/video-generation  borra sus trabajos, y los intentos sin proyecto
 *
 *   data/analyses          NO SE TOCA: ahi estan los videos originales que
 *                          subio la usuaria, y eso no se puede rehacer
 *   data/assets            NO SE TOCA: imagenes, musica y efectos con licencia
 *   data/brands            NO SE TOCA
 *
 * NO BORRA NADA sin `--confirmar`: sin esa bandera solo enseña el informe.
 *
 *   node scripts/limpiar-proyectos.mjs              # ver que haria
 *   node scripts/limpiar-proyectos.mjs --confirmar  # hacerlo
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../src/lib/paths.js';

/**
 * LOS QUE SE QUEDAN. Se listan por id, no por titulo: hay catorce proyectos
 * llamados igual y un titulo no identifica nada.
 */
export const CONSERVAR = new Map([
  ['vid_muajz54k43c23b', 'video espiritual (279 escenas)'],
  ['vid_muaa12ir25c6d8', 'Clase de inglés: presente simple (105 escenas)'],
  ['vid_muag4nlb11f3b2', 'Video 9:16 (20 escenas)'],
  ['vid_mud2hliu9f5432', 'Video 16:9 (15 escenas)'],
]);

const confirmar = process.argv.includes('--confirmar');
const ID = /vid_[a-z0-9]+/i;

const mb = b => `${(b / 1048576).toFixed(0)} MB`;

/** Tamaño de un archivo o de una carpeta entera. */
function pesa(p) {
  let total = 0;
  const ver = (x) => {
    let s;
    try { s = fs.statSync(x); } catch { return; }
    if (s.isDirectory()) { for (const f of fs.readdirSync(x)) ver(path.join(x, f)); } else total += s.size;
  };
  ver(p);
  return total;
}

const borrar = [];   // { ruta, bytes, zona }
const intactos = []; // lo que se queda por no poder identificarlo

/** Apunta para borrar todo lo de una carpeta cuyo id NO esté en CONSERVAR. */
function revisar(zona, dir, idDe) {
  if (!fs.existsSync(dir)) return;
  for (const nombre of fs.readdirSync(dir)) {
    const ruta = path.join(dir, nombre);
    const id = idDe(nombre, ruta);
    if (id && CONSERVAR.has(id)) continue;
    // Sin id no se puede saber de quién es: se deja y se dice.
    if (!id) { intactos.push(path.relative(PATHS.root, ruta)); continue; }
    borrar.push({ ruta, bytes: pesa(ruta), zona });
  }
}

revisar('proyectos', PATHS.projects, n => (n.endsWith('.json') ? n.replace(/\.json$/, '') : null));
revisar('exportados', PATHS.final, n => n.match(ID)?.[0] || null);
// En la cache tambien quedaron carpetas de pruebas antiguas, con nombre propio
// en vez de id de proyecto («audio-block-test-…»).
revisar('caché de render', PATHS.drafts, n => (ID.test(n) ? n : (/^audio-block-test/.test(n) ? 'sin-proyecto' : null)));
revisar('trabajos', PATHS.trabajos, (n, ruta) => {
  // Cada trabajo son dos cosas: su .json y una carpeta con el mismo nombre.
  // La carpeta hereda el destino de su .json; si no tiene, es un resto.
  const ficha = n.endsWith('.json') ? ruta : `${ruta}.json`;
  if (n === '.gitkeep') return null;
  try {
    const j = JSON.parse(fs.readFileSync(ficha, 'utf8'));
    // Un intento que no dejó proyecto no tiene nada que abrir: fuera.
    return j.projectId || 'sin-proyecto';
  } catch { return 'sin-proyecto'; }
});

// ------------------------------------------------------------------ informe

const porZona = new Map();
for (const x of borrar) {
  const z = porZona.get(x.zona) || { n: 0, bytes: 0 };
  z.n++; z.bytes += x.bytes;
  porZona.set(x.zona, z);
}

console.log('\nSE CONSERVAN:');
for (const [id, que] of CONSERVAR) console.log(`  ${id}  ${que}`);

console.log('\nSE QUITAN:');
for (const [zona, z] of porZona) console.log(`  ${String(z.n).padStart(4)} en ${zona.padEnd(16)} ${mb(z.bytes).padStart(9)}`);
console.log(`  ${String(borrar.length).padStart(4)} en total${' '.repeat(12)}${mb(borrar.reduce((a, x) => a + x.bytes, 0)).padStart(9)}`);

if (intactos.length) console.log(`\nSe dejan ${intactos.length} archivos sin identificar (sin id de proyecto en el nombre).`);
console.log('\nNO se toca: data/analyses (tus videos subidos), data/assets, data/brands.');

// Red de seguridad: si algo de los que se conservan acabó en la lista, se para.
const error = borrar.find(x => [...CONSERVAR.keys()].some(id => x.ruta.includes(id)));
if (error) { console.error(`\nABORTADO: se iba a borrar algo de un proyecto conservado: ${error.ruta}\n`); process.exit(1); }

if (!confirmar) {
  console.log('\nEsto es solo el informe. Para hacerlo de verdad:');
  console.log('  node scripts/limpiar-proyectos.mjs --confirmar\n');
  process.exit(0);
}

let n = 0;
let bytes = 0;
for (const x of borrar) {
  try { fs.rmSync(x.ruta, { recursive: true, force: true }); n++; bytes += x.bytes; }
  catch (e) { console.error(`  no se pudo quitar ${x.ruta}: ${e.message}`); }
}
console.log(`\nQuitados ${n} elementos. Liberados ${mb(bytes)}.\n`);
