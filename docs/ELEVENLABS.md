# ElevenLabs en el editor

Esta integración añade síntesis, catálogo de voces de la cuenta y alineación de subtítulos. No activa la cola ni cambia proyectos existentes automáticamente.

## Configuración local

En el `.env` del backend, agregar `ELEVENLABS_API_KEY` e ingresar la clave sólo en ese archivo. No pegarla en chats, Git ni frontend. Reiniciar el servidor. Opcionales: `ELEVENLABS_VOICE_ID` y `ELEVENLABS_MODEL_ID` (predeterminado `eleven_multilingual_v2`). Una clave presente indica configuración, no una llamada validada.

Abrir un proyecto → Audio → Narración → seleccionar una voz con proveedor `elevenlabs`. El selector muestra el nombre; guarda el ID estable. Elegir idioma inglés para RPM-2026-002. El campo Modelo permite usar un ID compatible con la API de timestamps; dejar vacío usa el modelo del backend. «Escuchar muestra de voz» genera hasta 400 caracteres de la primera escena. Consume créditos del servicio. No se hace ninguna llamada de síntesis al seleccionar o guardar una voz.

Escuchar y elegir primero. Exportar regenera la narración del proyecto seleccionado; por eso usar una copia cuando se quiere conservar la versión SAPI. El script siguiente crea una copia editable y una muestra, sin renderizar el curso:

```powershell
node scripts/elevenlabs-preview.mjs <idProyectoOriginal> <idVoz>
```

No modifica el proyecto fuente, sus medios ni la cola. Al exportar la copia, el pipeline recalcula las duraciones con el audio medido. Los clips existentes siguen siendo recursos de video; el renderer repite los cortos para cubrir la nueva duración. No retima automáticamente los momentos internos de una animación GSAP: si una composición necesita que un hito siga una palabra, requiere ajustar y renderizar esa composición.

## Audio, caché y subtítulos

La API devuelve audio y alineación del texto original. Se convierten tiempos por carácter a palabras, se normaliza el WAV sin recortar sus extremos y se generan cues con esos tiempos. Si falta alineación, es inválida o corresponde a un texto diferente, se detiene la generación; no se inventan tiempos.

Caché en `output/drafts/_elevenlabs-cache/`, por texto, ID de voz, modelo y ajustes. Incluye audio y tiempos y se comparte entre muestra y generación. Las solicitudes simultáneas idénticas se agrupan. No hay reintentos automáticos ni sustitución silenciosa por SAPI. `auto` no selecciona ElevenLabs: se elige explícitamente por proyecto.

## Validación

`node --test tests/elevenlabs.test.js` usa API simulada y FFmpeg/ffprobe reales: Unicode, alineación, ausencia de clave, contrato, selección, caché, invalidación por modelo y rechazo de errores. No demuestra pronunciación ni acceso real a la cuenta. La aprobación de la voz se realiza escuchando una muestra real en la instalación de uso.

Documentación oficial consultada el 26-10-2026:
- https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps
- https://elevenlabs.io/docs/api-reference/voices/search

Resultado en este entorno: 64 pruebas dirigidas aprobadas con `--test-concurrency=1` (ElevenLabs, generación, editor, estudio, idiomas, edición de cursos, contrato y tiempos). Pasaron los dos smoke DOM: ElevenLabs y clips/voces existentes. `git diff --check` sin avisos. API ElevenLabs simulada; FFmpeg/ffprobe reales. No hay clave ni proyectos de Katherine en este checkout. No se generó una muestra real de ElevenLabs ni se modificó el curso RPM-2026-002 de su computador.
