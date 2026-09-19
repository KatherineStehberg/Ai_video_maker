# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Las fechas son de desarrollo local; nada de esto se ha publicado todavía.

## [Sin publicar] — rama `feat/personal-video-studio`

### Añadido — Editor web (2026-09-18)

- **Frontend del editor** en `/editor.html`, que cubre el flujo completo desde
  el navegador sin `curl` ni scripts. Fondo claro, azul `#003366`, azul
  eléctrico para acciones, tarjetas redondeadas, panel lateral de configuración
  y timeline central. Responsive verificado a 420 px, sin scroll horizontal.
- **Arquitectura modular sin dependencias** en `src/ui/editor/`:
  `api.js` (cliente con `fetch` inyectable), `state.js` (máquina de estados
  pura), `format.js` (derivaciones de la vista), `timeline.js`, `player.js`,
  `messages.js` y `main.js` (orquestación). Los tres primeros no tocan el DOM y
  se testean en Node.
- **Diez estados visibles** (listo, cargando, analizando, análisis completado,
  creando propuesta, aprobación pendiente, aprobado, exportando, exportado,
  error) con una única regla de habilitación de la exportación y el motivo del
  bloqueo siempre a la vista.
- **Sondeo del análisis** sin solapar peticiones, cancelable al cambiar de
  archivo, y bloqueo del botón durante la exportación para impedir dos
  exportaciones simultáneas.
- **Advertencias de sincronía visibles**: el aviso de `atempo` se muestra tal
  cual lo envía el backend; la interfaz nunca afirma que los beats originales se
  conserven.
- `scripts/editor-smoke.mjs`: smoke test del flujo completo en Chrome real.
- `tests/ui.test.js`: 7 tests que cubren los 14 casos pedidos.
- `DEPLOY.md`: configuración preparada y bloqueadores reales para el deploy.

### Corregido

- `video { display: block }` anulaba el atributo `hidden` de los reproductores,
  que aparecían como cajas negras vacías. Restablecido con `[hidden]`.
- La página pedía `/favicon.ico` y recibía un 404; ahora lleva un favicon SVG
  embebido. El smoke test falla si aparece cualquier respuesta HTTP ≥ 400.
- Concordancia de plural en el mensaje de sincronía («Sólo 1 corte visual»).

### Añadido — Propuesta de edición y exportación (2026-09-18)

- **Módulo de edición** (`src/edits/`), independiente del análisis:
  - `schema.js`: esquema de la propuesta, contrato documentado de transformación
    temporal y validación de segmentos (orden, solapamiento, límites de `atempo`,
    coherencia `speed = 1/setptsFactor`, contigüidad de la línea de salida).
  - `plan.js`: construye la propuesta a partir de un análisis ya medido. No
    ejecuta FFmpeg ni contacta servicios externos.
  - `export.js`: exportación real con FFmpeg (`trim`/`setpts` + `atrim`/`atempo`,
    `concat`, encuadre y CFR), con verificación posterior por `ffprobe`.
  - `routes.js`: `POST /api/video-edits`, `GET /api/video-edits/:id`,
    `POST /api/video-edits/:id/approve`, `POST /api/video-edits/:id/export`,
    `GET /api/video-edits/:id/file`.
- **Aprobación humana obligatoria** antes de exportar cuando `approvalRequired`
  es `true`; `403` en caso contrario.
- **Formatos 16:9, 9:16, 1:1 y 4:5**, con encuadre `pad` (por defecto, no
  descarta contenido) o `crop`.
- `syncStatus` pasa a `validado` **sólo** cuando la duración medida con `ffprobe`
  confirma la estimada; si no, se deja `propuesto` con la desviación registrada.
- `scripts/edit-demo.mjs`: demostración reproducible de extremo a extremo
  (fixture → análisis → propuesta → aprobación → exportación → `ffprobe`).
- Documentación: `docs/API.md`, `COST_STRATEGY.md`, `docs/examples/*.json`,
  este changelog.
- 10 tests nuevos en `tests/edits.test.js`, incluidas dos exportaciones reales.

### Añadido — Frames, beats y rampas (2026-09-18)

- **Módulo de ritmo** (`src/analysis/beats.js`): inferencia de rejilla isócrona
  por fuerza vectorial × respaldo (evita el error de octava), patrón de sincronía
  cortes↔beats y propuestas de rampas de velocidad.
- **Frames en todos los eventos**: `frame` derivado del FPS promedio y
  `frameExact`, más `metadata.frameRateMode` (`cfr`/`vfr`/`unknown`),
  `metadata.codec` y `metadata.nbFrames`.
- Interfaz: secciones «Ritmo y sincronía» y «Rampas de velocidad sugeridas»;
  columna de frames en la tabla de cortes y en el CSV exportado.
- 4 tests nuevos, incluido uno de escala (1 hora de material, 7200 onsets).

### Corregido

- `scorePeriod` y `buildBeats` eran O(líneas × onsets), inviable en material
  largo. Reescritos con dos punteros: 1 hora de audio pasa de no terminar a
  **198 ms**. La rejilla se trunca a 20 000 beats y se deja anotado.
- `speed` y `setptsFactor` se redondeaban por separado, de modo que la invariante
  `speed = 1/setptsFactor` sólo se cumplía dentro de una tolerancia.
  `setptsFactor` pasa a ser el valor canónico y `speed` se deriva de él.

### Sin cambios deliberados

- No se ha tocado el pipeline de creación desde guiones ni el estudio.
- No se ha implementado publicación en redes sociales.
- La integración con el Orquestador KSL sigue siendo sólo un contrato pendiente
  de documentar, sin código.
