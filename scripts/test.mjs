/**
 * Lanzador de las pruebas, con los datos APARTE de los tuyos.
 *
 * Las pruebas crean proyectos de verdad («Clase de prueba», «TEST técnico de
 * estudio»…) y hasta ahora los escribian en data/projects, junto a los
 * proyectos reales. Como la lista del editor ordena por fecha, cada ejecucion
 * empujaba el trabajo de verdad hacia abajo: con 260 proyectos, un video hecho
 * por la mañana acababa en la posicion 41.
 *
 * Aqui se apunta el almacen a .tmp/test-data antes de arrancar. Las pruebas no
 * cambian; lo que cambia es donde escriben.
 *
 *   npm test                 todas
 *   npm test -- tests/x.js   una
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const entorno = {
  ...process.env,
  AIVM_PROJECTS_DIR: path.join(raiz, '.tmp', 'test-data', 'projects'),
  AIVM_OUTPUT_DIR: path.join(raiz, '.tmp', 'test-data', 'output'),
  AIVM_JOBS_DIR: path.join(raiz, '.tmp', 'test-data', 'video-generation'),
};

const args = process.argv.slice(2);
const hijo = spawn(
  process.execPath,
  ['--test', '--test-concurrency=1', ...(args.length ? args : [])],
  { cwd: raiz, env: entorno, stdio: 'inherit' },
);
hijo.on('exit', code => process.exit(code ?? 1));
