import fs from 'node:fs';
import path from 'node:path';
import { ffmpegRun, probeDuration, escapeFilterPath, escapeDrawtext } from '../lib/ffmpeg.js';
import { PATHS, ensureDir, workDir, rel, abs } from '../lib/paths.js';
import { ASPECTS, RENDER_PROFILES, CONFIG } from '../config.js';
import { brandLogoPath, brandFontPath } from './brands.js';
import { assetKind } from './asset-manager.js';
import { writeAssForFormat } from './subtitles.js';
import { slugify, clamp } from '../lib/util.js';
import { logger } from '../lib/logger.js';

const log = logger('render');

const DEFAULT_FONT = path.join('C:', 'Windows', 'Fonts', 'arialbd.ttf');

function fontFileFor(brand) {
  const custom = brandFontPath(brand);
  if (custom) return custom;
  if (fs.existsSync(DEFAULT_FONT)) return DEFAULT_FONT;
  const fallback = path.join('C:', 'Windows', 'Fonts', 'arial.ttf');
  return fs.existsSync(fallback) ? fallback : null;
}

/**
 * Este build de FFmpeg no trae fontconfig, asi que libass solo encuentra fuentes
 * mirando `fontsdir`. Apuntarlo a C:\Windows\Fonts falla (FFmpeg se come el "C:"
 * al parsear el filtro) y ademas obliga a escanear cientos de archivos.
 * Copiamos la fuente necesaria a una carpeta propia y apuntamos ahi.
 */
function ensureFontDir(brand) {
  const src = fontFileFor(brand);
  if (!src) return null;
  const dir = ensureDir(path.join(PATHS.drafts, '_fonts'));
  const dest = path.join(dir, path.basename(src));
  try {
    if (!fs.existsSync(dest) || fs.statSync(dest).size !== fs.statSync(src).size) {
      fs.copyFileSync(src, dest);
    }
  } catch {
    return null;
  }
  return dir;
}

/**
 * Pre-escala una imagen UNA sola vez al tamano fuente del zoom.
 * Sin esto, el filtro scale correria en CADA frame: en una CPU de 2 nucleos
 * es la diferencia entre minutos y decenas de minutos.
 */
async function prepareStill(srcAbs, W, H, cacheDir, key) {
  ensureDir(cacheDir);
  const out = path.join(cacheDir, `${key}_${W}x${H}.png`);
  if (fs.existsSync(out)) {
    try {
      if (fs.statSync(out).mtimeMs >= fs.statSync(srcAbs).mtimeMs) return out;
    } catch { /* re-generar */ }
  }
  await ffmpegRun([
    '-i', srcAbs,
    '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`,
    '-frames:v', '1',
    out,
  ]);
  return out;
}

/** Fondo plano de marca cuando una escena no tiene ningun asset. */
async function solidBackground(brand, W, H, cacheDir, key) {
  ensureDir(cacheDir);
  const out = path.join(cacheDir, `${key}_solid_${W}x${H}.png`);
  if (fs.existsSync(out)) return out;
  const c1 = brand?.colors?.primary || '#1b2a41';
  const c2 = brand?.colors?.secondary || '#0b3954';
  await ffmpegRun([
    '-f', 'lavfi',
    '-i', `gradients=s=${W}x${H}:c0=${c1}:c1=${c2}:x0=0:y0=0:x1=${W}:y1=${H}:d=1`,
    '-frames:v', '1',
    '-vf', 'format=rgb24',
    out,
  ]);
  return out;
}

/** Expresiones de zoompan para el efecto Ken Burns. */
function kenBurnsFilter(mode, frames, W, H, maxZoom = 1.16) {
  const step = (maxZoom - 1) / Math.max(1, frames);
  const common = `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}`;
  if (mode === 'none') {
    return `zoompan=z=1:${common}`;
  }
  if (mode === 'out') {
    return `zoompan=z='if(lte(on,1),${maxZoom},max(1.0,zoom-${step.toFixed(6)}))':${common}`;
  }
  return `zoompan=z='min(zoom+${step.toFixed(6)},${maxZoom})':${common}`;
}

/**
 * Renderiza UNA escena a un clip MP4 sin audio.
 * Trabajar por escena mantiene el uso de RAM acotado (importante con 8 GB)
 * y permite cachear: reeditar una escena no re-renderiza las demas.
 */
async function renderSceneClip(scene, index, ctx) {
  const { W, H, fps, profile, brand, project, clipsDir, cacheDir } = ctx;
  const out = path.join(clipsDir, `${String(index).padStart(3, '0')}_${scene.id}.mp4`);
  const duration = clamp(Number(scene.duration) || 3, 0.5, 300);
  const frames = Math.max(1, Math.round(duration * fps));

  const srcRel = scene.assetPath;
  const srcAbs = srcRel ? abs(srcRel) : null;
  const kind = srcAbs && fs.existsSync(srcAbs) ? assetKind(srcAbs) : 'none';

  const kb = scene.kenBurns === 'auto' ? (index % 2 === 0 ? 'in' : 'out') : (scene.kenBurns || 'none');

  const filters = [];
  const inputArgs = [];

  if (kind === 'video') {
    inputArgs.push('-i', srcAbs);
    filters.push(
      `scale=${W}:${H}:force_original_aspect_ratio=increase`,
      `crop=${W}:${H}`,
      'setsar=1',
      `fps=${fps}`,
    );
  } else {
    // Imagen fija (o fondo generado). Se pre-escala a 2x para que el zoom sea suave.
    const zoomW = kb === 'none' ? W : W * 2;
    const zoomH = kb === 'none' ? H : H * 2;
    const key = `${project.id}_${scene.id}`;
    const still = kind === 'image'
      ? await prepareStill(srcAbs, zoomW, zoomH, cacheDir, key)
      : await solidBackground(brand, zoomW, zoomH, cacheDir, key);

    inputArgs.push('-loop', '1', '-framerate', String(fps), '-i', still);
    filters.push(kenBurnsFilter(kb, frames, W, H), `fps=${fps}`, 'setsar=1');
  }

  // Titulo en pantalla (opcional, por escena).
  if (scene.onScreenTitle?.trim() && ctx.fontFile) {
    const size = Math.round(W / 16);
    filters.push(
      `drawtext=fontfile='${escapeFilterPath(ctx.fontFile)}':` +
      `text='${escapeDrawtext(scene.onScreenTitle.trim())}':` +
      `fontcolor=${brand?.colors?.text || '#ffffff'}:fontsize=${size}:` +
      `x=(w-text_w)/2:y=h*0.12:` +
      `box=1:boxcolor=black@0.45:boxborderw=${Math.round(size / 3)}`,
    );
  }

  // Transicion barata: fundido de entrada/salida por clip.
  // Evita xfade (que exige decodificar dos clips a la vez) en CPU modesta.
  if (scene.transition && scene.transition !== 'none') {
    const fd = Math.min(0.4, duration / 4);
    filters.push(`fade=t=in:st=0:d=${fd.toFixed(2)}`);
    filters.push(`fade=t=out:st=${(duration - fd).toFixed(2)}:d=${fd.toFixed(2)}`);
  }

  filters.push('format=yuv420p');

  const args = [
    ...inputArgs,
    '-t', duration.toFixed(3),
    '-vf', filters.join(','),
    '-an',
    '-c:v', 'libx264',
    '-preset', profile.preset,
    '-crf', '18',              // calidad alta en el intermedio: el final vuelve a comprimir
    '-pix_fmt', 'yuv420p',
    '-r', String(fps),
    '-movflags', '+faststart',
  ];
  if (CONFIG.render.threads > 0) args.push('-threads', String(CONFIG.render.threads));
  args.push(out);

  await ffmpegRun(args);
  return out;
}

/** Normaliza un intro/outro de marca a los mismos parametros que los clips. */
async function normalizeBumper(srcAbs, ctx, tag) {
  const { W, H, fps, profile, clipsDir } = ctx;
  const out = path.join(clipsDir, `${tag}.mp4`);
  await ffmpegRun([
    '-i', srcAbs,
    '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${fps},format=yuv420p`,
    '-an',
    '-c:v', 'libx264', '-preset', profile.preset, '-crf', '18',
    '-r', String(fps),
    out,
  ]);
  return out;
}

/** Concatena los clips sin recodificar (concat demuxer). */
async function concatClips(clips, workingDir) {
  const listFile = path.join(workingDir, 'concat.txt');
  const body = clips
    .map((c) => `file '${c.split(path.sep).join('/').split("'").join("'\\''")}'`)
    .join('\n');
  fs.writeFileSync(listFile, body, 'utf8');

  const out = path.join(workingDir, 'video_mudo.mp4');
  await ffmpegRun([
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c', 'copy',
    out,
  ]);
  return out;
}

/**
 * Construye la pista de audio final: narracion + musica con ducking simple.
 * Devuelve la ruta del WAV mezclado, o null si no hay nada que sonar.
 */
async function buildAudioTrack(project, workingDir, totalSeconds) {
  const narration = path.join(workingDir, 'narration.wav');
  const hasNarration = fs.existsSync(narration);
  const musicRel = project.music?.enabled ? project.music?.path : null;
  const musicAbs = musicRel ? abs(musicRel) : null;
  const hasMusic = Boolean(musicAbs && fs.existsSync(musicAbs));

  if (!hasNarration && !hasMusic) return null;

  const out = path.join(workingDir, 'audio_final.wav');
  const inputs = [];
  const filters = [];
  const labels = [];
  let i = 0;

  if (hasNarration) {
    inputs.push('-i', narration);
    filters.push(`[${i}:a]aresample=48000,volume=1.0[voz]`);
    labels.push('[voz]');
    i++;
  }
  if (hasMusic) {
    const vol = clamp(Number(project.music.volume) || 0.12, 0, 1);
    const fadeIn = clamp(Number(project.music.fadeIn) || 0, 0, 10);
    const fadeOut = clamp(Number(project.music.fadeOut) || 0, 0, 10);
    inputs.push('-stream_loop', '-1', '-i', musicAbs); // repite si es mas corta que el video
    filters.push(
      `[${i}:a]aresample=48000,atrim=0:${totalSeconds.toFixed(3)},` +
      `afade=t=in:st=0:d=${fadeIn},` +
      `afade=t=out:st=${Math.max(0, totalSeconds - fadeOut).toFixed(3)}:d=${fadeOut},` +
      `volume=${vol}[mus]`,
    );
    labels.push('[mus]');
    i++;
  }

  const graph = labels.length > 1
    ? `${filters.join(';')};${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=longest[out]`
    : `${filters.join(';')};${labels[0]}anull[out]`;

  await ffmpegRun([
    ...inputs,
    '-filter_complex', graph,
    '-map', '[out]',
    '-t', totalSeconds.toFixed(3),
    '-ar', '48000', '-ac', '2',
    out,
  ]);
  return out;
}

/** Filtros de la pasada final: subtitulos quemados, logo y CTA. */
function buildOverlayGraph(project, brand, ctx, subsAbs, logoAbs, totalSeconds) {
  const { W, H } = ctx;
  const parts = [];
  let cur = '[0:v]';

  if (subsAbs && project.captions?.burnIn !== false) {
    // subsAbs es un .ass con PlayRes = tamano del video, asi que el estilo
    // ya viene dentro del archivo y no hace falta force_style.
    const fontsDir = ctx.fontsDir ? `:fontsdir='${escapeFilterPath(ctx.fontsDir)}'` : '';
    parts.push(`${cur}subtitles='${escapeFilterPath(subsAbs)}'${fontsDir}[subbed]`);
    cur = '[subbed]';
  }

  if (project.cta?.trim() || brand?.cta?.trim()) {
    const text = (project.cta || brand.cta).trim();
    if (ctx.fontFile) {
      const size = Math.round(W / 20);
      const from = Math.max(0, totalSeconds - 3.5);
      parts.push(
        `${cur}drawtext=fontfile='${escapeFilterPath(ctx.fontFile)}':` +
        `text='${escapeDrawtext(text)}':` +
        `fontcolor=${brand?.colors?.text || '#ffffff'}:fontsize=${size}:` +
        `x=(w-text_w)/2:y=h*0.78:` +
        `box=1:boxcolor=${brand?.colors?.accent || '#f2b705'}@0.85:boxborderw=${Math.round(size / 2.5)}:` +
        `enable='between(t,${from.toFixed(2)},${totalSeconds.toFixed(2)})'[cta]`,
      );
      cur = '[cta]';
    }
  }

  if (logoAbs) {
    const logoW = Math.round(W * clamp(Number(brand?.logoScale) || 0.09, 0.02, 0.4));
    const margin = Math.round(W * 0.04);
    const pos = {
      'top-right': `x=W-w-${margin}:y=${margin}`,
      'top-left': `x=${margin}:y=${margin}`,
      'bottom-right': `x=W-w-${margin}:y=H-h-${margin}`,
      'bottom-left': `x=${margin}:y=H-h-${margin}`,
    }[brand?.logoPosition || 'top-right'];
    const opacity = clamp(Number(brand?.logoOpacity) ?? 0.85, 0, 1);
    parts.push(`[1:v]scale=${logoW}:-1,format=rgba,colorchannelmixer=aa=${opacity}[logo]`);
    parts.push(`${cur}[logo]overlay=${pos}:format=auto[vout]`);
    cur = '[vout]';
  }

  return { graph: parts.join(';'), outLabel: cur };
}

/**
 * Render completo de un proyecto en UN formato.
 * Devuelve { file, seconds, format }.
 */
export async function renderProject(project, brand, {
  aspectRatio = null,
  onProgress = null,
  subtitlesPath = null,
} = {}) {
  const aspect = aspectRatio || project.aspectRatio;
  const dims = ASPECTS[aspect];
  if (!dims) throw new Error(`Formato no soportado: ${aspect}`);

  const profile = RENDER_PROFILES[CONFIG.render.profile] || RENDER_PROFILES.fast;
  const wd = workDir(project.id);
  const clipsDir = ensureDir(path.join(wd, `clips_${aspect.replace(':', 'x')}`));
  const cacheDir = ensureDir(path.join(wd, 'stills'));

  const ctx = {
    W: dims.width,
    H: dims.height,
    fps: profile.fps,
    profile,
    brand,
    project,
    clipsDir,
    cacheDir,
    fontFile: fontFileFor(brand),
    fontsDir: ensureFontDir(brand),
  };

  const totalSeconds = project.scenes.reduce((a, s) => a + (Number(s.duration) || 0), 0);
  if (!(totalSeconds > 0)) throw new Error('El proyecto no tiene duracion');

  // --- 1. Clips por escena ---
  const clips = [];
  const introAbs = project.assets?.intro || brand?.intro;
  if (introAbs && fs.existsSync(abs(introAbs))) {
    onProgress?.({ step: 'intro', pct: 2 });
    clips.push(await normalizeBumper(abs(introAbs), ctx, 'intro'));
  }

  for (let i = 0; i < project.scenes.length; i++) {
    onProgress?.({
      step: 'scene',
      index: i,
      total: project.scenes.length,
      pct: 5 + Math.round((i / project.scenes.length) * 55),
      message: `Escena ${i + 1}/${project.scenes.length} (${aspect})`,
    });
    clips.push(await renderSceneClip(project.scenes[i], i, ctx));
  }

  const outroAbs = project.assets?.outro || brand?.outro;
  if (outroAbs && fs.existsSync(abs(outroAbs))) {
    clips.push(await normalizeBumper(abs(outroAbs), ctx, 'outro'));
  }

  // --- 2. Concatenar (sin recodificar) ---
  onProgress?.({ step: 'concat', pct: 65, message: 'Uniendo escenas' });
  const silent = await concatClips(clips, clipsDir);
  const videoSeconds = (await probeDuration(silent)) || totalSeconds;

  // --- 3. Audio ---
  onProgress?.({ step: 'audio', pct: 72, message: 'Mezclando audio' });
  const audio = await buildAudioTrack(project, wd, videoSeconds);

  // --- 4. Pasada final: subtitulos + logo + CTA + audio ---
  onProgress?.({ step: 'compose', pct: 78, message: 'Componiendo video final' });

  // El .srt es el entregable; para quemar generamos un .ass a la resolucion
  // exacta de ESTE formato, para que el texto tenga el mismo tamano relativo
  // en 9:16, 16:9 y 1:1.
  const subsAbs = (subtitlesPath && project.captions?.burnIn !== false)
    ? writeAssForFormat(project, {
      width: dims.width,
      height: dims.height,
      brand,
      suffix: `_${aspect.replace(':', 'x')}`,
    })
    : null;
  const logoAbs = project.assets?.logo && fs.existsSync(abs(project.assets.logo))
    ? abs(project.assets.logo)
    : brandLogoPath(brand);

  const outName = `${slugify(project.title)}_${aspect.replace(':', 'x')}.mp4`;
  const outFile = path.join(ensureDir(PATHS.final), outName);

  const compose = async (useSubs) => {
    const inputs = ['-i', silent];
    if (logoAbs) inputs.push('-i', logoAbs);
    if (audio) inputs.push('-i', audio);

    const { graph, outLabel } = buildOverlayGraph(
      project, brand, ctx, useSubs ? subsAbs : null, logoAbs, videoSeconds,
    );

    const args = [...inputs];
    if (graph) args.push('-filter_complex', graph, '-map', outLabel);
    else args.push('-map', '0:v');

    if (audio) {
      const audioIdx = logoAbs ? 2 : 1;
      args.push('-map', `${audioIdx}:a`, '-c:a', 'aac', '-b:a', profile.audioBitrate, '-shortest');
    } else {
      args.push('-an');
    }
    args.push(
      '-c:v', 'libx264',
      '-preset', profile.preset,
      '-crf', String(profile.crf),
      '-pix_fmt', 'yuv420p',
      '-r', String(profile.fps),
      '-movflags', '+faststart',
    );
    if (CONFIG.render.threads > 0) args.push('-threads', String(CONFIG.render.threads));
    args.push(outFile);

    return ffmpegRun(args, {
      onProgress: (t) => onProgress?.({
        step: 'encode',
        pct: 78 + Math.min(20, Math.round((t / videoSeconds) * 20)),
        message: `Codificando ${Math.round(t)}s / ${Math.round(videoSeconds)}s`,
      }),
    });
  };

  // El subtitulado depende de libass y de que haya una fuente utilizable.
  // Si falla, se entrega el video igual y el .srt queda aparte: un problema
  // de fuentes no puede tumbar un render de varios minutos.
  let captionsBurned = Boolean(subsAbs);
  try {
    await compose(true);
  } catch (e) {
    if (!subsAbs) throw e;
    log.warn('Fallo el quemado de subtitulos, se reintenta sin ellos:', e.message.split('\n')[0]);
    captionsBurned = false;
    await compose(false);
  }

  onProgress?.({ step: 'done', pct: 100, message: 'Listo' });
  log.info(`Render OK ${aspect}: ${outFile}`);

  return {
    file: rel(outFile),
    absolute: outFile,
    seconds: videoSeconds,
    format: aspect,
    width: dims.width,
    height: dims.height,
    bytes: fs.statSync(outFile).size,
    captionsBurned,
  };
}

/** Limpia los intermedios de un proyecto. NUNCA borra assets ni renders finales. */
export function cleanIntermediates(projectId) {
  const wd = path.join(PATHS.drafts, projectId);
  if (!fs.existsSync(wd)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(wd, { withFileTypes: true })) {
    if (entry.isDirectory() && (entry.name.startsWith('clips_') || entry.name === 'stills')) {
      fs.rmSync(path.join(wd, entry.name), { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}
