/**
 * Templates de video: definen ritmo, formato y estructura narrativa.
 * `beats` guia al generador de guion (con o sin LLM) y al planificador de escenas.
 */

export const TEMPLATES = {
  'short-educativo': {
    id: 'short-educativo',
    name: 'Short educativo',
    description: 'Explica un concepto en 30-60s, vertical, ritmo alto.',
    aspectRatio: '9:16',
    exportFormats: ['9:16'],
    targetSeconds: [30, 60],
    sceneSeconds: [3, 7],
    maxScenes: 10,
    wpm: 165,
    captions: { enabled: true, burnIn: true, maxCharsPerLine: 26 },
    kenBurns: 'auto',
    transition: 'fade',
    platform: ['youtube', 'tiktok', 'instagram'],
    beats: [
      { role: 'hook', prompt: 'Gancho de 1 frase que genere curiosidad inmediata' },
      { role: 'context', prompt: 'Por que importa este tema' },
      { role: 'point', prompt: 'Idea clave 1' },
      { role: 'point', prompt: 'Idea clave 2' },
      { role: 'point', prompt: 'Idea clave 3' },
      { role: 'cta', prompt: 'Cierre con llamada a la accion' },
    ],
  },

  'reel-promocional': {
    id: 'reel-promocional',
    name: 'Reel promocional',
    description: 'Promociona un producto o servicio en 15-45s, vertical.',
    aspectRatio: '9:16',
    exportFormats: ['9:16'],
    targetSeconds: [15, 45],
    sceneSeconds: [2.5, 5],
    maxScenes: 8,
    wpm: 175,
    captions: { enabled: true, burnIn: true, maxCharsPerLine: 24 },
    kenBurns: 'in',
    transition: 'fade',
    platform: ['instagram', 'tiktok', 'facebook'],
    beats: [
      { role: 'hook', prompt: 'Problema del cliente en 1 frase' },
      { role: 'promise', prompt: 'Que resuelve la oferta' },
      { role: 'proof', prompt: 'Beneficio concreto o prueba' },
      { role: 'offer', prompt: 'La oferta especifica' },
      { role: 'cta', prompt: 'Accion clara e inmediata' },
    ],
  },

  'video-explicativo': {
    id: 'video-explicativo',
    name: 'Video explicativo',
    description: 'Desarrolla un tema en 1-3 minutos, horizontal.',
    aspectRatio: '16:9',
    exportFormats: ['16:9'],
    targetSeconds: [60, 180],
    sceneSeconds: [6, 14],
    maxScenes: 18,
    wpm: 150,
    captions: { enabled: true, burnIn: true, maxCharsPerLine: 42 },
    kenBurns: 'auto',
    transition: 'fade',
    platform: ['youtube', 'linkedin', 'facebook'],
    beats: [
      { role: 'intro', prompt: 'Presenta el tema y que aprendera el espectador' },
      { role: 'context', prompt: 'Contexto necesario' },
      { role: 'point', prompt: 'Desarrollo 1' },
      { role: 'point', prompt: 'Desarrollo 2' },
      { role: 'point', prompt: 'Desarrollo 3' },
      { role: 'example', prompt: 'Ejemplo concreto' },
      { role: 'summary', prompt: 'Resumen de lo aprendido' },
      { role: 'cta', prompt: 'Llamada a la accion' },
    ],
  },

  'video-curso': {
    id: 'video-curso',
    name: 'Video curso / clase',
    description: 'Slides + voz + subtitulos. Ritmo pausado, sin efectos.',
    aspectRatio: '16:9',
    exportFormats: ['16:9'],
    targetSeconds: [120, 600],
    sceneSeconds: [10, 30],
    maxScenes: 40,
    wpm: 140,
    captions: { enabled: true, burnIn: true, maxCharsPerLine: 46 },
    kenBurns: 'none',       // los slides no se mueven: se leen
    transition: 'none',
    platform: ['youtube'],
    beats: [
      { role: 'intro', prompt: 'Objetivo de aprendizaje de la clase' },
      { role: 'agenda', prompt: 'Que se vera, punto por punto' },
      { role: 'point', prompt: 'Contenido 1 explicado en detalle' },
      { role: 'point', prompt: 'Contenido 2 explicado en detalle' },
      { role: 'point', prompt: 'Contenido 3 explicado en detalle' },
      { role: 'practice', prompt: 'Ejercicio o aplicacion practica' },
      { role: 'summary', prompt: 'Cierre y proximos pasos' },
    ],
  },

  'social-multiformat': {
    id: 'social-multiformat',
    name: 'Social multi-formato',
    description: 'Mismo contenido exportado en 16:9, 9:16 y 1:1.',
    aspectRatio: '9:16',
    exportFormats: ['16:9', '9:16', '1:1'],
    targetSeconds: [30, 75],
    sceneSeconds: [4, 8],
    maxScenes: 12,
    wpm: 160,
    // Margen de seguridad: los textos deben caber tambien en 1:1 y 16:9.
    captions: { enabled: true, burnIn: true, maxCharsPerLine: 28 },
    kenBurns: 'auto',
    transition: 'fade',
    platform: ['youtube', 'tiktok', 'instagram', 'facebook', 'linkedin'],
    beats: [
      { role: 'hook', prompt: 'Gancho que funcione en cualquier formato' },
      { role: 'point', prompt: 'Idea principal' },
      { role: 'point', prompt: 'Idea secundaria' },
      { role: 'point', prompt: 'Idea de refuerzo' },
      { role: 'cta', prompt: 'Cierre con CTA' },
    ],
  },
};

export function getTemplate(id) {
  return TEMPLATES[id] || TEMPLATES['short-educativo'];
}

export function listTemplates() {
  return Object.values(TEMPLATES).map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    aspectRatio: t.aspectRatio,
    exportFormats: t.exportFormats,
    targetSeconds: t.targetSeconds,
    maxScenes: t.maxScenes,
    platform: t.platform,
    beats: t.beats.length,
  }));
}
