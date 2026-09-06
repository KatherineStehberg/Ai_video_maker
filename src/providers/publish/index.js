/**
 * PUBLICACION: SOLO INTERFAZ. NADA IMPLEMENTADO A PROPOSITO.
 *
 * No hay OAuth, no hay tokens, no hay llamadas de red, no se publica nada.
 * Este modulo unicamente:
 *   1. Declara el contrato que implementaran los publishers reales mas adelante.
 *   2. Genera los METADATOS listos para publicar (titulo, descripcion, hashtags),
 *      que el usuario copia y pega manualmente. Eso es 100% gratis y sin riesgo.
 *
 * Cuando se implemente de verdad, cada publisher debera cumplir:
 *   id, label, requiresAuth: true
 *   isConfigured(): boolean
 *   validate(project, file): { ok, errors[] }
 *   publish(project, file, options): Promise<{ url, remoteId }>   // <-- NO IMPLEMENTADO
 */

const LIMITS = {
  youtube: { titleMax: 100, descMax: 5000, hashtags: 15, aspect: ['16:9', '9:16'], maxSeconds: 43200 },
  tiktok: { titleMax: 150, descMax: 2200, hashtags: 8, aspect: ['9:16'], maxSeconds: 600 },
  instagram: { titleMax: 125, descMax: 2200, hashtags: 30, aspect: ['9:16', '1:1', '4:5'], maxSeconds: 90 },
  facebook: { titleMax: 255, descMax: 5000, hashtags: 10, aspect: ['16:9', '9:16', '1:1'], maxSeconds: 7200 },
  linkedin: { titleMax: 150, descMax: 3000, hashtags: 5, aspect: ['16:9', '1:1'], maxSeconds: 600 },
};

export const PLATFORMS = Object.keys(LIMITS);

function makeStub(platform) {
  return {
    id: platform,
    label: platform,
    requiresAuth: true,
    implemented: false,
    limits: LIMITS[platform],
    isConfigured: () => false,
    validate(project, file) {
      const errors = [];
      const lim = LIMITS[platform];
      if (!file) errors.push('Falta el archivo de video');
      if (!lim.aspect.includes(project?.aspectRatio)) {
        errors.push(`${platform}: aspecto ${project?.aspectRatio} no recomendado (usa ${lim.aspect.join(' o ')})`);
      }
      return { ok: errors.length === 0, errors };
    },
    async publish() {
      const err = new Error(
        `Publicacion automatica en ${platform} NO implementada por diseno. ` +
        'Sube el MP4 manualmente usando los metadatos generados.',
      );
      err.code = 'NOT_IMPLEMENTED';
      throw err;
    },
  };
}

export const publishers = Object.fromEntries(PLATFORMS.map((p) => [p, makeStub(p)]));

function truncate(s, max) {
  const t = String(s || '').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

function hashtagsFor(project, brand, max) {
  const base = [
    ...(brand?.hashtags || []),
    ...String(project?.title || '').split(/\s+/).filter((w) => w.length > 4),
  ];
  const seen = new Set();
  const out = [];
  for (const raw of base) {
    const tag = String(raw).replace(/^#/, '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9]/g, '');
    if (!tag || tag.length < 3) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`#${tag}`);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Genera los metadatos de publicacion para cada plataforma del proyecto.
 * No contacta ningun servicio: es texto generado localmente.
 */
export function buildMetadata(project, brand = {}) {
  const platforms = project.platform?.length ? project.platform : ['youtube'];
  const scriptText = project.scenes?.map((s) => s.text).filter(Boolean).join(' ') || project.script || '';
  const summary = scriptText.slice(0, 400);
  const cta = project.cta || brand.cta || '';
  const urls = Object.entries(brand.urls || {}).map(([k, v]) => `${k}: ${v}`);

  const out = {};
  for (const p of platforms) {
    const lim = LIMITS[p];
    if (!lim) continue;
    const tags = hashtagsFor(project, brand, lim.hashtags);
    const descParts = [summary, cta, urls.join('\n'), tags.join(' ')].filter(Boolean);
    out[p] = {
      platform: p,
      title: truncate(project.title, lim.titleMax),
      description: truncate(descParts.join('\n\n'), lim.descMax),
      hashtags: tags,
      language: project.language,
      recommendedAspect: lim.aspect,
      warnings: lim.aspect.includes(project.aspectRatio)
        ? []
        : [`Aspecto ${project.aspectRatio} no ideal para ${p}: exporta ${lim.aspect.join(' o ')}`],
      status: 'ready_for_manual_upload',
      autoPublish: false,
    };
  }
  return out;
}
