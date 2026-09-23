/**
 * Quita de data/projects los proyectos que dejaron las PRUEBAS.
 *
 * Las pruebas creaban proyectos de verdad en la carpeta real (ya no: ver
 * scripts/test.mjs). Los que quedaron de antes entierran el trabajo de verdad
 * en la lista del editor, que ordena por fecha.
 *
 * NO BORRA NADA POR SU CUENTA. Sin `--confirmar` solo enseña lo que haria.
 * Y nunca toca un proyecto que tenga un MP4 exportado, aunque su titulo parezca
 * de prueba: un archivo terminado no se tira por un nombre.
 *
 *   node scripts/limpiar-proyectos.mjs              # ver el informe
 *   node scripts/limpiar-proyectos.mjs --confirmar  # borrar de verdad
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../src/lib/paths.js';

/** Titulos que crean las pruebas automaticas. Coincidencia EXACTA, sin comodines. */
const TITULOS_DE_PRUEBA = new Set([
  'TEST técnico de estudio',
  'Clase de prueba',
  'Prueba de progreso',
  'clases de inglés online para adultos',
  'Editor de prueba',
  'Smoke del editor',
  'Smoke de foco',
  'Transiciones',
  'Meditación diaria',
  'vol',
  'diag',
]);

const confirmar = process.argv.includes('--confirmar');

const fichas = fs.readdirSync(PATHS.projects)
  .filter(f => f.endsWith('.json'))
  .map((f) => {
    const file = path.join(PATHS.projects, f);
    try {
      const p = JSON.parse(fs.readFileSync(file, 'utf8'));
      const exportados = Object.values(p.outputs || {}).filter(Boolean);
      return {
        file,
        id: p.id,
        titulo: p.title || '(sin título)',
        escenas: p.scenes?.length || 0,
        fecha: (p.updatedAt || '').slice(0, 19),
        exportados,
        // Un proyecto sin titulo ni escenas no es de nadie: es un resto.
        vacio: !p.title && !(p.scenes?.length),
      };
    } catch { return { file, id: path.basename(f, '.json'), titulo: '(ilegible)', escenas: 0, fecha: '', exportados: [], vacio: true }; }
  });

const candidatos = fichas.filter(x => (TITULOS_DE_PRUEBA.has(x.titulo) || x.vacio) && !x.exportados.length);
const protegidos = fichas.filter(x => (TITULOS_DE_PRUEBA.has(x.titulo) || x.vacio) && x.exportados.length);
const tuyos = fichas.filter(x => !TITULOS_DE_PRUEBA.has(x.titulo) && !x.vacio);

console.log(`\nEn ${path.relative(PATHS.root, PATHS.projects)} hay ${fichas.length} proyectos.\n`);
console.log(`  ${tuyos.length} tuyos, que NO se tocan.`);
console.log(`  ${candidatos.length} de pruebas, sin nada exportado: se pueden quitar.`);
if (protegidos.length) console.log(`  ${protegidos.length} con nombre de prueba pero CON MP4 exportado: no se tocan.`);

console.log('\nTus proyectos más recientes:');
for (const x of tuyos.sort((a, b) => b.fecha.localeCompare(a.fecha)).slice(0, 12)) {
  console.log(`  ${x.fecha}  ${String(x.escenas).padStart(3)} esc  ${x.exportados.length ? 'MP4 ' : '    '} ${x.titulo.slice(0, 44)}  (${x.id})`);
}

if (!candidatos.length) { console.log('\nNo hay nada que limpiar.\n'); process.exit(0); }

if (!confirmar) {
  console.log(`\nSe quitarían ${candidatos.length} proyectos de prueba. Para hacerlo de verdad:`);
  console.log('  node scripts/limpiar-proyectos.mjs --confirmar\n');
  process.exit(0);
}

let n = 0;
for (const x of candidatos) { fs.unlinkSync(x.file); n++; }
console.log(`\nQuitados ${n} proyectos de prueba. Quedan ${fichas.length - n}.\n`);
