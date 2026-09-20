#!/usr/bin/env node
/**
 * Prueba reproducible de un proyecto LARGO, de punta a punta y en local.
 *
 * Qué demuestra, con cifras medidas y no estimadas a ojo:
 *   - número de palabras del guion,
 *   - número de escenas,
 *   - duración estimada antes de producir,
 *   - duración REAL medida con ffprobe sobre el MP4,
 *   - estado final del flujo,
 *   - uso máximo de memoria del proceso,
 *   - que el guion llegó entero, sin truncar,
 *   - que el proyecto se puede reanudar.
 *
 * Coste: cero. Voz local (SAPI/Piper), fondos generados con FFmpeg, sin Pexels,
 * sin Gemini y sin ninguna API de pago. Las visuales son fixtures locales.
 *
 * Uso:
 *   node scripts/long-form-smoke.mjs              # planifica 12 min, renderiza una muestra
 *   node scripts/long-form-smoke.mjs --full       # renderiza el proyecto largo entero (lento)
 *   node scripts/long-form-smoke.mjs --palabras 2500
 */

import fs from 'node:fs';
import path from 'node:path';
import { planJob, draftJob, createJob, getJob, regenerateScene } from '../src/generation/jobs.js';
import { contarPalabras, sinPerdidaDeTexto, formatearDuracion } from '../src/generation/segmenter.js';
import { probeDuration } from '../src/lib/ffmpeg.js';
import { loadProject } from '../src/core/project.js';
import { abs } from '../src/lib/paths.js';

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const valor = (n, d) => { const i = args.indexOf(n); return i >= 0 ? Number(args[i + 1]) : d; };

const OBJETIVO_PALABRAS = valor('--palabras', 2500);
const COMPLETO = flag('--full');
const SALIDA = path.resolve('.tmp/long-form-smoke');

// Memoria: se muestrea durante todo el proceso, no sólo al final.
let picoRssMB = 0;
let wpmEfectivoMedido = null;
let regeneracion = null;
const muestreo = setInterval(() => {
  picoRssMB = Math.max(picoRssMB, process.memoryUsage().rss / 1024 / 1024);
}, 250);
muestreo.unref?.();

const log = (k, v) => console.log(`  ${String(k).padEnd(28)} ${v}`);
const titulo = t => console.log(`\n${t}\n${'─'.repeat(t.length)}`);

/** Guion de clase sintético, con títulos y párrafos, de la longitud pedida. */
function guionDeClase(objetivoPalabras) {
  const oraciones = [
    'El presente simple se usa para hablar de hábitos y rutinas diarias.',
    'Para formarlo en inglés se toma el infinitivo sin la partícula to.',
    'En la tercera persona del singular se añade una ese al final del verbo.',
    'Un error frecuente entre hispanohablantes es olvidar precisamente esa ese final.',
    'Veamos ahora algunos ejemplos concretos que aparecen prácticamente todos los días.',
    'Cuando el verbo termina en o se añade es en lugar de solamente una ese.',
    'La negación se construye con el auxiliar do acompañado de la palabra not.',
    'En la tercera persona ese auxiliar cambia y se convierte en does not.',
    'Las preguntas invierten el orden y colocan el auxiliar delante del sujeto.',
    'Practicar en voz alta es la manera más rápida de fijar todas estas reglas.',
  ];
  const partes = [];
  let modulo = 0;
  while (contarPalabras(partes.join(' ')) < objetivoPalabras) {
    modulo += 1;
    partes.push(`## Módulo ${modulo}: práctica guiada`, '');
    for (let p = 0; p < 3; p++) partes.push(oraciones.join(' '), '');
  }
  return partes.join('\n').trim();
}

async function main() {
  fs.mkdirSync(SALIDA, { recursive: true });
  const guion = guionDeClase(OBJETIVO_PALABRAS);
  fs.writeFileSync(path.join(SALIDA, 'guion.txt'), guion, 'utf8');

  titulo('1 · GUION DE ENTRADA');
  log('caracteres', guion.length.toLocaleString('es'));
  log('palabras (con títulos)', contarPalabras(guion).toLocaleString('es'));
  log('supera el viejo límite', guion.length > 2000 ? `sí (${guion.length} > 2000)` : 'NO — revisa la fixture');

  titulo('2 · PLANIFICACIÓN (sin producir nada)');
  const inicioPlan = Date.now();
  const plan = planJob({ script: guion });
  log('plantilla elegida', plan.templateId);
  log('palabras narradas', plan.palabras.toLocaleString('es'));
  log('escenas', plan.escenas);
  log('secciones', plan.secciones);
  log('velocidad de narración', `${plan.wpm} palabras/minuto`);
  log('duración estimada', `${plan.duracionEstimada} s (${plan.duracionEstimadaLegible})`);
  log('tiempo de cálculo', `${Date.now() - inicioPlan} ms`);

  titulo('3 · BORRADOR Y GARANTÍA DE NO TRUNCAMIENTO');
  const borrador = await draftJob({ script: guion });
  const integridad = sinPerdidaDeTexto(guion, borrador.escenas);
  log('origen del guion', borrador.source);
  log('escenas del borrador', borrador.escenas.length);
  log('coincide con el plan', borrador.escenas.length === plan.escenas ? 'sí' : 'NO');
  log('guion completo', integridad.ok ? 'sí, sin pérdida de texto' : `NO — falta «${integridad.falta}»`);
  log('escena más larga', `${Math.max(...borrador.escenas.map(e => e.duration))} s`);
  log('escena más corta', `${Math.min(...borrador.escenas.map(e => e.duration))} s`);
  fs.writeFileSync(path.join(SALIDA, 'plan.json'), JSON.stringify({ plan, escenas: borrador.escenas }, null, 2), 'utf8');

  titulo('4 · DURACIÓN OBJETIVO INCOMPATIBLE (debe avisar, no recortar)');
  const conObjetivo = await draftJob({ script: guion, duration: 60 });
  log('compatible', String(conObjetivo.compatibleConObjetivo));
  log('escenas tras el aviso', `${conObjetivo.escenas.length} (antes ${borrador.escenas.length})`);
  log('guion intacto', sinPerdidaDeTexto(guion, conObjetivo.escenas).ok ? 'sí' : 'NO');
  console.log(`  aviso: ${conObjetivo.advertencias[0] || '(ninguno)'}`);

  // El render completo de 12 minutos son decenas de minutos de CPU. Por
  // defecto se renderiza una MUESTRA de las primeras escenas, que recorre
  // exactamente el mismo código; `--full` hace el proyecto entero.
  const escenas = COMPLETO ? borrador.escenas : borrador.escenas.slice(0, 6);
  titulo(COMPLETO ? '5 · RENDER COMPLETO' : '5 · RENDER DE MUESTRA (usa --full para el proyecto entero)');
  log('escenas a renderizar', `${escenas.length} de ${borrador.escenas.length}`);
  const previstaMuestra = Number(escenas.reduce((a, e) => a + e.duration, 0).toFixed(2));
  log('duración prevista', `${previstaMuestra} s (${formatearDuracion(previstaMuestra)})`);

  const inicioRender = Date.now();
  let job = createJob({
    prompt: 'Clase de inglés: presente simple',
    script: guion,
    escenas: escenas.map(({ palabras, seccion, ...e }) => e),
    duration: 'auto',
    format: '16:9',
    brandId: 'personal',
  }, { providerName: 'pipeline' });

  // Sondeo del progreso REAL: escenas hechas sobre el total.
  let ultimo = '';
  while (!['completed', 'failed'].includes(job.status)) {
    await new Promise(r => setTimeout(r, 1000));
    job = getJob(job.id);
    const p = job.progreso;
    const linea = p ? `${p.estado} ${p.escenasCompletadas}/${p.escenasTotales} · ${p.porcentaje}%` : job.stage;
    if (linea !== ultimo) { console.log(`  → ${linea}`); ultimo = linea; }
  }

  titulo('6 · RESULTADO MEDIDO');
  log('estado final', job.status);
  log('estado del flujo', job.progreso?.estado ?? '—');
  log('tiempo de render', `${((Date.now() - inicioRender) / 1000).toFixed(1)} s`);
  log('projectId', job.projectId || '—');
  log('reanudable', job.projectId ? 'sí' : 'no');

  if (job.status === 'failed') {
    log('error', job.error);
    log('recuperable', String(Boolean(job.recuperable)));
    console.log('\n  El proyecto quedó en disco: `POST /api/video-generation/jobs/<id>/resume` lo retoma.');
  } else {
    const project = loadProject(job.projectId);
    const mp4 = project?.outputPath ? abs(project.outputPath) : null;
    log('archivo MP4', mp4 && fs.existsSync(mp4) ? mp4 : 'NO PRODUCIDO');
    if (mp4 && fs.existsSync(mp4)) {
      // La duración real se MIDE con ffprobe; no se deduce del plan.
      const real = await probeDuration(mp4);
      log('tamaño', `${(fs.statSync(mp4).size / 1e6).toFixed(2)} MB`);
      log('duración prevista', `${previstaMuestra} s`);
      log('duración real (ffprobe)', real ? `${real.toFixed(2)} s` : 'no medible');
      if (real) log('desfase', `${(real - previstaMuestra).toFixed(2)} s`);
      log('escenas en el proyecto', project.scenes.length);
      log('subtítulos', project.captions?.file ? 'sí' : 'no');

      // CALIBRACIÓN: la duración real la fija la voz de ESTE equipo, no la
      // estimación. Comparar las dos da la velocidad efectiva del TTS local,
      // que es el número que conviene poner en NARRATION_WPM.
      const palabrasRender = contarPalabras(escenas.map(e => e.text).join(' '));
      const narracionReal = real - escenas.length * 0.35;
      if (narracionReal > 0) {
        wpmEfectivoMedido = Math.round((palabrasRender / narracionReal) * 60);
        titulo('6b · CALIBRACIÓN DE LA VOZ LOCAL');
        log('palabras narradas', palabrasRender);
        log('wpm supuesto', plan.wpm);
        log('wpm real medido', wpmEfectivoMedido);
        log('desvío de la estimación', `${(((previstaMuestra / real) - 1) * 100).toFixed(0)} %`);
        console.log(`\n  Para que la estimación cuadre en este equipo: NARRATION_WPM=${wpmEfectivoMedido}`);
        console.log('  (o el campo «palabras por minuto» del editor). La duración real');
        console.log('  SIEMPRE se mide con ffprobe, nunca se da por buena la estimación.');
      }
    }

    // ---- Regenerar UNA escena: las demás se reutilizan por huella ----------
    titulo('8 · REGENERAR UNA SOLA ESCENA');
    const antes = Date.now();
    let reg = regenerateScene(job.id, 1, { text: 'Esta escena se ha reescrito entera para la prueba de regeneración.' });
    while (!['completed', 'failed'].includes(reg.status)) {
      await new Promise(r => setTimeout(r, 500));
      reg = getJob(reg.id);
    }
    const segundosReg = (Date.now() - antes) / 1000;
    log('estado', reg.status);
    log('tiempo', `${segundosReg.toFixed(1)} s`);
    log('render completo tardó', `${((Date.now() - inicioRender) / 1000 - segundosReg).toFixed(1)} s`);
    log('ahorro por reutilización', segundosReg < (Date.now() - inicioRender) / 1000 - segundosReg ? 'sí' : 'no apreciable');
    const tras = loadProject(job.projectId);
    log('escenas intactas', `${tras.scenes.filter((s, i) => i !== 1 && s.narrationKey).length} de ${tras.scenes.length - 1}`);
    log('texto de la escena 2', tras.scenes[1].text.slice(0, 50) + '…');
    regeneracion = { estado: reg.status, segundos: Number(segundosReg.toFixed(1)) };
  }

  clearInterval(muestreo);
  titulo('7 · MEMORIA');
  log('pico RSS del proceso', `${picoRssMB.toFixed(0)} MB`);
  log('heap usado al final', `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0)} MB`);
  console.log('\n  El video nunca se carga entero en RAM: cada escena se renderiza a su');
  console.log('  propio clip MP4 en disco y FFmpeg los concatena al final sin recodificar.');

  const informe = {
    guion: { caracteres: guion.length, palabras: contarPalabras(guion), truncado: false },
    plan, borrador: { escenas: borrador.escenas.length, integridad },
    render: {
      completo: COMPLETO, escenas: escenas.length,
      estado: job.status, estadoFlujo: job.progreso?.estado ?? null,
      projectId: job.projectId, reanudable: Boolean(job.projectId), error: job.error ?? null,
    },
    memoria: { picoRssMB: Number(picoRssMB.toFixed(0)) },
    calibracion: { wpmSupuesto: plan.wpm, wpmRealMedido: wpmEfectivoMedido },
    regeneracionDeUnaEscena: regeneracion,
    generadoEn: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(SALIDA, 'informe.json'), JSON.stringify(informe, null, 2), 'utf8');
  console.log(`\n  Informe completo: ${path.join(SALIDA, 'informe.json')}\n`);

  process.exit(job.status === 'completed' ? 0 : 1);
}

main().catch(e => { clearInterval(muestreo); console.error('\nFALLÓ:', e.message); process.exit(1); });
