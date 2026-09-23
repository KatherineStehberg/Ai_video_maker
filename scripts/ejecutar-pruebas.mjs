/**
 * Lanzador de las pruebas, con los datos APARTE de los tuyos.
 *
 * NO puede llamarse `test.mjs`: el propio `node --test` considera archivo de
 * prueba a todo lo que se llame asi, con lo que se ejecutaria a si mismo y
 * lanzaria otro `node --test`, y ese otro, y otro. Se convirtio en una bomba
 * de procesos (230 nodes en dos minutos) antes de que nada llegara a fallar.
 * Por lo mismo se le pasan las rutas explicitas: sin ellas el runner rastrea
 * el repositorio entero, incluida .tmp/.
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
  ['--test', '--test-concurrency=1', ...(args.length ? args : ['tests/'])],
  { cwd: raiz, env: entorno, stdio: 'inherit' },
);
hijo.on('exit', code => process.exit(code ?? 1));
