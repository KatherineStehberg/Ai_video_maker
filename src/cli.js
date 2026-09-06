#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';
import { PATHS, ensureDirs, abs } from './lib/paths.js';
import { resolveFfmpeg } from './lib/ffmpeg.js';
import { hardwareReport } from './lib/hardware.js';
import {
  makeProject, makeScene, saveProject, loadProject, listProjects, validateProject,
} from './core/project.js';
import { loadBrand, listBrands } from './core/brands.js';
import { getTemplate, listTemplates } from './templates/index.js';
import { runPipeline } from './core/pipeline.js';
import { outline } from './core/scene-planner.js';
import { buildExportPackage } from './core/export.js';
import * as ttsProviders from './providers/tts/index.js';
import * as llmProviders from './providers/llm/index.js';
import * as imageProviders from './providers/image/index.js';
import * as musicProviders from './providers/music/index.js';

const args = process.argv.slice(2);
const cmd = args[0];

function flag(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = args[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

const bar = (pct) => `[${'#'.repeat(Math.round(pct / 4)).padEnd(25, '.')}] ${String(pct).padStart(3)}%`;

// ---------------------------------------------------------------- doctor

async function doctor() {
  const hw = await hardwareReport();
  const ff = await resolveFfmpeg();

  console.log('\n=== ENTORNO ===');
  console.log(`Plataforma : ${hw.platform} (${hw.arch})`);
  console.log(`Node       : ${hw.node}`);
  console.log(`CPU        : ${hw.cpu.model} — ${hw.cpu.threads} hilos`);
  console.log(`RAM        : ${hw.memory.totalGB} GB (libres ${hw.memory.freeGB} GB)`);
  console.log(`GPU        : ${hw.gpu.devices.map((g) => g.name).join(', ') || 'desconocida'} [${hw.gpu.class}]`);
  console.log(`Disco libre: ${hw.disk.freeGB ?? '?'} GB`);

  console.log('\n=== FFMPEG (obligatorio) ===');
  console.log(`ffmpeg  : ${ff.ffmpeg || 'NO ENCONTRADO'}`);
  console.log(`ffprobe : ${ff.ffprobe || 'NO ENCONTRADO'}`);
  if (!ff.available) {
    console.log('  -> Instala con:  npm install ffmpeg-static ffprobe-static');
  }

  console.log('\n=== CAPACIDADES LOCALES ===');
  for (const [k, v] of Object.entries(hw.capabilities)) {
    console.log(`  ${v ? 'SI ' : 'NO '} ${k}`);
  }

  console.log('\n=== PROVIDERS (todos opcionales salvo FFmpeg) ===');
  const groups = {
    LLM: await llmProviders.status(),
    TTS: await ttsProviders.status(),
    Imagen: await imageProviders.status(),
    Musica: await musicProviders.status(),
  };
  for (const [group, st] of Object.entries(groups)) {
    console.log(`  ${group}:`);
    for (const [name, info] of Object.entries(st)) {
      console.log(`    ${info.available ? 'OK  ' : '--  '} ${name.padEnd(20)} ${info.label || ''}`);
    }
  }

  const voices = await ttsProviders.listAllVoices();
  console.log(`\n=== VOCES (${voices.length}) ===`);
  for (const v of voices) console.log(`  ${v.name} [${v.language}] (${v.provider})`);
  if (!voices.length) console.log('  Ninguna. El video se renderizara en silencio.');

  if (hw.notes.length) {
    console.log('\n=== LIMITACIONES DETECTADAS ===');
    hw.notes.forEach((n) => console.log(`  - ${n}`));
  }
  console.log(`\nPerfil de render recomendado: ${hw.recommendedProfile} (actual: ${CONFIG.render.profile})\n`);
}

// ---------------------------------------------------------------- render

async function renderCmd(projectId) {
  const project = loadProject(projectId);
  if (!project) {
    console.error(`Proyecto ${projectId} no encontrado. Usa: npm run cli -- list`);
    process.exit(1);
  }
  const formats = flag('formats');
  const steps = flag('steps');
  let last = -1;
  const report = await runPipeline(project, {
    formats: typeof formats === 'string' ? formats.split(',') : null,
    steps: typeof steps === 'string' ? steps.split(',') : undefined,
    onProgress: (p) => {
      if (p.pct !== last) {
        last = p.pct;
        process.stdout.write(`\r${bar(p.pct)} ${String(p.message || p.step).slice(0, 45).padEnd(45)}`);
      }
    },
  });
  process.stdout.write('\n');
  console.log('\nSalidas:');
  for (const [fmt, file] of Object.entries(report.project.outputs || {})) {
    const a = abs(file);
    console.log(`  ${fmt.padEnd(6)} ${file}  (${(fs.statSync(a).size / 1e6).toFixed(1)} MB)`);
  }
  report.warnings.forEach((w) => console.log(`  ! ${w}`));
}

// ---------------------------------------------------------------- demo

/**
 * Demo end-to-end sin IA y sin assets del usuario:
 * crea un proyecto, genera fondos con FFmpeg, narra con el TTS local
 * disponible, crea subtitulos y renderiza 9:16 + 16:9.
 */
async function demo() {
  ensureDirs();
  const lang = flag('lang', 'es');
  const isEn = lang === 'en';

  const guion = isEn
    ? [
      'Most people record video with a phone and stop there.',
      'The hard part is not filming. It is turning an idea into a finished piece.',
      'A script gives the video a spine. Scenes give it rhythm.',
      'Narration and captions make it work with the sound off.',
      'Render once, export for every platform.',
    ]
    : [
      'La mayoria graba con el telefono y se queda ahi.',
      'Lo dificil no es grabar. Es convertir una idea en una pieza terminada.',
      'El guion le da columna vertebral al video. Las escenas le dan ritmo.',
      'La narracion y los subtitulos hacen que funcione sin sonido.',
      'Renderiza una vez y exporta para cada plataforma.',
    ];

  const project = makeProject({
    title: isEn ? 'From idea to finished video' : 'De la idea al video terminado',
    brand: flag('brand', 'ksl'),
    template: 'social-multiformat',
    language: lang,
    brief: isEn ? 'How to turn an idea into a finished video' : 'Como convertir una idea en un video terminado',
    objective: isEn ? 'Show the pipeline works' : 'Demostrar que el pipeline funciona',
    audience: isEn ? 'Creators' : 'Creadores de contenido',
    cta: isEn ? 'Try it yourself' : 'Pruebalo tu mismo',
    aspectRatio: '9:16',
    exportFormats: (flag('formats', '9:16,16:9') || '9:16,16:9').toString().split(','),
    platform: ['youtube', 'tiktok', 'instagram'],
    script: guion.map((l) => `## ${l}`).join('\n'),
    scenes: guion.map((text, i) => makeScene({
      text,
      duration: 4.5,
      onScreenTitle: i === 0 ? (isEn ? 'AI Video Maker' : 'AI Video Maker') : '',
      kenBurns: 'auto',
      transition: i === guion.length - 1 ? 'none' : 'fade',
    })),
  });
  saveProject(project);

  console.log(`\nProyecto demo: ${project.id} — "${project.title}"`);
  console.log(`Escenas: ${project.scenes.length} | Formatos: ${project.exportFormats.join(', ')}\n`);

  let last = -1;
  const t0 = Date.now();
  const report = await runPipeline(project, {
    // 'script' y 'scenes' se saltan: el guion y las escenas ya vienen definidos.
    steps: ['assets', 'narration', 'subtitles', 'render', 'metadata'],
    onProgress: (p) => {
      if (p.pct !== last) {
        last = p.pct;
        process.stdout.write(`\r${bar(p.pct)} ${String(p.message || p.step).slice(0, 45).padEnd(45)}`);
      }
    },
  });
  process.stdout.write('\n');

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nRender completado en ${secs}s\n`);
  for (const [fmt, file] of Object.entries(report.project.outputs || {})) {
    console.log(`  ${fmt.padEnd(6)} ${abs(file)}  (${(fs.statSync(abs(file)).size / 1e6).toFixed(1)} MB)`);
  }
  report.warnings.forEach((w) => console.log(`  ! ${w}`));
  console.log(`\nReabrir y re-renderizar:  npm run cli -- render ${project.id}\n`);
  return project;
}

// ---------------------------------------------------------------- otros

function listCmd() {
  const rows = listProjects();
  if (!rows.length) return console.log('No hay proyectos. Crea uno con: npm run demo');
  console.log('\nID'.padEnd(24) + 'ESTADO'.padEnd(14) + 'ESC'.padEnd(5) + 'SEG'.padEnd(6) + 'TITULO');
  for (const r of rows) {
    console.log(
      r.id.padEnd(24) + String(r.status).padEnd(14) +
      String(r.scenes).padEnd(5) + String(r.duration).padEnd(6) + r.title,
    );
  }
  console.log('');
}

function showCmd(id) {
  const project = loadProject(id);
  if (!project) return console.error('No encontrado');
  const o = outline(project);
  const v = validateProject(project);
  console.log(`\n${project.title}  [${project.id}]`);
  console.log(`Marca: ${project.brand} | Template: ${o.template} | ${o.sceneCount} escenas | ${o.totalSeconds}s`);
  console.log(`Valido: ${v.ok ? 'SI' : 'NO'}`);
  v.errors.forEach((e) => console.log(`  ERROR: ${e}`));
  v.warnings.forEach((w) => console.log(`  aviso: ${w}`));
  console.log('');
  for (const s of o.scenes) {
    console.log(`  ${String(s.n).padStart(2)}. ${String(s.seconds).padStart(5)}s ` +
      `${s.hasAsset ? 'IMG' : '---'} ${s.hasNarration ? 'VOZ' : '---'}  ${s.text}`);
  }
  console.log('');
}

function help() {
  console.log(`
AI_Video_Maker — CLI

  npm run doctor                      Inspecciona hardware, FFmpeg y providers
  npm run demo                        Crea y renderiza un video de demostracion
  npm start                           Levanta la UI en http://127.0.0.1:${CONFIG.port}

  npm run cli -- list                 Lista proyectos
  npm run cli -- show <id>            Detalle de un proyecto
  npm run cli -- render <id>          Re-renderiza un proyecto existente
      --formats 16:9,9:16,1:1
      --steps assets,narration,subtitles,render,metadata
  npm run cli -- export <id>          Empaqueta MP4 + subtitulos + metadatos
  npm run cli -- templates            Lista templates
  npm run cli -- brands               Lista marcas
`);
}

// ---------------------------------------------------------------- dispatch

try {
  switch (cmd) {
    case 'doctor': await doctor(); break;
    case 'demo': await demo(); break;
    case 'render': await renderCmd(args[1]); break;
    case 'list': listCmd(); break;
    case 'show': showCmd(args[1]); break;
    case 'export': {
      const project = loadProject(args[1]);
      if (!project) throw new Error('Proyecto no encontrado');
      console.log(JSON.stringify(buildExportPackage(project), null, 2));
      break;
    }
    case 'templates': console.table(listTemplates()); break;
    case 'brands': console.table(listBrands().map((b) => ({ id: b.id, name: b.name, cta: b.cta }))); break;
    default: help();
  }
} catch (e) {
  console.error(`\nERROR: ${e.message}\n`);
  process.exit(1);
}
