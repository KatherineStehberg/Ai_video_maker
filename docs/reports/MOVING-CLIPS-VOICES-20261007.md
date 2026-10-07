# Movimiento real y voces — 7 de octubre de 2026

Base revisada: `feat/personal-video-studio`, commit `24f2825`.
Implementación: `feat/moving-clips-neural-voices`.

## Comportamiento

El generador busca clips Pexels por escena y el editor permite buscarlos,
reproducir una muestra y conservar la selección. Se distingue el movimiento
real del montaje con imágenes. El modo `video-only` detiene la producción si
falta un clip; `prefer-video` permite imágenes con advertencia. El renderer
repite un clip corto hasta cubrir la escena. El audio del material de banco
permanece silenciado tanto en la previsualización como en el montaje.

Se añadió Edge TTS como proveedor opcional, con catálogo consultado, voces en
español e inglés, selección e idioma persistentes, muestra audible y tramos
bilingües. El error de una voz Edge elegida impide declarar éxito silencioso.
El contrato del Orquestador transporta tanto el modo visual como la voz.

## Validación

- 85 pruebas existentes de generación, biblioteca, editor, audio, estudio e
  idioma aprobadas.
- 14 pruebas específicas aprobadas en la ejecución final: selección e importación
  de clips, límites y orígenes de descarga, contrato, rutas HTTP, modo estricto,
  muestras de voz, alternancia bilingüe, persistencia, errores de voz y reproducción.
- La prueba de movimiento genera un MP4 real de un segundo, lo importa por el
  flujo Pexels simulado, verifica su duración con ffprobe, monta una escena de
  tres segundos y verifica frames distintos hasta el final. El clip se repite;
  no se convierte en una imagen fija.
- Las muestras de voz ejecutan Python y FFmpeg reales, con el servicio de voz
  simulado. Se comprueba WAV decodificable, duración y energía audible.
- Smoke DOM aprobado: muestra de clip, atribución, botón de uso, muestra de voz
  y selector. La dependencia de esta prueba vive en `.tmp/dom-tools`.
- Sintaxis de JavaScript/Python y `git diff --check` aprobados.

Comandos reproducibles:

```sh
npm test -- tests/moving-clips.test.js tests/edge-voices.test.js tests/tts-lang.test.js tests/media-library.test.js tests/project-editor.test.js tests/generation.test.js tests/audio.test.js tests/studio.test.js
npm install --no-save --package-lock=false --prefix .tmp/dom-tools linkedom@0.18.12
node scripts/motion-voices-dom-smoke.mjs
```

## Comprobaciones pendientes en la instalación de uso

No había una clave Pexels en este checkout; las pruebas del proveedor usaron
respuestas controladas. La consulta al catálogo Edge TTS en vivo no pudo
completarse desde este entorno. La disponibilidad del servicio y la calidad
perceptual de las voces requieren una prueba en la instalación de uso.

La descarga del navegador de pruebas no produjo un archivo válido, por lo que
no se completó QA en Chrome real. El smoke DOM no valida reproducción nativa,
autoplay ni diseño visual. El movimiento y la duración del MP4 sí se validaron
con FFmpeg y ffprobe.

Los cambios no se han aplicado al computador Windows de Katherine, no se
regeneraron sus proyectos y no se activó ningún servicio de pago. Para voces
Edge se debe instalar `requirements-voices.txt` en el Python elegido y, si hace
falta, configurar `EDGE_TTS_PYTHON`. Pexels usa `PEXELS_API_KEY` en el backend.
