# Validación para Joseph — 2026-10-13

Repositorio: https://github.com/KatherineStehberg/Ai_video_maker
Rama: `feat/personal-video-studio`. Estado inicial limpio, HEAD `24f2825`.
Después de fetch, comparación con origin: 0 commits exclusivos de cada lado.
No se encontró AGENTS.md en el repositorio ni en el directorio Documents.
Las instrucciones aplicadas fueron README, package.json y los scripts existentes.
Git requirió ejecución con el usuario propietario para escribir en `.git`;
no se cambió `safe.directory` global. No hubo integración divergente ni merge.

## Cambios

- El lanzador enumera explícitamente `tests/*.test.js`: Node 22 interpretaba
  `tests/` como un módulo y `npm test` terminaba sin ejecutar las pruebas.
- El smoke de exportación respeta `AIVM_OUTPUT_DIR`, selecciona voz local,
  exige pistas de video/audio mediante ffprobe y mide volumen con FFmpeg.
  Compara duración con la línea de tiempo posterior a sintetizar la voz, cuya
  duración sustituye la estimación previa.
- Smoke separado de movimiento: render real de un clip sintético, persistencia
  del recurso, comparación de frames y hash del original.
- Lockfile versionado para `npm ci`, guía Windows y configuración de ejemplo
  corregida: pipeline es el proveedor predeterminado, no mock.

## Pruebas realizadas

Windows 10 x64 19045, Node 22.21.1, npm 10.9.4, FFmpeg 6.1.1 y ffprobe 4.0.2.
Dependencias presentes: ffmpeg-static 5.3.0, ffprobe-static 3.1.0.

| Comprobación | Resultado |
| --- | --- |
| `npm.cmd ci --prefix .tmp/joseph-install --no-audit --no-fund` | Instalación limpia: 21 paquetes; ambos ejecutables presentes y versiones comprobadas. Bajo sandbox se omitía FFmpeg; repetido con acceso de red correcto |
| `npm.cmd test` | 226 aprobadas, 0 fallidas, 0 omitidas; 248,8 s |
| `npm.cmd run doctor` con usuario Windows | FFmpeg/ffprobe disponibles; SAPI con Zira, Helena y Sabina; Piper no disponible |
| `node scripts/editor-visual-smoke.mjs` | Navegador real: edición de narración, rótulo, subtítulos, volumen, guardado, reapertura y disco; cero errores de página |
| `node scripts/editor-audio-smoke.mjs` | Play RMS 0,0188; volumen 25 % RMS 0,0047; mute RMS 0; MP4 decodifica audio; pausa y cambio de escena correctos |
| `node scripts/editor-efectos-smoke.mjs` | Biblioteca de 6 efectos con licencia; selección, guardado, recarga y timeline correctos |
| `node scripts/editor-export-smoke.mjs` | Proyecto independiente con voz española: MP4 7,17 s, 0,22 MB, pico -2,8 dBFS; video y audio presentes; subtítulo editado, rótulo persistido y escena excluida ausente del ASS |
| `node scripts/motion-smoke.mjs` | Clip de 3 s; diferencia media RGB entre frames 19,25; original intacto |
| `npm.cmd run courses:check` con usuario Windows | 15 guiones, 96 escenas; estado existente con 15 review_ready, 0 pending, 0 blocked; preflight correcto con voz inglesa Zira |
| `node --check` de scripts modificados y registro de proveedores | Correcto |

No hay scripts lint ni build. La suite incluye exportaciones reales, mezcla de
voz y música, efectos en su segundo, subtítulos, rótulos, transiciones,
persistencia, contratos HTTP, pipeline local y producción de cursos.

Las pruebas del editor se ejecutaron con proyectos/output/jobs bajo `.tmp/joseph-*`
y la cola desactivada. `npm test` mantiene su aislamiento en `.tmp/test-data`.
Los smokes de navegador arrancan el servidor local real en un puerto libre y lo
cierran al terminar. No se han borrado ni renderizado los cursos existentes.
Los resultados y medios de prueba permanecen ignorados en `.tmp/`.

## Implementación y límites reales

- Editor con pistas derivadas de las escenas, persistencia local, subtítulos,
  rótulos, audio y biblioteca de efectos comprobados por pruebas. Arrastrar clips
  libremente y dividir escenas siguen declarados pendientes en el backend.
  No equivale a un editor multipista con todas las operaciones de un NLE.
- Clips de video propios conservan movimiento. Pipeline monta visuales locales,
  narración y subtítulos; mock solo produce un fixture de desarrollo.
- Video generativo `api` y `local`: no implementados. No se ha generado video
  mediante un servicio/modelo generativo real en esta entrega.
- Gemini, Pexels y LLM compatibles: integración/capacidad de configuración,
  sin llamada externa real comprobada aquí. No se consumieron créditos.
  Ollama y Piper no disponibles en el diagnóstico de este equipo.
- Whisper/modelos no se han probado mediante una transcripción real en esta
  entrega. Se verificó el modo de subtítulos estimados.
- El doctor informa capacidades aproximadas: no acredita cada proveedor.
  Bajo el usuario aislado no se detectaban voces; con el usuario Windows sí.
- `.env` local contiene una ruta FFmpeg inexistente; se conserva sin modificar
  y funciona el fallback npm. Joseph debe configurar rutas válidas o dejar las
  variables comentadas. No se copiaron valores privados a documentación.
- Los 15 cursos están registrados para revisión con archivos presentes según
  el verificador; esta entrega no hizo una revisión editorial ni decodificó
  nuevamente cada curso. Copiar los medios y el estado aparte de Git.

Guía: [INSTALACION_JOSEPH_WINDOWS.md](../INSTALACION_JOSEPH_WINDOWS.md).
