import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ensureDir, abs, rel } from '../lib/paths.js';
import { ASPECTS } from '../config.js';
import { loadBrand } from './brands.js';
import { buildMetadata } from '../providers/publish/index.js';
import { slugify } from '../lib/util.js';

/**
 * Empaqueta el resultado de un proyecto: MP4s + subtitulos + metadatos por
 * plataforma, en una carpeta lista para subir a mano.
 */
export function buildExportPackage(project, { includeSubtitles = true } = {}) {
  const brand = loadBrand(project.brand);
  const dir = ensureDir(path.join(PATHS.final, `${slugify(project.title)}_${project.id}`));

  const files = [];
  for (const [fmt, relPath] of Object.entries(project.outputs || {})) {
    const src = abs(relPath);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(dir, path.basename(src));
    if (path.resolve(src) !== path.resolve(dest)) fs.copyFileSync(src, dest);
    files.push({
      format: fmt,
      file: rel(dest),
      dimensions: ASPECTS[fmt] ? `${ASPECTS[fmt].width}x${ASPECTS[fmt].height}` : null,
      bytes: fs.statSync(dest).size,
    });
  }

  if (includeSubtitles && project.captions?.file && fs.existsSync(abs(project.captions.file))) {
    const dest = path.join(dir, `${slugify(project.title)}.srt`);
    fs.copyFileSync(abs(project.captions.file), dest);
    files.push({ format: 'srt', file: rel(dest), bytes: fs.statSync(dest).size });
  }

  const metadata = project.metadata || buildMetadata(project, brand);
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'publicar.md'), renderPublishSheet(project, metadata, files), 'utf8');

  return { dir: rel(dir), files, platforms: Object.keys(metadata) };
}

/** Hoja de publicacion manual en Markdown: copiar y pegar, sin APIs. */
function renderPublishSheet(project, metadata, files) {
  const lines = [
    `# ${project.title}`,
    '',
    `- Proyecto: \`${project.id}\``,
    `- Marca: ${project.brand}`,
    `- Idioma: ${project.language}`,
    `- Escenas: ${project.scenes?.length || 0}`,
    '',
    '## Archivos',
    '',
    ...files.map((f) => `- **${f.format}** — \`${f.file}\`${f.dimensions ? ` (${f.dimensions})` : ''} — ${(f.bytes / 1e6).toFixed(1)} MB`),
    '',
    '## Metadatos por plataforma',
    '',
    '> Publicacion automatica NO implementada. Sube el archivo manualmente y pega estos textos.',
    '',
  ];

  for (const [platform, m] of Object.entries(metadata)) {
    lines.push(
      `### ${platform}`,
      '',
      `**Titulo**\n\n\`\`\`\n${m.title}\n\`\`\``,
      '',
      `**Descripcion**\n\n\`\`\`\n${m.description}\n\`\`\``,
      '',
      m.warnings?.length ? `> ⚠️ ${m.warnings.join(' / ')}` : '',
      '',
    );
  }
  return lines.filter((l) => l !== undefined).join('\n');
}

/** Formatos que faltan por renderizar segun exportFormats del proyecto. */
export function pendingFormats(project) {
  const want = project.exportFormats?.length ? project.exportFormats : [project.aspectRatio];
  return want.filter((f) => {
    const out = project.outputs?.[f];
    return !out || !fs.existsSync(abs(out));
  });
}
