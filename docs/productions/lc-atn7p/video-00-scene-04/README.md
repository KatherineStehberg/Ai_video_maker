# Video 00 · Escena 04 · Observar, ordenar, probar y medir

Animación didáctica preparada para `Automatiza tu Negocio en 7 Pasos`, Video 00, escena 04 del piloto. Recorre las cuatro acciones de la narración y termina con una práctica breve. No contiene datos personales, precios, pagos, credenciales ni promesas de resultado.

## Fuentes revisadas

- Inventario vigente de Google Drive `1BWr9EmF1SgXUV05PJv-8WOAXVsKIpqXox0B6wQi2WqI`: no registra un video final ni una animación aprobada reutilizable para esta escena.
- Storyboard dinámico del PR `Language-Center-Chile/automatiza-en-pasos#24`, escena 04, duración editorial de 27 segundos.
- Manifiesto ejecutable del PR `Language-Center-Chile/automatiza-en-pasos#25`, que exige un gráfico local para esta escena.
- Generador `lc-course-animations` del PR `KatherineStehberg/Ai_video_maker#4`.

## Archivos

- `spec.json`: contenido editable y duración.
- `animation.html`: salida autocontenida, con pausa, reinicio y búsqueda temporal determinista mediante `window.renderAt(t)`.
- `qa.json`: medidas y hashes del render verificado.

El MP4 de comprobación no se versiona, según la política del repositorio. Se produjo desde `animation.html` con el renderer del paquete.

## Reproducir

```bash
node .agents/skills/lc-course-animations/scripts/build.cjs \
  docs/productions/lc-atn7p/video-00-scene-04/spec.json \
  output/video-00-scene-04/animation.html

node .agents/skills/lc-course-animations/scripts/render.cjs \
  output/video-00-scene-04/animation.html \
  output/video-00-scene-04/render
```

Usar directorios nuevos: los comandos se detienen antes de sobrescribir una salida existente.

## Evidencia

- Cinco capturas revisadas en `0`, `2.7`, `10.8`, `17.55` y `24.3` segundos.
- Sin recortes, superposiciones ni texto en inglés tras la corrección de localización.
- MP4 medido: 1920 × 1080, H.264, `yuv420p`, 24 FPS, 648 cuadros, 27.000 segundos.
- Decodificación completa con FFmpeg: correcta.
- SHA-256 del MP4 de comprobación: `67c4e51f72e5882fd9ec36de93af2eac6bcd99a2ae19e075a63f95aa1d9408d5`.
- Audio: `none`; la narración se mezcla como pista separada durante el montaje del piloto.

## Uso en el piloto

Exportar el MP4 y asignarlo únicamente a la escena 04. No reemplazar automáticamente otros recursos: el generador del PR #2 todavía aplica el modo visual al proyecto completo. Conservar la pista de voz separada y medir de nuevo la sincronía después de la mezcla.

## Decisión pendiente

Katherine debe aprobar o pedir cambios a esta composición y su ritmo de 27 segundos antes de usarla como referencia para la ruta animada de la escena 05.
