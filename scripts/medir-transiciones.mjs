/**
 * Mide QUE HACE cada transicion de xfade, en vez de suponerlo por el nombre.
 *
 * Se cruzan dos clips planos (rojo -> azul) y se mira, a mitad de transicion,
 * donde esta ya el azul: izquierda/derecha y arriba/abajo. Con eso se pueden
 * escribir etiquetas que digan la verdad sobre la direccion.
 */
import { ffmpegRun, xfadeDisponibles } from '../src/lib/ffmpeg.js';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve('.tmp/xfade-medicion');
fs.mkdirSync(dir, { recursive: true });
const rojo = path.join(dir, 'rojo.mp4');
const azul = path.join(dir, 'azul.mp4');

await ffmpegRun(['-f', 'lavfi', '-i', 'color=c=red:s=160x160:r=25:d=1.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', rojo]);
await ffmpegRun(['-f', 'lavfi', '-i', 'color=c=blue:s=160x160:r=25:d=1.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', azul]);

const nombres = (await xfadeDisponibles()).sort();
const filas = [];

for (const n of nombres) {
  const png = path.join(dir, `${n}.png`);
  try {
    await ffmpegRun([
      '-i', rojo, '-i', azul,
      '-filter_complex', `[0:v][1:v]xfade=transition=${n}:duration=0.4:offset=0.4[v]`,
      '-map', '[v]', '-ss', '0.6', '-frames:v', '1', png,
    ]);
    // Se mide cuanto azul hay en cada mitad, recortando el cuadro en cuatro.
    const zona = async (crop) => {
      const r = await ffmpegRun(['-i', png, '-vf', `crop=${crop},format=rgb24`, '-f', 'rawvideo', '-']);
      return r;
    };
    const lee = async (crop) => {
      const salida = path.join(dir, 'z.raw');
      await ffmpegRun(['-i', png, '-vf', `crop=${crop},format=rgb24`, '-f', 'rawvideo', salida]);
      const b = fs.readFileSync(salida);
      let azulez = 0;
      for (let i = 0; i < b.length; i += 3) if (b[i + 2] > b[i]) azulez++;
      return azulez / (b.length / 3);
    };
    const izq = await lee('80:160:0:0');
    const der = await lee('80:160:80:0');
    const arr = await lee('160:80:0:0');
    const aba = await lee('160:80:0:80');
    filas.push({ n, izq, der, arr, aba });
    console.log(`${n.padEnd(14)} izq ${(izq * 100).toFixed(0).padStart(3)}%  der ${(der * 100).toFixed(0).padStart(3)}%  arr ${(arr * 100).toFixed(0).padStart(3)}%  aba ${(aba * 100).toFixed(0).padStart(3)}%`);
  } catch (e) {
    console.log(`${n.padEnd(14)} FALLO ${e.message.split('\n')[0]}`);
  }
}

fs.writeFileSync(path.join(dir, 'medicion.json'), JSON.stringify(filas, null, 1));
